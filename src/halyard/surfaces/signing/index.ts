import type { BuildResult, ReleaseContext } from "../types.js";

/**
 * The desktop pre-deploy signing seam. When `desktop.signing.enabled`, the desktop adapter
 * runs the platform's `SigningStep` between build and deploy: it takes the build output,
 * signs/notarizes it, and returns a (possibly updated) `BuildResult` that then flows to the
 * deploy provider.
 *
 * Portfolio decision (2026-07-08): macOS notarization runs now; **Windows Authenticode is
 * built but ships disabled by default** — the signing block defaults `enabled:false`, so no
 * signing runs unless an app opts in. Secrets (Apple creds, Windows cert) are `SECRET:`
 * refs resolved to env at runtime; a signer never writes or logs a credential (invariant #4).
 */
export interface SigningStep {
  readonly platform: "macos" | "windows";
  sign(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<BuildResult>;
}

import { macosSigningStep } from "./macos.js";
import { windowsSigningStep } from "./windows.js";

const REGISTRY: ReadonlyMap<string, SigningStep> = new Map(
  [macosSigningStep, windowsSigningStep].map((s) => [s.platform, s] as const),
);

/** Resolve the signer for a platform, or throw naming the known platforms. */
export function getSigningStep(platform: "macos" | "windows"): SigningStep {
  const step = REGISTRY.get(platform);
  if (!step) {
    throw new Error(
      `unknown signing platform "${platform}" — known: ${[...REGISTRY.keys()].join(", ")}`,
    );
  }
  return step;
}
