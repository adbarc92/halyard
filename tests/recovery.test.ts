import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { reconcile, type ReconcileSource, type TransitionProposal } from "../src/halyard/coordinator/reconcile.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";
import type { ReleaseState } from "../src/halyard/contracts/state.js";

/**
 * Recovery from failed transitions — the headline resilience claim, demonstrated end-to-end
 * through the reconcile engine.
 *
 * A transition can fail three ways; none of them may strand or corrupt a release:
 *   1. the external poller throws (expired creds / provider 5xx),
 *   2. an illegal transition is proposed (a bug or an out-of-order event),
 *   3. a step's own action fails mid-release (covered fully in deploy-failure.test.ts:
 *      a failed upload leaves the record at `tested` and a re-run resumes it to `uploaded`).
 *
 * In every case the record stays at its last good state and reaches its real target on a
 * later pass — idempotently, with no duplicate transitions.
 */

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-07-10T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-recovery-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

function seed(id: string, walkTo: ReleaseState[]): Release {
  let r = newRelease({ releaseId: id, app: "aurora", surface: "web", version: "1.0.0" });
  for (const to of walkTo) r = appendTransition(r, to, "ci", now);
  writeRelease(stateDir, r);
  return r;
}

describe("recovery from failed transitions", () => {
  it("a poller that fails on one pass recovers on the next — the release still reaches its target, once", async () => {
    const id = "rel_aurora_web_1.0.0";
    seed(id, ["tagged", "built", "tested", "uploaded"]);

    // The same source fails the first time it is polled, then reports real truth thereafter.
    let polls = 0;
    const flakeThenTruth: ReconcileSource = {
      name: "asc-review",
      appliesTo: () => true,
      poll: async (): Promise<TransitionProposal[]> => {
        polls++;
        if (polls === 1) throw new Error("provider 5xx");
        return [{ to: "shipped_dark", by: "asc-review" }];
      },
    };

    // Pass 1: the poller throws. The failure is recorded, the sweep survives, the record is untouched.
    const pass1 = await reconcile({ backend, sources: [flakeThenTruth], now });
    expect(pass1.errors).toHaveLength(1);
    expect(pass1.errors[0]).toMatchObject({ release_id: id, source: "asc-review" });
    expect(pass1.applied).toHaveLength(0);
    expect(readRelease(stateDir, id)!.state).toBe("uploaded"); // last good state — not corrupted

    // Pass 2: the source has recovered. The delta now applies.
    const pass2 = await reconcile({ backend, sources: [flakeThenTruth], now });
    expect(pass2.errors).toHaveLength(0);
    expect(pass2.applied).toMatchObject([{ to: "shipped_dark" }]);
    expect(readRelease(stateDir, id)!.state).toBe("shipped_dark");

    // Pass 3: stable truth → nothing new. Recovery did not double-apply.
    const pass3 = await reconcile({ backend, sources: [flakeThenTruth], now });
    expect(pass3.applied).toHaveLength(0);
    const rec = readRelease(stateDir, id)!;
    expect(rec.transitions.filter((t) => t.to === "shipped_dark")).toHaveLength(1);
  });

  it("an illegal transition is rejected without corrupting the record, which still advances legally", async () => {
    const id = "rel_aurora_web_2.0.0";
    seed(id, ["tagged", "built", "tested"]);
    const transitionsBefore = readRelease(stateDir, id)!.transitions.length;

    // A misbehaving source proposes an impossible jump (`tested → live` skips the whole middle).
    let proposal: TransitionProposal = { to: "live", by: "bug" };
    const source: ReconcileSource = {
      name: "buggy",
      appliesTo: () => true,
      poll: async () => [proposal],
    };

    const bad = await reconcile({ backend, sources: [source], now });
    expect(bad.applied).toHaveLength(0);
    expect(bad.skipped[0]).toMatchObject({ reason: "illegal", to: "live" });
    const afterBad = readRelease(stateDir, id)!;
    expect(afterBad.state).toBe("tested"); // untouched
    expect(afterBad.transitions).toHaveLength(transitionsBefore); // nothing written

    // The record is not poisoned: the correct next transition still applies.
    proposal = { to: "uploaded", by: "ci" };
    const good = await reconcile({ backend, sources: [source], now });
    expect(good.applied).toMatchObject([{ to: "uploaded" }]);
    expect(readRelease(stateDir, id)!.state).toBe("uploaded");
  });
});
