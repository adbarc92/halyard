import type { AppConfig } from "../config/app-config.schema.js";
import type { Surface } from "../config/primitives.js";
import type { Release } from "../contracts/release.schema.js";
import { getAdapter } from "../surfaces/index.js";
import type { CommandRunner, ReleaseContext } from "../surfaces/types.js";
import { buildGate, testGate } from "./gates.js";
import { appendTransition, newRelease } from "./record-store.js";
import type { Backend } from "./ports.js";
import { applyTransition } from "./state-machine.js";
import { collectChangelog } from "./changelog.js";

/**
 * The release runner is the spine the workflow invokes (M1). It is surface-agnostic:
 * it drives the common adapter interface and lets the deterministic gates decide each
 * transition. Every step is written to disk and is idempotent on the dedup key, so a
 * re-run (CI retry, replay) converges rather than duplicating.
 *
 * For web the happy path is tagged → built → tested → uploaded, where `uploaded` is a
 * deployed preview awaiting the promote/flag-flip (M4). A failed build/test ends at
 * `dead` and never deploys.
 */

export interface RunReleaseInput {
  app: AppConfig;
  surface: Surface;
  version: string;
  commit: string;
  backend: Backend;
  workdir: string;
  runner: CommandRunner;
  now: () => string;
  log?: (message: string) => void;
}

export function releaseIdFor(slug: string, surface: Surface, version: string): string {
  return `rel_${slug}_${surface}_${version}`;
}

/**
 * A release *run* succeeded if it advanced to a deployed-or-beyond state. A build/test
 * failure (`dead`) or a deploy failure (stuck at `tested`, never claiming `uploaded`) is
 * NOT a success — the CLI maps this to its exit code so a failed deploy turns the job red
 * instead of showing a misleading green check (no reconcile source re-runs a deploy).
 */
const DEPLOYED_OR_BEYOND: ReadonlySet<Release["state"]> = new Set([
  "uploaded",
  "in_review",
  "shipped_dark",
  "live",
  "rolled_back",
]);
export function releaseSucceeded(state: Release["state"]): boolean {
  return DEPLOYED_OR_BEYOND.has(state);
}

export async function runRelease(input: RunReleaseInput): Promise<Release> {
  const log = input.log ?? (() => {});
  const slug = input.app.app.slug;
  const releaseId = releaseIdFor(slug, input.surface, input.version);

  const persist = async (release: Release): Promise<Release> => {
    await input.backend.records.write(release);
    return release;
  };

  // Load an existing record (replay-safe) or create a fresh one at `tagged`.
  let release =
    (await input.backend.records.read(releaseId)) ??
    newRelease({ releaseId, app: slug, surface: input.surface, version: input.version });

  // Populate the changelog from Conventional Commits since the last tag (best-effort;
  // only on a fresh record, so a re-run doesn't rewrite it).
  if (release.changelog.length === 0) {
    try {
      const changelog = await collectChangelog({
        runner: input.runner,
        workdir: input.workdir,
        app: slug,
        surface: input.surface,
        version: input.version,
        tagPattern: input.app.version_scheme.tag_pattern,
      });
      if (changelog.length > 0) release = { ...release, changelog };
    } catch {
      // Changelog is informational — never fail a release over it.
    }
  }

  // Genesis: record the initial `tagged` only on a fresh record — there is no `→ tagged`
  // edge, so this is the one transition appended directly rather than via applyTransition.
  if (release.transitions.length === 0) {
    release = await persist(appendTransition(release, "tagged", "ci", input.now));
  }
  log(`[${releaseId}] tagged @ ${input.commit}`);

  // Advance through the legal edge, persisting only on a real move. On a re-run, a
  // backward target (re-applying built/tested from uploaded) is illegal → a no-op, so the
  // whole runner is idempotent without re-recording past steps.
  const advance = async (to: Release["state"]): Promise<void> => {
    const outcome = applyTransition(release, to, "ci", input.now);
    if (outcome.applied) release = await persist(outcome.release);
  };

  const adapter = getAdapter(input.surface);
  const ctx: ReleaseContext = {
    app: input.app,
    surface: input.surface,
    releaseId,
    version: input.version,
    commit: input.commit,
    workdir: input.workdir,
    runner: input.runner,
    log,
  };

  // Build → buildGate.
  const build = await adapter.build(ctx);
  const buildDecision = buildGate(build.ok);
  await advance(buildDecision.to);
  if (!buildDecision.pass) {
    log(`[${releaseId}] DEAD — ${buildDecision.reason}`);
    return release;
  }

  // Test → deterministic testGate.
  const test = await adapter.test(ctx);
  const testDecision = testGate(test);
  await advance(testDecision.to);
  if (!testDecision.pass) {
    log(`[${releaseId}] DEAD — ${testDecision.reason}`);
    return release; // gate failed: never deploy
  }

  // Deploy → record the preview and land at `uploaded`.
  const deploy = await adapter.deploy(ctx, build);
  release = {
    ...release,
    external_refs: {
      ...release.external_refs,
      commit_sha: input.commit,
      preview_url: deploy.previewUrl,
      deploy_target: String(deploy.details.target ?? ""),
      ...(deploy.externalRefs ?? {}),
    },
  };
  if (!deploy.ok) {
    // Deploy failed after a green build+test. Persist the refs we have and stop before
    // claiming `uploaded`; the coordinator (M2) will retry on the next reconcile.
    await persist(release);
    log(`[${releaseId}] deploy failed; left at ${release.state}`);
    return release;
  }
  await advance("uploaded");
  log(`[${releaseId}] uploaded — preview ${deploy.previewUrl}`);
  return release;
}
