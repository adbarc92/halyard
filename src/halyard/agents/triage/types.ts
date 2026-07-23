import type { Recommendation, Severity } from "../../contracts/proposal.schema.js";
import type { Surface } from "../../config/primitives.js";

/**
 * Sentry triage (M6). Two pieces, kept separate so the model never holds the gate:
 *   - a deterministic spike gate (crash-free % below the configured threshold) decides
 *     whether triage runs at all;
 *   - a `TriageClassifier` (the agent) judges severity + recommended action and writes
 *     a *proposal*. It never kills a flag or ships a hotfix — a human approves, then
 *     deterministic code executes (invariant #2).
 */

export interface SentryStats {
  crashFreePct: number;
  eventCount: number;
  topIssueTitle: string;
}

export interface SentryClient {
  getReleaseHealth(app: string, surface: Surface, version: string): Promise<SentryStats>;
}

export interface CrashSignal {
  app: string;
  surface: Surface;
  version: string;
  flag: string | null;
  thresholdPct: number;
  stats: SentryStats;
}

export interface TriageClassification {
  severity: Severity;
  recommendation: Recommendation;
  rationale: string;
}

export interface TriageClassifier {
  classify(signal: CrashSignal): Promise<TriageClassification>;
}
