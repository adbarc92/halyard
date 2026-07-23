// src/halyard/coordinator/auto-promote.ts
import type { AppConfig } from "../config/app-config.schema.js";
import type { Surface } from "../config/primitives.js";
import type { Release } from "../contracts/release.schema.js";
import { autoPromoteFlagKey } from "../flags/naming.js";
import { makeFlagClient } from "../flags/select.js";
import type { Backend } from "./ports.js";
import { reconcile } from "./reconcile.js";
import { flagPollSource } from "./sources/flag-poll.js";

/**
 * Web auto-promote (`promote_gate: false`). For a STANDALONE web release that has actually deployed
 * (at `uploaded`, no launch, no flag), create its per-version flag **born ON** (a single
 * `setState`, no born-OFF window) and run a scoped flag-poll reconcile so it reaches `live` on
 * deploy. Rollback is the normal `flip … off → rolled_back`; a redeploy is a no-op (the `flag`
 * guard). Any non-matching case is a no-op returning the input release unchanged.
 *
 * Lives at the CLI release-path layer (not a reconcile source — invariant #1 keeps sources
 * read-only; not in `runRelease` — that stays surface-agnostic).
 */
export async function autoPromoteWebRelease(opts: {
  release: Release;
  app: AppConfig;
  surface: Surface;
  stateDir: string;
  backend: Backend;
  now: () => string;
}): Promise<Release> {
  const { release, app, surface, stateDir, backend, now } = opts;
  if (
    surface !== "web" ||
    app.surfaces.web?.promote_gate !== false ||
    release.state !== "uploaded" ||
    release.launch_id !== null ||
    release.flag !== null
  ) {
    return release; // not an auto-promote case
  }

  const flag = autoPromoteFlagKey(app.app.slug, release.version);
  const client = makeFlagClient([app], stateDir, now); // single app in scope; reused by the inline reconcile
  await client.setState(flag, true); // create-or-update in one write — born ON
  await backend.records.write({ ...release, flag });

  // Inline, scoped, flag-poll-only projection so the release is live ON DEPLOY (releaseRun does not
  // otherwise reconcile). Reuses the SAME client we wrote to, so the projection is consistent.
  await reconcile({
    backend,
    sources: [flagPollSource(client)],
    now,
    loadReleaseIds: () => [release.release_id],
  });
  return (await backend.records.read(release.release_id)) ?? { ...release, flag };
}
