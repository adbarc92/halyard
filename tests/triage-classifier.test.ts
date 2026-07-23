import { describe, expect, it } from "vitest";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import type { CrashSignal } from "../src/halyard/agents/triage/types.js";

function signal(crashFreePct: number, flag: string | null): CrashSignal {
  return {
    app: "aurora", surface: "ios", version: "1.4.0", flag, thresholdPct: 99.5,
    stats: { crashFreePct, eventCount: 5000, topIssueTitle: "NullPointerException in SyncEngine" },
  };
}

describe("M6: triage classifier produces a severity + recommendation (classification, not action)", () => {
  const classifier = new RuleTriageClassifier();

  it("a severe spike with a kill-switch flag → flag_kill", async () => {
    const c = await classifier.classify(signal(94.0, "launch.aurora.offline_sync"));
    expect(c.severity).toBe("critical");
    expect(c.recommendation).toBe("flag_kill");
    expect(c.rationale).toContain("94");
  });

  it("a severe spike without a flag → hotfix (can't kill what doesn't exist)", async () => {
    const c = await classifier.classify(signal(94.0, null));
    expect(c.severity).toBe("critical");
    expect(c.recommendation).toBe("hotfix");
  });

  it("a mild dip → ignore", async () => {
    const c = await classifier.classify(signal(98.8, "launch.aurora.offline_sync")); // deficit 0.7
    expect(c.severity).toBe("medium");
    expect(c.recommendation).toBe("ignore");
  });

  it("a high (not critical) spike → hotfix", async () => {
    const c = await classifier.classify(signal(97.5, "launch.aurora.offline_sync"));
    expect(c.severity).toBe("high");
    expect(c.recommendation).toBe("hotfix");
  });
});
