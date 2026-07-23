/**
 * Per-surface poll scheduling (pure). The reconcile engine is surface-agnostic and runs
 * on the org-level coordinator.reconcile_cron sweep. A surface, though, may want its
 * review poll to run on a *coarser* cadence than the sweep (e.g. ASC review every 30m
 * even though the sweep fires every 20m). This module answers one deterministic question:
 *
 *   "Given a surface's `review_poll_cron`, is that poll DUE for the sweep ending now?"
 *
 * Windowing rule (the simplest defensible one): a poll is **due** if its cron would fire
 * at any minute inside the half-open sweep window `(now - windowMs, now]`. The window is
 * the gap since the previous sweep — i.e. how much wall-clock this sweep is responsible
 * for. If the cron's cadence elapsed anywhere in that window, the poll is due; otherwise
 * skipping it is a no-op (Invariant #1: a skipped poll on a stable record changes nothing).
 *
 * Deriving due-ness from the wall-clock window (rather than a persisted last-run marker)
 * keeps this stateless and the coordinator a pure projection — no new on-disk format.
 *
 * The check is intentionally minimal (no external cron dependency): it supports the same
 * 5-field grammar `CronSchema` validates (`*`, `N`, `*​/N`, `A-B`, `A,B,C`, plus a `/step`
 * suffix on ranges/lists), evaluating minute / hour / day-of-month / month / day-of-week.
 * Day-of-month and day-of-week combine with cron's usual OR semantics when both are
 * restricted; a `*` on either side means "no constraint from this field".
 */

/** A parsed cron field: the set of integer values it permits within [min,max]. */
type FieldMatcher = (value: number) => boolean;

/** One sub-expression of a comma list, e.g. `*`, `5`, `*​/15`, `1-5`, `0-30/10`. */
function parseFieldPart(part: string, min: number, max: number): FieldMatcher {
  // Split an optional `/step` suffix (applies to `*` or a range).
  const [rangePart, stepPart] = part.split("/");
  const step = stepPart !== undefined ? Number.parseInt(stepPart, 10) : 1;
  if (!Number.isFinite(step) || step <= 0) {
    throw new Error(`invalid cron step in "${part}"`);
  }

  let lo: number;
  let hi: number;
  if (rangePart === undefined || rangePart === "*") {
    lo = min;
    hi = max;
  } else if (rangePart.includes("-")) {
    const bounds = rangePart.split("-");
    lo = Number.parseInt(bounds[0] ?? "", 10);
    hi = Number.parseInt(bounds[1] ?? "", 10);
  } else {
    const v = Number.parseInt(rangePart, 10);
    lo = v;
    hi = v;
  }
  if (!Number.isFinite(lo) || !Number.isFinite(hi)) {
    throw new Error(`invalid cron field "${part}"`);
  }

  return (value: number) => value >= lo && value <= hi && (value - lo) % step === 0;
}

/** Parse one whitespace-delimited cron field (which may be a comma list) into a matcher. */
function parseField(field: string, min: number, max: number): FieldMatcher {
  const parts = field.split(",").map((p) => parseFieldPart(p, min, max));
  return (value: number) => parts.some((m) => m(value));
}

interface ParsedCron {
  minute: FieldMatcher;
  hour: FieldMatcher;
  dom: FieldMatcher;
  month: FieldMatcher;
  dow: FieldMatcher;
  /** Whether day-of-month / day-of-week were restricted (drives cron's OR semantics). */
  domRestricted: boolean;
  dowRestricted: boolean;
}

function parseCron(cron: string): ParsedCron {
  const fields = cron.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`expected a 5-field cron expression, got "${cron}"`);
  }
  const [minute, hour, dom, month, dow] = fields as [string, string, string, string, string];
  return {
    minute: parseField(minute, 0, 59),
    hour: parseField(hour, 0, 23),
    dom: parseField(dom, 1, 31),
    month: parseField(month, 1, 12),
    // Cron day-of-week is 0-6 (Sunday=0). We don't honor `7` as Sunday; CronSchema's
    // numeric grammar plus this minute-granular use make that edge irrelevant here.
    dow: parseField(dow, 0, 6),
    domRestricted: dom.trim() !== "*",
    dowRestricted: dow.trim() !== "*",
  };
}

