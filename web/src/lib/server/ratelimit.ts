// web/src/lib/server/ratelimit.ts
//
// In-memory, per-process login rate limiter for the operator console. The console is
// single-instance and loopback-by-default, so a process-local Map is the whole datastore:
// no external store, no new dependency. Time is always supplied by the caller (epoch ms,
// from the injectable clock) so lockout is testable without real wall-clock time.

/** Failed attempts allowed before a key is locked out. */
export const MAX_FAILURES = 5;
/** How long a key stays locked once it trips MAX_FAILURES, in ms. */
export const LOCKOUT_MS = 15 * 60 * 1000;
/**
 * Hard ceiling on tracked keys. Bounds memory if an attacker rotates source addresses
 * (e.g. a spoofable forwarded-for) so the bucket map can't grow without limit.
 */
export const MAX_KEYS = 10_000;

interface Bucket {
  /** Failures accumulated within the current window. */
  count: number;
  /** Timestamp (epoch ms) of the first failure in the current window. */
  windowStart: number;
}

const buckets = new Map<string, Bucket>();

/** Window has elapsed since it opened: the bucket is stale and may be discarded. */
function expired(b: Bucket, now: number): boolean {
  return now - b.windowStart >= LOCKOUT_MS;
}

/**
 * Derive a rate-limit key from a client-address resolver, or `null` when the address can't
 * be determined. Callers MUST fail open on `null` (skip throttling) rather than collapse
 * every unidentifiable client into one shared bucket — a shared bucket is a lock-everyone-out
 * denial of service, where one bad actor whose address we can't read locks out real clients.
 */
export function clientKey(getClientAddress?: () => string): string | null {
  if (!getClientAddress) return null;
  try {
    const addr = getClientAddress();
    return addr ? addr : null;
  } catch {
    return null;
  }
}

/** Evict to stay under MAX_KEYS before admitting a brand-new key: stale buckets first, then
 * the oldest window (closest to expiring anyway). Keeps the map bounded under address churn. */
function evictIfFull(now: number): void {
  if (buckets.size < MAX_KEYS) return;
  for (const [k, b] of buckets) if (expired(b, now)) buckets.delete(k);
  if (buckets.size < MAX_KEYS) return;
  let oldestKey: string | undefined;
  let oldest = Infinity;
  for (const [k, b] of buckets) {
    if (b.windowStart < oldest) { oldest = b.windowStart; oldestKey = k; }
  }
  if (oldestKey !== undefined) buckets.delete(oldestKey);
}

/** Record one failed login for `key` at time `now` (epoch ms). */
export function recordFailure(key: string, now: number): void {
  const b = buckets.get(key);
  if (!b || expired(b, now)) {
    // Start a fresh window; a stale window never stacks onto a new failure.
    if (!buckets.has(key)) evictIfFull(now);
    buckets.set(key, { count: 1, windowStart: now });
    return;
  }
  b.count += 1;
}

/** A successful login clears any accumulated failures for `key`. */
export function recordSuccess(key: string): void {
  buckets.delete(key);
}

/**
 * Whether `key` is currently locked out at time `now` (epoch ms). Prunes the bucket once its
 * window has elapsed, bounding the map for transient clients.
 */
export function checkLocked(key: string, now: number): { locked: boolean; retryAfterMs?: number } {
  const b = buckets.get(key);
  if (!b) return { locked: false };
  if (expired(b, now)) {
    buckets.delete(key);
    return { locked: false };
  }
  if (b.count >= MAX_FAILURES) {
    return { locked: true, retryAfterMs: LOCKOUT_MS - (now - b.windowStart) };
  }
  return { locked: false };
}

/** Clear all state. Test-only; keeps suites independent without exposing the Map. */
export function resetRateLimit(): void {
  buckets.clear();
}
