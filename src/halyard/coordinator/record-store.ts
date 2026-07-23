import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ReleaseSchema, dedupKey, type Release } from "../contracts/release.schema.js";
import type { ReleaseState } from "../contracts/state.js";

/**
 * Git-backed release-record store. Records live as JSON under `state/releases/`.
 * Reads validate against the schema (the projection is never trusted blindly —
 * invariant #1); writes validate before persisting so an invalid record can never
 * land on disk.
 *
 * `appendTransition` is idempotent on the `(release_id + transition)` dedup key
 * (invariant #3) — re-applying the same transition is a no-op. The M2 reconcile loop
 * relies on exactly this to produce zero duplicate transitions across re-runs.
 */

export function releasePath(stateDir: string, releaseId: string): string {
  return join(stateDir, "releases", `${releaseId}.json`);
}

/** Discover all release ids under `state/releases/` (sorted). */
export function scanReleaseIds(stateDir: string): string[] {
  const dir = join(stateDir, "releases");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => f.slice(0, -".json".length))
    .sort();
}

export function readRelease(stateDir: string, releaseId: string): Release | null {
  const path = releasePath(stateDir, releaseId);
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, "utf8"));
  return ReleaseSchema.parse(raw); // validate the projection on the way in
}

export function writeRelease(stateDir: string, release: Release): void {
  const validated = ReleaseSchema.parse(release); // never persist an invalid record
  const path = releasePath(stateDir, release.release_id);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

/**
 * True if the release's most recently *recorded* transition is already `to` — i.e. this
 * is a double-fire. A fresh record (no transitions yet) is not "in" any state, so its very
 * first transition always records, even when it targets the initial `tagged` state.
 */
export function isCurrentState(release: Release, to: ReleaseState): boolean {
  return release.transitions.length > 0 && release.transitions[release.transitions.length - 1]!.to === to;
}

/**
 * Append a transition idempotently. A transition is a duplicate iff the release is
 * already in the target state (`release.state === to`) — that catches double-fires
 * (re-poll, CI retry, late webhook) while still allowing a *legitimate re-entry* into a
 * state already visited earlier (the `rejected → in_review` resubmit loop, the
 * `rolled_back → live` re-flip loop). Re-entries get an attempt-qualified dedup key.
 */
export function appendTransition(
  release: Release,
  to: ReleaseState,
  by: string,
  now: () => string,
): Release {
  if (isCurrentState(release, to)) return release;
  const attempt = release.transitions.filter((t) => t.to === to).length + 1;
  return {
    ...release,
    state: to,
    transitions: [
      ...release.transitions,
      { to, at: now(), by, dedup_key: dedupKey(release.release_id, to, attempt) },
    ],
  };
}

/** A fresh release record for a tag, before it is bound to a launch (M4). */
export function newRelease(args: {
  releaseId: string;
  app: string;
  surface: Release["surface"];
  version: string;
}): Release {
  return {
    release_id: args.releaseId,
    launch_id: null,
    app: args.app,
    surface: args.surface,
    version: args.version,
    state: "tagged",
    flag: null,
    changelog: [],
    external_refs: {},
    transitions: [],
  };
}
