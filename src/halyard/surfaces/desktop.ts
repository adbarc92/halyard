import { resolve } from "node:path";
import { getDeployProvider } from "./deploy/registry.js";
import { getSigningStep } from "./signing/index.js";
import type {
  BuildResult,
  DeployResult,
  ReleaseContext,
  SurfaceAdapter,
  TestResult,
} from "./types.js";

/**
 * Desktop surface adapter (Tauri). Build/test are configured shell commands (a
 * `tauri build` and a test command). When `desktop.signing.enabled`, a platform signing
 * step runs between build and deploy (macOS notarize+staple now; Windows Authenticode built
 * but disabled by default per the 2026-07-08 portfolio decision). Deploy then delegates to
 * the provider named by `desktop.deploy.target` (GitHub Releases, a local dir, or any
 * registered provider).
 *
 * Like every surface, deploy lands the release at `uploaded`: a built-and-distributed
 * artifact resting until the flag flip projects it to `live`. The adapter never decides
 * pass/fail — it reports an exit code and lets the deterministic gate adjudicate
 * (invariant #2).
 */
export class DesktopSurfaceAdapter implements SurfaceAdapter {
  readonly surface = "desktop" as const;

  private desktopConfig(ctx: ReleaseContext) {
    const desktop = ctx.app.surfaces.desktop;
    if (!desktop || !desktop.enabled) {
      throw new Error(`desktop surface is not enabled for app "${ctx.app.app.slug}"`);
    }
    return desktop;
  }

  async build(ctx: ReleaseContext): Promise<BuildResult> {
    const desktop = this.desktopConfig(ctx);
    ctx.log(`[desktop] build: ${desktop.build.command}`);
    const command = await ctx.runner.run(desktop.build.command, { cwd: ctx.workdir });
    const outputDir = resolve(ctx.workdir, desktop.build.output_dir);
    return { ok: command.exitCode === 0, outputDir, command };
  }

  async test(ctx: ReleaseContext): Promise<TestResult> {
    const desktop = this.desktopConfig(ctx);
    ctx.log(`[desktop] test: ${desktop.test.command}`);
    const command = await ctx.runner.run(desktop.test.command, { cwd: ctx.workdir });
    return { exitCode: command.exitCode, command };
  }

  async deploy(ctx: ReleaseContext, build: BuildResult): Promise<DeployResult> {
    const desktop = this.desktopConfig(ctx);

    // Pre-deploy signing (between build and deploy) when the app opts in. Off by default.
    let signed = build;
    const signing = desktop.signing;
    if (signing?.enabled) {
      ctx.log(`[desktop] signing (${signing.platform})`);
      signed = await getSigningStep(signing.platform).sign(ctx, build, signing);
    }

    const target = String((desktop.deploy as { target: string }).target);
    return getDeployProvider(target).deploy(ctx, signed, desktop.deploy);
  }
}
