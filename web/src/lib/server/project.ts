import { join, resolve } from "node:path";
import {
  loadOrgConfig,
  loadAppConfig,
  discoverAppSlugs,
  makeFlagClient,
  ConfigError,
  type OrgConfig,
  type AppConfig,
  type FlagClient,
} from "halyard";
import { systemClock, type Clock } from "./clock.js";

export interface LoadedProject {
  ok: true;
  root: string;
  org: OrgConfig;
  apps: AppConfig[];
  stateDir: string;
  canonDir: string;
  /**
   * The flag provider. Widened to the `FlagClient` port: a live `HttpFlagClient` when an app
   * configures one (`flags.api_url` + a resolvable `api_key_ref` token, and live flags enabled),
   * else the git-backed `FlagFileClient`. The console flips whichever the config selects.
   */
  flagClient: FlagClient;
}
export interface DegradedProject {
  ok: false;
  root: string;
  error: string;
}
export type Project = LoadedProject | DegradedProject;

/** The console-only project root: explicit env override, else the process CWD (like the CLI). */
export function resolveRoot(): string {
  return process.env.HALYARD_CONFIG_ROOT
    ? resolve(process.env.HALYARD_CONFIG_ROOT)
    : process.cwd();
}

/**
 * Select the flag provider exactly as the CLI / reconcile workflow does, via the library's
 * shared `makeFlagClient` (the single source of truth — see `src/halyard/flags/select.ts`):
 *   - the live `HttpFlagClient` when live flags are enabled (`HALYARD_LIVE_FLAGS`) AND an app
 *     declares `flags.api_url` AND its `flags.api_key_ref` token resolves from the secret store;
 *   - the git-backed `FlagFileClient` otherwise (the offline / credential-free default).
 *
 * The token is resolved at runtime from the secret store (invariant #4) and never logged.
 * A misconfigured / token-less provider simply falls through to the file client — the console
 * still loads and works exactly as today.
 */
export function chooseFlagClient(apps: AppConfig[], stateDir: string, now: Clock): FlagClient {
  return makeFlagClient(apps, stateDir, now);
}

/** Load org + apps from a single root. Never throws — failure becomes a degraded result. */
export function loadProject(root: string, now: Clock = systemClock): Project {
  try {
    const org = loadOrgConfig(join(root, "halyard.config.yml"));
    const slugs = discoverAppSlugs(join(root, "apps"));
    const apps = slugs.map((slug) => loadAppConfig(join(root, "apps", slug, "app.yml")));
    const stateDir = resolve(root, org.coordinator.state_dir);
    const canonDir = resolve(root, org.drafting.voice_canon);
    return { ok: true, root, org, apps, stateDir, canonDir, flagClient: chooseFlagClient(apps, stateDir, now) };
  } catch (err) {
    const error = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    return { ok: false, root, error };
  }
}
