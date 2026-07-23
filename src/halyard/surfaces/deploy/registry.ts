import type { Surface } from "../../config/primitives.js";
import type { DeployProvider } from "./provider.js";
import { localDirProvider } from "./local-dir.js";
import { cloudflarePagesProvider } from "./cloudflare.js";
import { githubReleasesProvider } from "./github-releases.js";
import { commandProvider } from "./command.js";
import { vercelProvider } from "./vercel.js";
import { flyProvider } from "./fly.js";
import { githubPagesProvider } from "./github-pages.js";
import { itchProvider } from "./itch.js";
import { awsProvider } from "./aws.js";

/**
 * Deploy-provider registry — the single place that maps a `deploy.target` discriminator to
 * its provider. Each provider lives in its own module (filled by its own lane); adding a
 * target means adding a module here, never editing another provider. The three pre-registry
 * targets (`local_dir`, `cloudflare_pages`, `github_releases`) plus the fresh provider lanes
 * are all registered here; unimplemented ones ship as stubs whose `deploy()` throws until
 * their lane lands (they never run for an app that doesn't opt into them).
 */
const PROVIDERS: readonly DeployProvider[] = [
  // Pre-registry targets (ported from web.ts / desktop.ts — must not regress).
  localDirProvider,
  cloudflarePagesProvider,
  githubReleasesProvider,
  // Provider lanes (L1–L6). Stubs until their lane fills them.
  commandProvider,
  vercelProvider,
  flyProvider,
  githubPagesProvider,
  itchProvider,
  awsProvider,
];

const REGISTRY: ReadonlyMap<string, DeployProvider> = new Map(
  PROVIDERS.map((p) => [p.target, p] as const),
);

/** All registered deploy targets (for diagnostics / error messages). */
export function deployTargets(): string[] {
  return [...REGISTRY.keys()];
}

/** Resolve a provider by target, or throw a message naming the known targets. */
export function getDeployProvider(target: string): DeployProvider {
  const provider = REGISTRY.get(target);
  if (!provider) {
    throw new Error(
      `unknown deploy target "${target}" — known targets: ${deployTargets().join(", ")}`,
    );
  }
  return provider;
}

/**
 * Validate a `deploy` config block for a surface at config-load time. Enforces:
 *  1. the target is registered,
 *  2. the target is valid for this surface (preserving the old closed-union constraint —
 *     e.g. `cloudflare_pages` is web-only, `github_releases` is desktop-only),
 *  3. the provider-specific fields parse against the provider's `configSchema`.
 * Returns the parsed config, or throws an Error whose message the schema layer surfaces.
 */
export function validateDeployConfig(surface: Surface, cfg: unknown): unknown {
  const target =
    cfg && typeof cfg === "object" && "target" in cfg
      ? String((cfg as { target: unknown }).target)
      : undefined;
  if (!target) {
    throw new Error("deploy.target is required");
  }
  const provider = getDeployProvider(target);
  if (provider.surfaces && !provider.surfaces.includes(surface)) {
    throw new Error(
      `deploy target "${target}" is not valid for the ${surface} surface ` +
        `(valid: ${provider.surfaces.join(", ")})`,
    );
  }
  return provider.configSchema.parse(cfg);
}
