// src/halyard/coordinator/service/client.ts
type FetchFn = typeof fetch;

/** Error from the Halyard state service. `retryable` is true for 5xx/network/timeout, false for 4xx. */
export class ServiceHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "ServiceHttpError";
  }
}

export interface ServiceHttpClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: FetchFn;
  /** Request timeout in ms (default 10_000). A wedged fetch must not stall a reconcile sweep. */
  timeoutMs?: number;
}

/**
 * Thin HTTP client for the Halyard state service. Mirrors `flags/http-client.ts`: bearer auth from a
 * runtime-resolved token (never logged), constructor-injected `fetchFn` for tests. Adds a request
 * timeout (the flag client has none) and a typed error. The adapters layer port semantics on top.
 */
export class ServiceHttpClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ServiceHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure / timeout abort → retryable. Message must never carry the token.
      const detail = err instanceof Error ? err.message : String(err);
      throw new ServiceHttpError(`service ${method} ${path} failed: ${detail}`, 0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET → 200 parsed JSON, 404 → null, other non-2xx → throw. */
  async getJson(path: string): Promise<unknown | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceHttpError(`service GET ${path} ${res.status}`, res.status, res.status >= 500);
    return res.json();
  }

  /** PUT/POST → 2xx parsed JSON (undefined if empty body), non-2xx → throw. */
  async sendJson(method: "PUT" | "POST", path: string, body: unknown): Promise<unknown> {
    const res = await this.request(method, path, body);
    if (!res.ok) throw new ServiceHttpError(`service ${method} ${path} ${res.status}`, res.status, res.status >= 500);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }
}
