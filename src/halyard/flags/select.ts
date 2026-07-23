import type { AppConfig } from "../config/app-config.schema.js";
import { tryResolveSecret } from "../secrets/resolve.js";
import { FlagFileClient } from "./file-client.js";
import { HttpFlagClient } from "./http-client.js";
import type { FlagClient } from "./types.js";

/**
 * The live HTTP flag provider when an app configures one and live flags are enabled, else null.
 *
 * The base URL is plain per-app config (`flags.api_url`); the token is resolved at runtime from
 * the app's configured secret reference (`flags.api_key_ref`) — invariant #4: never a literal,
 * never logged. Returns null (caller falls back) unless `HALYARD_LIVE_FLAGS` is set AND a base
 * URL is configured AND the token resolves.
 */
export function liveFlagClientFor(app: AppConfig): HttpFlagClient | null {
  if (!process.env.HALYARD_LIVE_FLAGS) return null;
  const baseUrl = app.flags.api_url;
  const token = baseUrl ? tryResolveSecret(app.flags.api_key_ref) : undefined;
  return baseUrl && token ? new HttpFlagClient({ baseUrl, token }) : null;
}

/**
 * Select the flag provider from config — the single source of truth shared by the CLI, the web
 * console, and the smoke script (do not fork this):
 *
 *   - the live `HttpFlagClient` when live flags are enabled (`HALYARD_LIVE_FLAGS`) AND some app
 *     declares `flags.api_url` with a resolvable `api_key_ref` token;
 *   - the git-backed `FlagFileClient` otherwise (the offline / credential-free default).
 *
 * A misconfigured / token-less provider simply falls through to the file client — callers stay
 * online-optional and never crash on an absent provider.
 */
export function makeFlagClient(
  apps: AppConfig[],
  stateDir: string,
  now: () => string,
): FlagClient {
  for (const app of apps) {
    const live = liveFlagClientFor(app);
    if (live) return live;
  }
  return new FlagFileClient(stateDir, now);
}
