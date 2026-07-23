import { getMobileToolchain } from "./mobile/registry.js";
import type {
  BuildResult,
  DeployResult,
  ReleaseContext,
  SurfaceAdapter,
  TestResult,
} from "./types.js";

/**
 * iOS surface adapter (M3). Build/test/deploy delegate to the mobile toolchain named by
 * `surfaces.ios.toolchain` (`match` = fastlane, the default; `eas` = Expo Application
 * Services). The adapter stays a thin surface guard; the toolchain owns the fastlane/EAS
 * mechanics. Deploy lands the release at `uploaded`; the App Store review poll (a reconcile
 * source) drives uploaded → in_review → shipped_dark.
 *
 * The adapter never decides pass/fail (invariant #2) and never logs credentials
 * (invariant #4) — the toolchain reports exit codes; the gates adjudicate.
 */
export class IosSurfaceAdapter implements SurfaceAdapter {
  readonly surface = "ios" as const;

  private iosConfig(ctx: ReleaseContext) {
    const ios = ctx.app.surfaces.ios;
    if (!ios || !ios.enabled) {
      throw new Error(`ios surface is not enabled for app "${ctx.app.app.slug}"`);
    }
    return ios;
  }

  async build(ctx: ReleaseContext): Promise<BuildResult> {
    const ios = this.iosConfig(ctx);
    return getMobileToolchain(ios.toolchain).build(ctx, ios);
  }

  async test(ctx: ReleaseContext): Promise<TestResult> {
    const ios = this.iosConfig(ctx);
    return getMobileToolchain(ios.toolchain).test(ctx, ios);
  }

  async deploy(ctx: ReleaseContext, build: BuildResult): Promise<DeployResult> {
    const ios = this.iosConfig(ctx);
    return getMobileToolchain(ios.toolchain).submit(ctx, build, ios);
  }
}
