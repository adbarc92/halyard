import { getMobileToolchain } from "./mobile/registry.js";
import type {
  BuildResult,
  DeployResult,
  ReleaseContext,
  SurfaceAdapter,
  TestResult,
} from "./types.js";

/**
 * Android surface adapter. Build/test/deploy delegate to the mobile toolchain named by
 * `surfaces.android.toolchain` (`match` = fastlane/gradle, the default; `eas` = Expo
 * Application Services). Deploy lands the release at `uploaded`; on a production track the
 * Play review poll drives uploaded → in_review → shipped_dark, otherwise the flag-poll
 * projects the flip to `live`.
 *
 * The adapter never decides pass/fail (invariant #2) and never logs credentials
 * (invariant #4) — the toolchain reports exit codes; the gates adjudicate.
 */
export class AndroidSurfaceAdapter implements SurfaceAdapter {
  readonly surface = "android" as const;

  private androidConfig(ctx: ReleaseContext) {
    const android = ctx.app.surfaces.android;
    if (!android || !android.enabled) {
      throw new Error(`android surface is not enabled for app "${ctx.app.app.slug}"`);
    }
    return android;
  }

  async build(ctx: ReleaseContext): Promise<BuildResult> {
    const android = this.androidConfig(ctx);
    return getMobileToolchain(android.toolchain).build(ctx, android);
  }

  async test(ctx: ReleaseContext): Promise<TestResult> {
    const android = this.androidConfig(ctx);
    return getMobileToolchain(android.toolchain).test(ctx, android);
  }

  async deploy(ctx: ReleaseContext, build: BuildResult): Promise<DeployResult> {
    const android = this.androidConfig(ctx);
    return getMobileToolchain(android.toolchain).submit(ctx, build, android);
  }
}
