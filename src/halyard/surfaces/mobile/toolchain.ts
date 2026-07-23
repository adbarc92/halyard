import type { BuildResult, DeployResult, ReleaseContext, TestResult } from "../types.js";

/**
 * A mobile toolchain is the pluggable seam behind the iOS/Android adapters' build/test/
 * submit. `"match"` (fastlane, the pre-existing path) and `"eas"` (Expo Application
 * Services) implement the same interface; an app selects one via `surfaces.<ios|android>.
 * toolchain` (default `"match"`).
 *
 * Like every adapter path, `submit` lands the release at `uploaded` and never decides
 * pass/fail (invariant #2) — it reports a `DeployResult` and the gates + flag-flip
 * adjudicate. Secrets are read from the environment at runtime; a toolchain never writes or
 * logs a credential (invariant #4).
 */
export interface MobileToolchain {
  readonly name: string;
  build(ctx: ReleaseContext, cfg: unknown): Promise<BuildResult>;
  test(ctx: ReleaseContext, cfg: unknown): Promise<TestResult>;
  submit(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult>;
}
