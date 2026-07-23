import { describe, expect, it } from "vitest";
import { appendTransition, newRelease } from "../src/halyard/coordinator/record-store.js";
import { summarizeRelease, waitingOn } from "../src/halyard/coordinator/status.js";
import { daysUntil, urgency } from "../src/halyard/maintenance/types.js";

const now = () => "2026-06-07T00:00:00.000Z";

describe("status summary", () => {
  it("reports what a shipped_dark release is waiting on, and flags it as stuck", () => {
    let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"] as const) {
      r = appendTransition(r, to, "ci", () => "2026-06-06T00:00:00.000Z");
    }
    const s = summarizeRelease(r, now());
    expect(s.state).toBe("shipped_dark");
    expect(s.waiting_on).toMatch(/flag flip/);
    expect(s.stuck).toBe(true);
    expect(s.last_transition?.to).toBe("shipped_dark");
    expect(s.age_hours).toBe(24); // last transition was 24h before `now`
  });

  it("a live release is not stuck; a dead release is not stuck", () => {
    const live = (() => {
      let r = newRelease({ releaseId: "rel_aurora_web_2.0.0", app: "aurora", surface: "web", version: "2.0.0" });
      for (const to of ["tagged", "built", "tested", "uploaded", "live"] as const) r = appendTransition(r, to, "ci", now);
      return summarizeRelease(r, now());
    })();
    expect(live.stuck).toBe(false);
    expect(live.waiting_on).toMatch(/live/);

    let d = newRelease({ releaseId: "rel_aurora_web_2.0.1", app: "aurora", surface: "web", version: "2.0.1" });
    d = appendTransition(d, "dead", "ci", now);
    expect(summarizeRelease(d, now()).stuck).toBe(false);
  });

  it("web uploaded waits on the flag flip; ios uploaded waits on App Store review", () => {
    const web = newRelease({ releaseId: "rel_a_web_1", app: "a", surface: "web", version: "1" });
    const ios = newRelease({ releaseId: "rel_a_ios_1", app: "a", surface: "ios", version: "1" });
    expect(waitingOn({ ...web, state: "uploaded" })).toMatch(/flag flip/);
    expect(waitingOn({ ...ios, state: "uploaded" })).toMatch(/App Store review/);
  });
});

describe("maintenance urgency thresholds are inclusive and consistent with the windows", () => {
  it("treats an exact-boundary day as the higher urgency", () => {
    expect(urgency(7, 7, 14)).toBe("critical"); // was 'high' under strict `<`
    expect(urgency(14, 7, 14)).toBe("high");
    expect(urgency(15, 7, 14)).toBe("medium");
    expect(urgency(0, 7, 14)).toBe("critical");
  });

  it("daysUntil rounds down (conservative for alerting)", () => {
    // ~6.5 days out → 6 whole days remaining.
    expect(daysUntil("2026-06-13T12:00:00.000Z", "2026-06-07T00:00:00.000Z")).toBe(6);
    expect(daysUntil("2026-06-06T00:00:00.000Z", "2026-06-07T00:00:00.000Z")).toBe(-1); // already past
  });
});
