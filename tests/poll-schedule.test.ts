import { describe, expect, it } from "vitest";
import {
  DEFAULT_SWEEP_WINDOW_MS,
  estimateCronIntervalMs,
  isCronDue,
  makeCronDuePredicate,
} from "../src/halyard/coordinator/schedule.js";
import { buildReconcileSources } from "../src/halyard/coordinator/sources/index.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";
import type { OrgConfig } from "../src/halyard/config/org-config.schema.js";
import type { FlagClient } from "../src/halyard/flags/types.js";

/**
 * Lane 1 — per-surface review-poll cron. The org-level reconcile_cron drives the sweep;
 * each surface's review_poll_cron gates whether ITS review poll joins a given sweep. The
 * gate is a pure, deterministic function of (cron, reference-clock, window). The flag poll
 * is never gated. Skipping a review poll is a pure no-op (Invariant #1).
 */

// A fixed UTC instant we can reason about minute-by-minute.
const at = (iso: string) => new Date(iso);

describe("isCronDue: pure, deterministic schedule gate over a sweep window", () => {
  const cron30 = "*/30 * * * *"; // fires at :00 and :30 each hour

  it("is due when the cron fires inside the (now - window, now] sweep window", () => {
    // 20m window ending 10:30 covers (10:10, 10:30] → contains the :30 fire.
    expect(isCronDue(cron30, at("2026-06-09T10:30:00.000Z"), DEFAULT_SWEEP_WINDOW_MS)).toBe(true);
    // 20m window ending 10:00 covers (09:40, 10:00] → contains the :00 fire.
    expect(isCronDue(cron30, at("2026-06-09T10:00:00.000Z"), DEFAULT_SWEEP_WINDOW_MS)).toBe(true);
  });

  it("is NOT due when no cron fire falls in the window (the skip case)", () => {
    // 20m window ending 10:20 covers (10:00, 10:20] → :00 excluded (half-open), :30 not yet.
    expect(isCronDue(cron30, at("2026-06-09T10:20:00.000Z"), DEFAULT_SWEEP_WINDOW_MS)).toBe(false);
    // 20m window ending 10:40 covers (10:20, 10:40] → :30 already passed at 10:30 < 10:20? no.
    // Window is (10:20,10:40]; :30 IS inside → due. Use 10:50 instead for a clean skip:
    expect(isCronDue(cron30, at("2026-06-09T10:50:00.000Z"), DEFAULT_SWEEP_WINDOW_MS)).toBe(false);
  });

  it("treats the window as half-open: the previous-sweep boundary minute does not count", () => {
    // Window of exactly 30m ending 10:30 is (10:00, 10:30]; the :00 fire sits ON the open
    // boundary and is excluded, but the :30 fire is included → due via :30.
    expect(isCronDue(cron30, at("2026-06-09T10:30:00.000Z"), 30 * 60 * 1000)).toBe(true);
    // Window of exactly 30m ending 10:29 is (09:59, 10:29]; contains the :00 fire → due.
    expect(isCronDue(cron30, at("2026-06-09T10:29:00.000Z"), 30 * 60 * 1000)).toBe(true);
  });

  it("ignores sub-minute seconds on the sweep instant (calendar-minute granularity)", () => {
    // A sweep that fires at 10:30:45 still sees the :30 fire (seconds zeroed).
    expect(isCronDue(cron30, at("2026-06-09T10:30:45.000Z"), DEFAULT_SWEEP_WINDOW_MS)).toBe(true);
  });

  it("supports *, fixed values, ranges, lists and steps", () => {
    expect(isCronDue("* * * * *", at("2026-06-09T03:07:00.000Z"), 60 * 1000)).toBe(true);
    expect(isCronDue("7 3 * * *", at("2026-06-09T03:07:00.000Z"), 60 * 1000)).toBe(true);
    expect(isCronDue("7 3 * * *", at("2026-06-09T04:07:00.000Z"), 60 * 1000)).toBe(false);
    // List: minutes 0,15,30,45 — 15 is in a 1m window ending :15.
    expect(isCronDue("0,15,30,45 * * * *", at("2026-06-09T09:15:00.000Z"), 60 * 1000)).toBe(true);
    expect(isCronDue("0,15,30,45 * * * *", at("2026-06-09T09:16:00.000Z"), 60 * 1000)).toBe(false);
  });

  it("is deterministic — same inputs, same answer", () => {
    const when = at("2026-06-09T10:30:00.000Z");
    expect(isCronDue(cron30, when)).toBe(isCronDue(cron30, when));
  });
});

