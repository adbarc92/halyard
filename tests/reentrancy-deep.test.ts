import { describe, expect, it } from "vitest";
import { appendTransition, newRelease } from "../src/halyard/coordinator/record-store.js";
import { applyTransition } from "../src/halyard/coordinator/state-machine.js";
import { ReleaseSchema } from "../src/halyard/contracts/release.schema.js";

let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

describe("deep re-entrancy: attempt-qualified dedup keys hold past the second cycle", () => {
  it("a third resubmit (in_review#3) still reaches shipped_dark, keys intact", () => {
    clock = 0;
    let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
    for (const to of ["tagged", "built", "tested", "uploaded"] as const) r = appendTransition(r, to, "ci", now);

    const step = (to: Parameters<typeof applyTransition>[1]) => {
      const out = applyTransition(r, to, "asc-review-poll", now);
      expect(out.applied).toBe(true);
      r = out.release;
    };
    // review → reject → resubmit, three times, then finally approved.
    step("in_review"); step("rejected");
    step("in_review"); step("rejected"); // #2
    step("in_review"); // #3
    step("shipped_dark");

    expect(r.state).toBe("shipped_dark");
    const inReviewKeys = r.transitions.filter((t) => t.to === "in_review").map((t) => t.dedup_key);
    expect(inReviewKeys).toEqual([
      "rel_aurora_ios_1.4.0:in_review",
      "rel_aurora_ios_1.4.0:in_review#2",
      "rel_aurora_ios_1.4.0:in_review#3",
    ]);
    expect(() => ReleaseSchema.parse(r)).not.toThrow(); // the record stays schema-valid
  });

  it("rollback → re-flip → rollback again lands at rolled_back#2 with valid keys", () => {
    clock = 0;
    let r = newRelease({ releaseId: "rel_aurora_web_2.0.0", app: "aurora", surface: "web", version: "2.0.0" });
    r = { ...r, flag: "launch.aurora.checkout" }; // live/rolled_back require a non-null flag
    for (const to of ["tagged", "built", "tested", "uploaded", "shipped_dark"] as const) r = appendTransition(r, to, "ci", now);

    const step = (to: Parameters<typeof applyTransition>[1]) => {
      const out = applyTransition(r, to, "flag-poll", now);
      expect(out.applied).toBe(true);
      r = out.release;
    };
    step("live"); step("rolled_back"); step("live"); step("rolled_back"); // live#2 then rolled_back#2

    expect(r.state).toBe("rolled_back");
    expect(r.transitions.filter((t) => t.to === "live").map((t) => t.dedup_key)).toEqual([
      "rel_aurora_web_2.0.0:live", "rel_aurora_web_2.0.0:live#2",
    ]);
    expect(r.transitions.filter((t) => t.to === "rolled_back").map((t) => t.dedup_key)).toEqual([
      "rel_aurora_web_2.0.0:rolled_back", "rel_aurora_web_2.0.0:rolled_back#2",
    ]);
    expect(() => ReleaseSchema.parse(r)).not.toThrow();
  });
});
