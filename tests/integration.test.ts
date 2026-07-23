import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { reconcile, type ReconcileSource } from "../src/halyard/coordinator/reconcile.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { bindReleaseToLaunch, linkRelease, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { ascReviewSource, type AscClient, type ReviewStatus } from "../src/halyard/coordinator/sources/asc-review.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-int-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** Seed a flag-linked release parked at shipped_dark. */
function seedShippedDark(id: string, app: string, flag: string): void {
  const launch = newLaunch({
    app, feature: "f", title: "T", narrativeSeed: "n", announcePolicy: "per_surface",
    tier: "standard", flag, createdBy: "t", createdAt: now(),
  });
  let r = bindReleaseToLaunch(newRelease({ releaseId: id, app, surface: "ios", version: "1.0.0" }), launch);
  for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"] as const) {
    r = appendTransition(r, to, "ci", now);
  }
  writeRelease(stateDir, r);
  writeLaunch(stateDir, linkRelease(launch, id));
}

describe("reconcile: cross-record error isolation", () => {
  it("a source error on one release does not block transitions on others in the same sweep", async () => {
    for (const id of ["rel_a_ios_1.0.0", "rel_b_ios_1.0.0"]) {
      writeRelease(stateDir, appendTransition(
        appendTransition(appendTransition(appendTransition(
          newRelease({ releaseId: id, app: id.includes("_a_") ? "a" : "b", surface: "ios", version: "1.0.0" }),
          "tagged", "ci", now), "built", "ci", now), "tested", "ci", now), "uploaded", "ci", now));
    }
    const flaky: ReconcileSource = {
      name: "flaky",
      appliesTo: (r) => r.state === "uploaded",
      poll: async (r) => {
        if (r.release_id === "rel_a_ios_1.0.0") throw new Error("boom");
        return [{ to: "in_review", by: "flaky" }];
      },
    };

    const report = await reconcile({ backend, sources: [flaky], now });

    expect(readRelease(stateDir, "rel_a_ios_1.0.0")!.state).toBe("uploaded"); // errored → untouched
    expect(readRelease(stateDir, "rel_b_ios_1.0.0")!.state).toBe("in_review"); // still advanced + persisted
    expect(report.errors).toHaveLength(1);
    expect(report.applied).toHaveLength(1);
  });
});

describe("reconcile: double rollback through the flag poll", () => {
  it("flip on/off/on/off projects live, rolled_back, live#2, rolled_back#2", async () => {
    const flag = "launch.a.f";
    seedShippedDark("rel_a_ios_1.0.0", "a", flag);
    const client = new FlagFileClient(stateDir, now);
    const sources = [flagPollSource(client)];

    for (const state of [true, false, true, false]) {
      await client.setState(flag, state);
      await reconcile({ backend, sources, now });
    }

    const r = readRelease(stateDir, "rel_a_ios_1.0.0")!;
    expect(r.state).toBe("rolled_back");
    expect(r.transitions.filter((t) => t.to === "live").map((t) => t.dedup_key)).toEqual([
      "rel_a_ios_1.0.0:live", "rel_a_ios_1.0.0:live#2",
    ]);
    expect(r.transitions.filter((t) => t.to === "rolled_back").map((t) => t.dedup_key)).toEqual([
      "rel_a_ios_1.0.0:rolled_back", "rel_a_ios_1.0.0:rolled_back#2",
    ]);
  });
});

describe("reconcile: idempotent over a duplicate pass", () => {
  it("two passes over the same stable external truth apply exactly one transition", async () => {
    writeRelease(stateDir, appendTransition(
      appendTransition(appendTransition(appendTransition(
        newRelease({ releaseId: "rel_a_ios_1.0.0", app: "a", surface: "ios", version: "1.0.0" }),
        "tagged", "ci", now), "built", "ci", now), "tested", "ci", now), "uploaded", "ci", now));
    const approved: AscClient = { async getReviewStatus(): Promise<ReviewStatus> { return "approved"; } };
    const sources = [ascReviewSource(approved)];

    const first = await reconcile({ backend, sources, now });
    const second = await reconcile({ backend, sources, now });

    expect(first.applied).toHaveLength(1); // uploaded → shipped_dark
    expect(second.applied).toHaveLength(0); // stable truth → nothing new
    expect(readRelease(stateDir, "rel_a_ios_1.0.0")!.transitions.filter((t) => t.to === "shipped_dark")).toHaveLength(1);
  });
});

describe("reconcile: multi-app coordination in one sweep", () => {
  it("advances releases for different apps independently", async () => {
    seedShippedDark("rel_alpha_ios_1.0.0", "alpha", "launch.alpha.f");
    seedShippedDark("rel_beta_ios_1.0.0", "beta", "launch.beta.f");
    const client = new FlagFileClient(stateDir, now);
    await client.setState("launch.alpha.f", true);
    await client.setState("launch.beta.f", true);

    await reconcile({ backend, sources: [flagPollSource(client)], now });

    expect(readRelease(stateDir, "rel_alpha_ios_1.0.0")!.state).toBe("live");
    expect(readRelease(stateDir, "rel_beta_ios_1.0.0")!.state).toBe("live");
  });
});
