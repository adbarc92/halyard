import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  reconcile,
  type ReconcileSource,
  type TransitionProposal,
} from "../src/halyard/coordinator/reconcile.js";
import {
  appendTransition,
  newRelease,
  readRelease,
  writeRelease,
} from "../src/halyard/coordinator/record-store.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";
import type { ReleaseState } from "../src/halyard/contracts/state.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T02:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-reconcile-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** Seed a record sitting at `state` (by walking a legal path) and persist it. */
function seed(id: string, version: string, walkTo: ReleaseState[]): Release {
  let r = newRelease({ releaseId: id, app: "aurora", surface: "web", version });
  for (const to of walkTo) r = appendTransition(r, to, "ci", now);
  writeRelease(stateDir, r);
  return r;
}

/**
 * A synthetic external poller modeling exactly how M3's ASC review poll will behave:
 * it reports the world's current truth as a target state. Stable truth across passes is
 * what makes idempotency observable.
 */
function fixedTruthSource(truth: Record<string, TransitionProposal>): ReconcileSource {
  return {
    name: "synthetic-truth",
    appliesTo: (r) => truth[r.release_id] !== undefined,
    poll: async (r) => {
      const p = truth[r.release_id];
      return p ? [p] : [];
    },
  };
}

describe("M2 verify: running reconcile twice produces zero duplicate transitions", () => {
  it("applies a delta once, then is a clean no-op", async () => {
    seed("rel_aurora_web_1.0.0", "1.0.0", ["tagged", "built", "tested", "uploaded", "in_review"]);
    const source = fixedTruthSource({
      "rel_aurora_web_1.0.0": { to: "shipped_dark", by: "asc-poll", externalRefs: { review_status: "approved" } },
    });

    const first = await reconcile({ backend, sources: [source], now });
    expect(first.applied).toHaveLength(1);
    expect(first.applied[0]).toMatchObject({ to: "shipped_dark", source: "synthetic-truth" });

    const afterFirst = readRelease(stateDir, "rel_aurora_web_1.0.0")!;
    expect(afterFirst.state).toBe("shipped_dark");
    const transitionsAfterFirst = afterFirst.transitions.length;

    // Second pass: same external truth → nothing new.
    const second = await reconcile({ backend, sources: [source], now });
    expect(second.applied).toHaveLength(0);
    expect(second.skipped.every((s) => s.reason === "duplicate")).toBe(true);

    const afterSecond = readRelease(stateDir, "rel_aurora_web_1.0.0")!;
    expect(afterSecond.transitions).toHaveLength(transitionsAfterFirst);
    // And byte-identical: a clean pass writes nothing new.
    expect(afterSecond).toEqual(afterFirst);
  });

  it("is idempotent across many passes and many records", async () => {
    seed("rel_aurora_web_1.0.0", "1.0.0", ["tagged", "built", "tested", "uploaded", "in_review"]);
    seed("rel_aurora_web_1.0.1", "1.0.1", ["tagged", "built", "tested", "uploaded"]);
    const source = fixedTruthSource({
      "rel_aurora_web_1.0.0": { to: "shipped_dark", by: "asc-poll" },
      "rel_aurora_web_1.0.1": { to: "in_review", by: "asc-poll" },
    });

    let totalApplied = 0;
    for (let i = 0; i < 5; i++) {
      const r = await reconcile({ backend, sources: [source], now });
      totalApplied += r.applied.length;
    }
    // Two deltas total, applied exactly once each across five passes.
    expect(totalApplied).toBe(2);
  });

  it("rejects an illegal proposal without writing it", async () => {
    seed("rel_aurora_web_2.0.0", "2.0.0", ["tagged"]);
    const source = fixedTruthSource({
      "rel_aurora_web_2.0.0": { to: "live", by: "bogus" }, // tagged → live is illegal
    });

    const report = await reconcile({ backend, sources: [source], now });
    expect(report.applied).toHaveLength(0);
    expect(report.skipped[0]).toMatchObject({ reason: "illegal", to: "live" });

    const rec = readRelease(stateDir, "rel_aurora_web_2.0.0")!;
    expect(rec.state).toBe("tagged");
    expect(rec.transitions).toHaveLength(1);
  });

  it("merges external_refs idempotently (stable truth → no rewrite)", async () => {
    seed("rel_aurora_web_3.0.0", "3.0.0", ["tagged", "built", "tested", "uploaded", "in_review"]);
    const source = fixedTruthSource({
      "rel_aurora_web_3.0.0": {
        to: "in_review", // same state → duplicate transition, but refs still merge
        by: "asc-poll",
        externalRefs: { asc_build_id: "9001", review_status: "in_review" },
      },
    });

    const first = await reconcile({ backend, sources: [source], now });
    expect(first.applied).toHaveLength(0); // no transition, just a ref merge on pass 1
    const afterFirst = readRelease(stateDir, "rel_aurora_web_3.0.0")!;
    expect(afterFirst.external_refs.asc_build_id).toBe("9001");

    const afterSecond = await reconcile({ backend, sources: [source], now }).then(
      () => readRelease(stateDir, "rel_aurora_web_3.0.0")!,
    );
    expect(afterSecond).toEqual(afterFirst); // stable: no further change
  });

  it("isolates a throwing source: the sweep continues and the error is reported", async () => {
    seed("rel_aurora_web_4.0.0", "4.0.0", ["tagged", "built", "tested", "uploaded", "in_review"]);

    // A poller that always throws (expired creds / ASC 5xx) ...
    const flaky: ReconcileSource = {
      name: "flaky-source",
      appliesTo: () => true,
      poll: async () => {
        throw new Error("boom: provider unavailable");
      },
    };
    // ... must not stop a healthy source from applying its delta.
    const healthy = fixedTruthSource({
      "rel_aurora_web_4.0.0": { to: "shipped_dark", by: "asc-poll" },
    });

    const report = await reconcile({ backend, sources: [flaky, healthy], now });

    // The healthy source still applied.
    expect(report.applied).toMatchObject([{ to: "shipped_dark", source: "synthetic-truth" }]);
    expect(readRelease(stateDir, "rel_aurora_web_4.0.0")!.state).toBe("shipped_dark");

    // The failure is captured, not swallowed and not fatal.
    expect(report.errors).toHaveLength(1);
    expect(report.errors[0]).toMatchObject({
      release_id: "rel_aurora_web_4.0.0",
      source: "flaky-source",
    });
    expect(report.errors[0]!.message).toContain("boom");
  });
});
