import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { proposeFlagGraduations } from "../src/halyard/coordinator/graduation.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-grad-"));
  backend = makeGitBackend({ stateDir });
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** Seed a release that went live at `liveAt`, bound to a launch flag. */
function seedLiveRelease(liveAt: string): void {
  const launch = newLaunch({
    app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "n",
    announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
    createdBy: "alex", createdAt: "2025-01-01T00:00:00.000Z",
  });
  let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
  r = bindReleaseToLaunch(r, launch);
  // Walk to live; the `live` transition carries the timestamp graduation measures from.
  const path: [string, string][] = [
    ["tagged", "2025-01-02T00:00:00.000Z"],
    ["built", "2025-01-02T00:01:00.000Z"],
    ["tested", "2025-01-02T00:02:00.000Z"],
    ["uploaded", "2025-01-02T00:03:00.000Z"],
    ["in_review", "2025-01-03T00:00:00.000Z"],
    ["shipped_dark", "2025-01-04T00:00:00.000Z"],
    ["live", liveAt],
  ];
  for (const [to, at] of path) r = appendTransition(r, to as never, "test", () => at);
  writeRelease(stateDir, r);
}

const thresholds = { aurora: 30 };

describe("M4 verify: a stale flag surfaces a removal proposal", () => {
  it("proposes removal once the flag has been live past the graduation window", async () => {
    seedLiveRelease("2025-05-01T00:00:00.000Z");
    // 'now' is 45 days after going live → past the 30-day window.
    const created = await proposeFlagGraduations({
      backend,
      now: () => "2025-06-15T00:00:00.000Z",
      thresholdDaysByApp: thresholds,
    });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: "flag_removal",
      flag: "launch.aurora.offline_sync",
      status: "open",
    });
    expect(listProposals(stateDir)).toHaveLength(1);
  });

  it("does not propose while still inside the window", async () => {
    seedLiveRelease("2025-06-01T00:00:00.000Z");
    const created = await proposeFlagGraduations({
      backend,
      now: () => "2025-06-10T00:00:00.000Z", // only 9 days live
      thresholdDaysByApp: thresholds,
    });
    expect(created).toHaveLength(0);
    expect(listProposals(stateDir)).toHaveLength(0);
  });

  it("is idempotent — a second pass does not duplicate the proposal", async () => {
    seedLiveRelease("2025-05-01T00:00:00.000Z");
    const opts = { backend, now: () => "2025-06-15T00:00:00.000Z", thresholdDaysByApp: thresholds };
    expect(await proposeFlagGraduations(opts)).toHaveLength(1);
    expect(await proposeFlagGraduations(opts)).toHaveLength(0); // already enqueued
    expect(listProposals(stateDir)).toHaveLength(1);
  });
});

describe("§D: graduation only graduates launch flags, not operational ones", () => {
  /** Seed a long-live release carrying `flag`. */
  function seedWithFlag(flag: string): void {
    let r = newRelease({ releaseId: "rel_aurora_ios_2.0.0", app: "aurora", surface: "ios", version: "2.0.0" });
    r = { ...r, flag, launch_id: "lnch_aurora_x" };
    for (const [to, at] of [
      ["tagged", "2025-01-02T00:00:00.000Z"],
      ["built", "2025-01-02T00:01:00.000Z"],
      ["tested", "2025-01-02T00:02:00.000Z"],
      ["uploaded", "2025-01-02T00:03:00.000Z"],
      ["in_review", "2025-01-03T00:00:00.000Z"],
      ["shipped_dark", "2025-01-04T00:00:00.000Z"],
      ["live", "2025-01-05T00:00:00.000Z"],
    ] as [string, string][]) {
      r = appendTransition(r, to as never, "test", () => at);
    }
    writeRelease(stateDir, r);
  }

  const opts = {
    now: () => "2025-06-15T00:00:00.000Z", // long past the window
    thresholdDaysByApp: thresholds,
    launchFlagPrefixByApp: { aurora: "launch." },
  };

  it("skips a permanent operational flag (does not match the launch prefix)", async () => {
    seedWithFlag("region.eu");
    expect(await proposeFlagGraduations({ ...opts, backend })).toHaveLength(0);
  });

  it("still proposes for a launch flag matching the prefix", async () => {
    seedWithFlag("launch.aurora.dark_mode");
    expect(await proposeFlagGraduations({ ...opts, backend })).toHaveLength(1);
  });
});

describe("reserved auto-promote namespace", () => {
  it("does NOT propose removing a reserved auto-promote flag, even past the window", async () => {
    const { makeGitBackend } = await import("../src/halyard/coordinator/git-backend.js");
    const backend = makeGitBackend({ stateDir });
    let r = newRelease({ releaseId: "rel_acme_web_1.4.0", app: "acme", surface: "web", version: "1.4.0" });
    r = { ...r, flag: "halyard.autopromote.acme.1.4.0" };
    for (const [to, at] of [
      ["tagged", "2025-01-02T00:00:00.000Z"], ["built", "2025-01-02T00:01:00.000Z"],
      ["tested", "2025-01-02T00:02:00.000Z"], ["uploaded", "2025-01-02T00:03:00.000Z"],
      ["live", "2025-01-05T00:00:00.000Z"],
    ] as [string, string][]) r = appendTransition(r, to as never, "test", () => at);
    await backend.records.write(r);

    const created = await proposeFlagGraduations({
      backend,
      now: () => "2025-06-15T00:00:00.000Z", // long past any window
      thresholdDaysByApp: { acme: 14 },
      launchFlagPrefixByApp: { acme: "halyard." }, // even with a matching prefix, reserved flags are exempt
    });
    expect(created).toHaveLength(0);
  });
});
