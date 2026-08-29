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

/**
 * "This source isn't configured here" — not a failure. Cert notAfter dates, the deadlines
 * calendar and the Renovate feed are all OPTIONAL: an app that doesn't ship a signed
 * desktop build has no Authenticode cert, and the public example app has none of them. A
 * provider throws this when its input is absent, and the watchers record it as `skipped`
 * rather than `errors`, so an unconfigured source doesn't turn a scheduled run red.
 *
 * It is only for absence. A configured-but-broken source — a 500 from the cert API, a
 * malformed HALYARD_DEADLINES payload, a merge that failed — throws an ordinary Error and
 * still counts as an error, so the fail-closed property holds for real failures.
 */
export class NotConfiguredError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NotConfiguredError";
  }
}

/** True for the "not configured" sentinel above; every other throw is a real failure. */
export function isNotConfigured(err: unknown): err is NotConfiguredError {
  return err instanceof NotConfiguredError;
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
