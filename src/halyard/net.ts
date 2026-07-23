// Shared fetch timeout wrapper. A wedged external endpoint must never stall a reconcile
// sweep up to the workflow job timeout — every live HTTP client routes through this so an
// unresponsive provider fails fast (the abort surfaces as a rejection, which the reconcile
// engine isolates per-source). The service client (coordinator/service/client.ts) already
// modelled this pattern; this generalizes it to the remaining clients.

/** Default per-request timeout (ms). Generous enough for slow-but-alive APIs, short enough
 *  that a hung endpoint can't wedge a sweep. */
export const DEFAULT_FETCH_TIMEOUT_MS = 15_000;

/**
 * Call `fetchFn` with an AbortController that fires after `timeoutMs`. The caller's own
 * `init.signal` is replaced; on timeout the fetch rejects (AbortError), preserving each
 * client's existing throw-on-failure path. The timer is always cleared.
 */
export async function fetchWithTimeout(
  fetchFn: typeof fetch,
  input: string | URL,
  init?: RequestInit,
  timeoutMs: number = DEFAULT_FETCH_TIMEOUT_MS,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetchFn(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}
