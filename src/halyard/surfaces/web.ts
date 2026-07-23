import { resolve } from "node:path";
import { getDeployProvider } from "./deploy/registry.js";
import type {
  BuildResult,
  DeployResult,
  ReleaseContext,
  SurfaceAdapter,
  TestResult,
} from "./types.js";

/**
 * Web surface adapter (M1). Build/test are configured shell commands; deploy delegates to
 * the deploy provider named by `web.deploy.target` (Cloudflare Pages, a local dir, or any
 * registered provider). The provider seam replaced the old closed deploy union — the
 * adapter stays surface-agnostic about *how* deploy happens.
 *
 * The adapter never decides pass/fail — it reports an exit code and lets the deterministic
 * gate adjudicate (invariant #2).
 */
export class WebSurfaceAdapter implements SurfaceAdapter {
  readonly surface = "web" as const;

  private webConfig(ctx: ReleaseContext) {
    const web = ctx.app.surfaces.web;
    if (!web || !web.enabled) {
      throw new Error(`web surface is not enabled for app "${ctx.app.app.slug}"`);
    }
    return web;
  }

  async build(ctx: ReleaseContext): Promise<BuildResult> {
    const web = this.webConfig(ctx);
    ctx.log(`[web] build: ${web.build.command}`);
    const command = await ctx.runner.run(web.build.command, { cwd: ctx.workdir });
    const outputDir = resolve(ctx.workdir, web.build.output_dir);
    return { ok: command.exitCode === 0, outputDir, command };
  }

  async test(ctx: ReleaseContext): Promise<TestResult> {
    const web = this.webConfig(ctx);
    ctx.log(`[web] test: ${web.test.command}`);
    const command = await ctx.runner.run(web.test.command, { cwd: ctx.workdir });
    return { exitCode: command.exitCode, command };
  }

  async deploy(ctx: ReleaseContext, build: BuildResult): Promise<DeployResult> {
    const web = this.webConfig(ctx);
    const target = String((web.deploy as { target: string }).target);
    return getDeployProvider(target).deploy(ctx, build, web.deploy);
  }
}
