import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T07:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m4-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** A launch with its flag born OFF, and an iOS release parked at shipped_dark, bound to it. */
async function setup(): Promise<{ flag: string; client: FlagFileClient }> {
  const flag = "launch.aurora.offline_sync";
  const launch = newLaunch({
    app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
    announcePolicy: "per_surface", tier: "standard", flag, createdBy: "alex", createdAt: now(),
  });
  writeLaunch(stateDir, launch);

  const client = new FlagFileClient(stateDir, now);
  await client.ensureFlag(flag); // born OFF

  let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
  r = bindReleaseToLaunch(r, launch);
  for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"] as const) {
    r = appendTransition(r, to, "ci", now);
  }
  writeRelease(stateDir, r);
  return { flag, client };
}

describe("M4 verify: flipping a flag moves a record to live", () => {
  it("waits at shipped_dark while OFF, goes live when flipped ON", async () => {
    const { flag, client } = await setup();
    const sources = [flagPollSource(client)];

    // Flag OFF → reconcile is a no-op; the build waits dark.
    const before = await reconcile({ backend, sources, now });
    expect(before.applied).toHaveLength(0);
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.state).toBe("shipped_dark");

    // The human flips the flag ON (the launch moment).
    await client.setState(flag, true);

    const after = await reconcile({ backend, sources, now });
    expect(after.applied).toMatchObject([{ to: "live", by: "flag-poll" }]);

    const record = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;
    expect(record.state).toBe("live");
    expect(record.external_refs.flag_state).toBe("on");
    // The flip is what moved it — recorded by the poll, off the back of a human action.
    expect(record.transitions.at(-1)).toMatchObject({ to: "live", by: "flag-poll" });
  });

  it("rollback: flipping the flag back OFF moves live → rolled_back", async () => {
    const { flag, client } = await setup();
    const sources = [flagPollSource(client)];

    await client.setState(flag, true);
    await reconcile({ backend, sources, now }); // → live
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.state).toBe("live");

    await client.setState(flag, false); // flip OFF = the only mobile rollback
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.state).toBe("rolled_back");
  });

  it("is idempotent: re-reconciling a live release with the flag ON does nothing", async () => {
    const { flag, client } = await setup();
    const sources = [flagPollSource(client)];
    await client.setState(flag, true);
    await reconcile({ backend, sources, now }); // → live
    const live = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;
    const report = await reconcile({ backend, sources, now });
    expect(report.applied).toHaveLength(0);
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!).toEqual(live);
  });
});
