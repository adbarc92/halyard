/**
 * Maintenance event sources (M7). Three independent watchers feed the same proposal bus
 * and approval surface as launches, publicity, and triage:
 *   - cert expiry  → ALERT only (renewal auth stays manual — a human renews)
 *   - platform deadlines → ALERT (SDK mins / target-API cutoffs)
 *   - dependency updates → Renovate gate: patch/minor auto-merge (config-authorized
 *     deterministic action), everything else proposes for human review.
 *
 * Each external system is behind a port so the watchers stay testable and the provider
 * is swappable (env-backed locally, real API in production).
 */

export type CertKind = "apple_distribution" | "apple_push_key" | "authenticode";

export interface CertStatus {
  kind: CertKind;
  notAfter: string; // ISO date the cert expires
}

export interface CertExpiryProvider {
  getCertStatus(app: string, kind: CertKind): Promise<CertStatus>;
}

export interface PlatformDeadline {
  id: string;
  title: string;
  date: string; // ISO date of the deadline
}

export interface PlatformDeadlineProvider {
  getDeadlines(app: string): Promise<PlatformDeadline[]>;
}

export type UpdateType = "patch" | "minor" | "major";

export interface DependencyUpdate {
  id: string;
  name: string;
  updateType: UpdateType;
  from: string;
  to: string;
  pr: number;
}

export interface DependencyUpdateProvider {
  listUpdates(app: string): Promise<DependencyUpdate[]>;
}

/** Executes the one genuinely-automated maintenance action: merging an auto-merge PR. */
export interface MergeClient {
  /** `repo` is the "owner/name" to merge into — explicit, never inferred or hardcoded. */
  merge(repo: string, pr: number): Promise<void>;
}

const DAY_MS = 86_400_000;

/** Whole days from `now` until `dateISO`, rounded DOWN — conservative for alerting (6.9
 *  days remaining counts as 6, i.e. the more-urgent direction). Negative if already past. */
export function daysUntil(dateISO: string, now: string): number {
  return Math.floor((Date.parse(dateISO) - Date.parse(now)) / DAY_MS);
}

/** Sooner = more urgent. Thresholds are inclusive upper bounds (`<=`), matching the
 *  inclusive alert windows in the watchers, so a value exactly on a boundary takes the
 *  higher urgency (e.g. with critical=7, exactly 7 days out is critical, not high). */
export function urgency(days: number, criticalWithin: number, highWithin: number): "critical" | "high" | "medium" {
  if (days <= criticalWithin) return "critical";
  if (days <= highWithin) return "high";
  return "medium";
}
