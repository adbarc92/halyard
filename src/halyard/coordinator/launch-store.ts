import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { LaunchSchema, type Launch } from "../contracts/launch.schema.js";
import type { Release } from "../contracts/release.schema.js";
import type { AnnouncePolicy, Tier } from "../config/org-config.schema.js";

/**
 * Launch store + the launch/release split (M4). A *launch* is the surface-agnostic
 * feature + narrative + announce policy; *releases* fan out from it per surface. "Did
 * we launch X?" is answered here, at the launch level (invariant: launch ≠ release).
 */

export function launchPath(stateDir: string, launchId: string): string {
  return join(stateDir, "launches", `${launchId}.json`);
}

export function scanLaunchIds(stateDir: string): string[] {
  const dir = join(stateDir, "launches");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function readLaunch(stateDir: string, launchId: string): Launch | null {
  const p = launchPath(stateDir, launchId);
  if (!existsSync(p)) return null;
  return LaunchSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function writeLaunch(stateDir: string, launch: Launch): void {
  const validated = LaunchSchema.parse(launch);
  const p = launchPath(stateDir, launch.launch_id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function newLaunch(args: {
  app: string;
  feature: string;
  title: string;
  narrativeSeed: string;
  announcePolicy: AnnouncePolicy;
  tier: Tier;
  flag: string;
  createdBy: string;
  createdAt: string;
}): Launch {
  return {
    launch_id: `lnch_${args.app}_${args.feature}`,
    app: args.app,
    title: args.title,
    narrative_seed: args.narrativeSeed,
    announce_policy: args.announcePolicy,
    tier: args.tier,
    releases: [],
    flag: args.flag,
    created_by: args.createdBy,
    created_at: args.createdAt,
  };
}

/** Add a release to a launch's fan-out (idempotent). */
export function linkRelease(launch: Launch, releaseId: string): Launch {
  if (launch.releases.includes(releaseId)) return launch;
  return { ...launch, releases: [...launch.releases, releaseId] };
}

/** Bind a release to its launch: inherit launch_id and the (born-OFF) flag. */
export function bindReleaseToLaunch(release: Release, launch: Launch): Release {
  return {
    ...release,
    launch_id: launch.launch_id,
    flag: launch.flag ?? release.flag,
  };
}