/** Does this cron fire at the exact minute of `date` (UTC)? */
function firesAt(parsed: ParsedCron, date: Date): boolean {
  if (!parsed.minute(date.getUTCMinutes())) return false;
  if (!parsed.hour(date.getUTCHours())) return false;
  if (!parsed.month(date.getUTCMonth() + 1)) return false;

  // Standard cron day matching: when BOTH day-of-month and day-of-week are restricted, a
  // match on EITHER fires; when only one is restricted, that one must match; when neither
  // is restricted, the day is unconstrained.
  const domOk = parsed.dom(date.getUTCDate());
  const dowOk = parsed.dow(date.getUTCDay());
  if (parsed.domRestricted && parsed.dowRestricted) {
    if (!domOk && !dowOk) return false;
  } else if (parsed.domRestricted) {
    if (!domOk) return false;
  } else if (parsed.dowRestricted) {
    if (!dowOk) return false;
  }
  return true;
}

/** Default sweep window: the org sweep fires every 20m (coordinator.reconcile_cron). */
export const DEFAULT_SWEEP_WINDOW_MS = 20 * 60 * 1000;

/**
 * Is `cron` due for a sweep ending at `now`?
 *
 * Pure and deterministic: true iff the cron would fire at any minute inside the half-open
 * window `(now - windowMs, now]`. We scan minute-by-minute over the window (cron's finest
 * granularity is one minute), so a 30-minute cron seen by a 20-minute sweep fires on the
 * sweeps whose window contains its :00/:30 minute and is skipped on the others.
 *
 * `windowMs` should be the inter-sweep gap (default = the 20m reconcile cadence). It is
 * clamped to one minute minimum so a misconfigured tiny window still inspects the current
 * minute; windows longer than a day are capped to a day's worth of minutes as a guard.
 */
export function isCronDue(
  cron: string,
  now: Date,
  windowMs: number = DEFAULT_SWEEP_WINDOW_MS,
): boolean {
  const parsed = parseCron(cron);
  const ONE_MINUTE = 60 * 1000;
  const span = Math.min(Math.max(windowMs, ONE_MINUTE), 24 * 60 * 60 * 1000);

  // Walk minutes from `now` backwards to the window start (exclusive). We zero the seconds
  // so we test calendar minutes, not the sub-minute instant the sweep happened to fire on.
  const end = new Date(now.getTime());
  end.setUTCSeconds(0, 0);
  const minutesToCheck = Math.floor(span / ONE_MINUTE);
  for (let i = 0; i <= minutesToCheck; i++) {
    const candidate = new Date(end.getTime() - i * ONE_MINUTE);
    // Half-open: exclude the very start of the window (it belonged to the previous sweep).
    if (now.getTime() - candidate.getTime() >= span) break;
    if (firesAt(parsed, candidate)) return true;
  }
  return false;
}

/**
 * Estimate a cron's cadence (the gap between consecutive fires) in milliseconds, by
 * walking forward minute-by-minute from `from` until it fires twice. Used to size the
 * sweep window from the org's `coordinator.reconcile_cron` so the per-surface gate uses
 * the *actual* inter-sweep gap rather than a hard-coded 20m. Falls back to the default
 * window if the cron somehow never fires within a day (it always should).
 */
export function estimateCronIntervalMs(
  cron: string,
  from: Date = new Date(),
  fallbackMs: number = DEFAULT_SWEEP_WINDOW_MS,
): number {
  const parsed = parseCron(cron);
  const ONE_MINUTE = 60 * 1000;
  const start = new Date(from.getTime());
  start.setUTCSeconds(0, 0);

  let firstFire: number | null = null;
  for (let i = 1; i <= 24 * 60; i++) {
    const candidate = new Date(start.getTime() + i * ONE_MINUTE);
    if (firesAt(parsed, candidate)) {
      if (firstFire === null) {
        firstFire = candidate.getTime();
      } else {
        return candidate.getTime() - firstFire;
      }
    }
  }
  return fallbackMs;
}

/**
 * A due predicate built from a reference clock + window, for source assembly. Returns a
 * function `(cron) => boolean` so `buildReconcileSources` can gate each surface's review
 * poll without knowing how due-ness is computed. A `null`/`undefined` cron is treated as
 * "always due" (no schedule configured = no gating), but callers only pass review crons.
 */
export function makeCronDuePredicate(
  now: Date,
  windowMs: number = DEFAULT_SWEEP_WINDOW_MS,
): (cron: string | undefined) => boolean {
  return (cron) => (cron ? isCronDue(cron, now, windowMs) : true);
}
