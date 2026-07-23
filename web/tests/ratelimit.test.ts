import { describe, expect, it, beforeEach } from "vitest";
import {
  recordFailure, recordSuccess, checkLocked, resetRateLimit, clientKey,
  MAX_FAILURES, LOCKOUT_MS, MAX_KEYS,
} from "../src/lib/server/ratelimit.js";

const KEY = "127.0.0.1";

beforeEach(() => { resetRateLimit(); });

describe("login rate limiter", () => {
  it("permits attempts below the threshold", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(KEY, t0);
    expect(checkLocked(KEY, t0).locked).toBe(false);
  });

  it("locks after MAX_FAILURES bad attempts and reports retry-after", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(KEY, t0);
    const r = checkLocked(KEY, t0);
    expect(r.locked).toBe(true);
    expect(r.retryAfterMs).toBe(LOCKOUT_MS);
  });

  it("unlocks once the lockout window elapses (injected clock, not wall time)", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(KEY, t0);
    expect(checkLocked(KEY, t0 + LOCKOUT_MS - 1).locked).toBe(true);
    expect(checkLocked(KEY, t0 + LOCKOUT_MS).locked).toBe(false);
  });

  it("counts down retry-after as the window elapses", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure(KEY, t0);
    expect(checkLocked(KEY, t0 + 1000).retryAfterMs).toBe(LOCKOUT_MS - 1000);
  });

  it("a successful login clears the failure count", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(KEY, t0);
    recordSuccess(KEY);
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(KEY, t0);
    expect(checkLocked(KEY, t0).locked).toBe(false);
  });

  it("tracks keys independently (one client's lockout does not affect another)", () => {
    const t0 = 1_000_000;
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure("10.0.0.1", t0);
    expect(checkLocked("10.0.0.1", t0).locked).toBe(true);
    expect(checkLocked("10.0.0.2", t0).locked).toBe(false);
  });

  it("a stale failure window resets the counter after the lockout elapses", () => {
    const t0 = 1_000_000;
    // One short of a lock, long ago.
    for (let i = 0; i < MAX_FAILURES - 1; i++) recordFailure(KEY, t0);
    // A fresh failure well past the window must not stack onto the stale ones.
    recordFailure(KEY, t0 + LOCKOUT_MS + 1);
    expect(checkLocked(KEY, t0 + LOCKOUT_MS + 1).locked).toBe(false);
  });

  it("bounds tracked keys past the cap, evicting the oldest window (#3 memory DoS)", () => {
    const t0 = 1_000_000;
    // An old, locked victim.
    for (let i = 0; i < MAX_FAILURES; i++) recordFailure("victim", t0);
    expect(checkLocked("victim", t0).locked).toBe(true);
    // Flood the map past the cap with fresher keys; victim has the oldest window.
    const t1 = t0 + 1;
    for (let i = 0; i < MAX_KEYS; i++) recordFailure(`flood-${i}`, t1);
    // The oldest window was evicted to stay bounded, so the victim is no longer tracked.
    expect(checkLocked("victim", t1).locked).toBe(false);
  });
});

describe("clientKey (fail-open key derivation, #2)", () => {
  it("returns the address when resolvable", () => {
    expect(clientKey(() => "10.0.0.9")).toBe("10.0.0.9");
  });
  it("returns null on an empty address (fail open — no shared lockable bucket)", () => {
    expect(clientKey(() => "")).toBeNull();
  });
  it("returns null when the resolver throws", () => {
    expect(clientKey(() => { throw new Error("no address"); })).toBeNull();
  });
  it("returns null when no resolver is provided", () => {
    expect(clientKey(undefined)).toBeNull();
  });
});
