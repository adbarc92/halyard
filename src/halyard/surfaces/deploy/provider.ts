import type { z } from "zod";
import type { Surface } from "../../config/primitives.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * A deploy provider is the pluggable seam behind each surface's `deploy()`. The old
 * closed `z.discriminatedUnion("target", …)` per surface is replaced by a registry of
 * providers keyed on the `deploy.target` discriminator; adding a target = adding a
 * provider module, never editing the registry or another provider.
 *
 * Providers never decide ship/promote/flip (invariant #2): they run a command and report
 * a `DeployResult`; the deterministic gates + human flag-flip adjudicate. Runtime values
 * always go through `runner.runArgv` (no shell); only operator-config strings use
 * `runner.run`. Secrets are read from the environment at runtime — a provider never writes
 * or logs a credential.
 */
export interface DeployProvider {
  /** The discriminator used in an app's `deploy.target`. */
  readonly target: string;
  /** Provider-specific config fields, validated by the registry at config-load time.
   *  Keep it `.strict()` so a typo'd field fails loudly (the house style). */
  readonly configSchema: z.ZodTypeAny;
  /** Surfaces this provider is valid for; omit for surface-agnostic providers
   *  (`local_dir`, generic `command`). Preserves the per-surface constraint the old
   *  closed unions enforced (cloudflare_pages → web, github_releases → desktop). */
  readonly surfaces?: readonly Surface[];
  /** Deploy the built artifact. `cfg` is the validated `deploy` block for this app. */
  deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult>;
}
