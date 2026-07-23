import type { FlagClient, FlagState } from "./types.js";
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../net.js";

type FetchFn = typeof fetch;

/**
 * Live flag provider over a generic REST shape:
 *   GET    {base}/flags/{key}  -> 200 { "on": boolean } | 404 (absent)
 *   PUT    {base}/flags/{key}  <- { "on": boolean }
 *
 * This is the production counterpart to the git-backed FlagFileClient and closes the one
 * port asymmetry (every other external integration already has a live client). A specific
 * provider (e.g. LaunchDarkly, whose API uses semantic-patch instructions per environment)
 * implements this same `FlagClient` port with its own mapping — this generic client is the
 * template, and unlike the other live clients it's unit-tested via an injectable `fetchFn`.
 *
 * Credentials (base URL + token) come from the secret store / env at runtime, never config.
 */
export interface HttpFlagClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: FetchFn;
  /** Request timeout in ms (default 15_000). A wedged provider must not stall a sweep. */
  timeoutMs?: number;
}

export class HttpFlagClient implements FlagClient {
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly opts: HttpFlagClientOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  }

  private url(key: string): string {
    return `${this.opts.baseUrl.replace(/\/+$/, "")}/flags/${encodeURIComponent(key)}`;
  }

  private headers(): Record<string, string> {
    return { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" };
  }

  async getState(flagKey: string): Promise<FlagState> {
    const res = await fetchWithTimeout(this.fetchFn, this.url(flagKey), { headers: this.headers() }, this.timeoutMs);
    if (res.status === 404) return "absent";
    if (!res.ok) throw new Error(`flag provider GET ${res.status}`);
    const body = (await res.json()) as { on?: boolean };
    return body.on ? "on" : "off";
  }

  async ensureFlag(flagKey: string): Promise<void> {
    if ((await this.getState(flagKey)) !== "absent") return; // idempotent
    await this.put(flagKey, false); // born OFF
  }

  async setState(flagKey: string, on: boolean): Promise<void> {
    await this.put(flagKey, on);
  }

  private async put(flagKey: string, on: boolean): Promise<void> {
    const res = await fetchWithTimeout(
      this.fetchFn,
      this.url(flagKey),
      { method: "PUT", headers: this.headers(), body: JSON.stringify({ on }) },
      this.timeoutMs,
    );
    if (!res.ok) throw new Error(`flag provider PUT ${res.status}`);
  }
}
