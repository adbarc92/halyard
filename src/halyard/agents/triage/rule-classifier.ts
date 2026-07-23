import type { CrashSignal, TriageClassification, TriageClassifier } from "./types.js";

/**
 * Deterministic triage classifier — the default for local runs and the one the tests
 * exercise. Production swaps in the AnthropicTriageClassifier behind the same port. Both
 * only *classify*; neither acts. flag_kill is only ever *recommended* when a flag exists
 * to kill — the actual kill is a human-approved deterministic flip.
 */
export class RuleTriageClassifier implements TriageClassifier {
  async classify(signal: CrashSignal): Promise<TriageClassification> {
    const { crashFreePct } = signal.stats;
    const deficit = signal.thresholdPct - crashFreePct;

    let severity: TriageClassification["severity"];
    if (crashFreePct < 95 || deficit >= 4) severity = "critical";
    else if (crashFreePct < 98 || deficit >= 2) severity = "high";
    else if (deficit >= 0.5) severity = "medium";
    else severity = "low";

    let recommendation: TriageClassification["recommendation"];
    if (severity === "critical" && signal.flag) recommendation = "flag_kill";
    else if (severity === "critical" || severity === "high") recommendation = "hotfix";
    else recommendation = "ignore";

    const rationale =
      `crash-free ${crashFreePct}% vs ${signal.thresholdPct}% threshold ` +
      `(${signal.stats.eventCount} events). Top issue: ${signal.stats.topIssueTitle}.`;

    return { severity, recommendation, rationale };
  }
}