describe("estimateCronIntervalMs: window sized from the org sweep cadence", () => {
  it("derives 20m from */20 and 30m from */30", () => {
    const from = at("2026-06-09T00:00:00.000Z");
    expect(estimateCronIntervalMs("*/20 * * * *", from)).toBe(20 * 60 * 1000);
    expect(estimateCronIntervalMs("*/30 * * * *", from)).toBe(30 * 60 * 1000);
  });
});

describe("makeCronDuePredicate: an undefined cron is always due (no gating)", () => {
  it("returns true for undefined regardless of clock", () => {
    const pred = makeCronDuePredicate(at("2026-06-09T10:50:00.000Z"));
    expect(pred(undefined)).toBe(true);
  });
});

// --- Source-assembly gating ----------------------------------------------------------

const noopFlagClient: FlagClient = {
  getState: async () => "off",
  ensureFlag: async () => {},
  setState: async () => {},
};
const org = {} as OrgConfig; // buildReconcileSources ignores _org

/** A minimal AppConfig carrying only what buildReconcileSources reads (surfaces). */
function appWith(opts: {
  iosEnabled?: boolean;
  iosCron?: string;
  androidEnabled?: boolean;
  androidTrack?: "internal" | "alpha" | "beta" | "production";
}): AppConfig {
  return {
    app: { slug: "aurora" },
    surfaces: {
      ios: opts.iosEnabled
        ? { enabled: true, review_poll_cron: opts.iosCron ?? "*/30 * * * *" }
        : undefined,
      android: opts.androidEnabled
        ? { enabled: true, track: opts.androidTrack ?? "production" }
        : undefined,
    },
  } as unknown as AppConfig;
}

function sourceNames(opts: Parameters<typeof appWith>[0], when: Date): string[] {
  const windowMs = estimateCronIntervalMs("*/20 * * * *", when); // org sweeps every 20m
  return buildReconcileSources(org, [appWith(opts)], {
    flagClient: noopFlagClient,
    makeAscClient: () => ({ getReviewStatus: async () => "processing" }),
    makePlayClient: () => ({ getReviewStatus: async () => "processing" }),
    isReviewPollDue: makeCronDuePredicate(when, windowMs),
  }).map((s) => s.name);
}

describe("buildReconcileSources: iOS review poll gated by review_poll_cron, flag poll never", () => {
  // Fixture iOS cron is */30; org sweep is */20.
  const dueMinute = at("2026-06-09T10:30:00.000Z"); // :30 inside (10:10,10:30] → due
  const notDueMinute = at("2026-06-09T10:50:00.000Z"); // (10:30,10:50] has no :00/:30 → skip

  it("registers the ASC poll on a due sweep", () => {
    const names = sourceNames({ iosEnabled: true, iosCron: "*/30 * * * *" }, dueMinute);
    expect(names).toContain("asc-review-poll");
    expect(names).toContain("flag-poll");
  });

  it("does NOT register the ASC poll on a non-due sweep, but flag poll still runs", () => {
    const names = sourceNames({ iosEnabled: true, iosCron: "*/30 * * * *" }, notDueMinute);
    expect(names).not.toContain("asc-review-poll");
    expect(names).toContain("flag-poll"); // launch moment — never gated
  });

  it("gates the production Play review poll on the same schedule as iOS", () => {
    const due = sourceNames(
      { iosEnabled: true, iosCron: "*/30 * * * *", androidEnabled: true, androidTrack: "production" },
      dueMinute,
    );
    expect(due).toContain("play-review-poll");

    const notDue = sourceNames(
      { iosEnabled: true, iosCron: "*/30 * * * *", androidEnabled: true, androidTrack: "production" },
      notDueMinute,
    );
    expect(notDue).not.toContain("play-review-poll");
    expect(notDue).toContain("flag-poll");
  });

  it("non-production Android registers no review poll regardless of schedule", () => {
    const names = sourceNames({ androidEnabled: true, androidTrack: "internal" }, dueMinute);
    expect(names).not.toContain("play-review-poll");
    expect(names).toContain("flag-poll");
  });

  it("with no due predicate, review polls run every sweep (legacy behavior preserved)", () => {
    const names = buildReconcileSources(org, [appWith({ iosEnabled: true })], {
      flagClient: noopFlagClient,
      makeAscClient: () => ({ getReviewStatus: async () => "processing" }),
    }).map((s) => s.name);
    expect(names).toContain("asc-review-poll");
    expect(names).toContain("flag-poll");
  });
});
