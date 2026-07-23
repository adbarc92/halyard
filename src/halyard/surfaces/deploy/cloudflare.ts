import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `cloudflare_pages` (web) — `npx wrangler pages deploy`. wrangler reads
 * CLOUDFLARE_API_TOKEN / _ACCOUNT_ID from env at runtime (injected by the workflow from
 * secrets); they are never written to config. Run with an explicit argv and NO shell —
 * outputDir/project/commit are runtime values and must not be interpretable as shell
 * metacharacters (invariant: runtime values go through runArgv).
 */
export const cloudflarePagesProvider: DeployProvider = {
  target: "cloudflare_pages",
  surfaces: ["web"],
  configSchema: z
    .object({
      target: z.literal("cloudflare_pages"),
      project: z.string().min(1),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { project } = cfg as { project: string };
    const args = [
      "--yes", "wrangler", "pages", "deploy", build.outputDir,
      "--project-name", project,
      "--branch", ctx.commit,
      "--commit-hash", ctx.commit,
    ];
    ctx.log(`[web] deploy: npx ${args.join(" ")}`);
    const command = await ctx.runner.runArgv("npx", args, { cwd: ctx.workdir });
    const previewUrl = extractPagesUrl(command.stdout) ?? "";
    return {
      ok: command.exitCode === 0 && previewUrl !== "",
      previewUrl,
      details: { target: "cloudflare_pages", project, exitCode: command.exitCode },
    };
  },
};

/** Pull the deployment URL wrangler prints, e.g. https://abc123.aurora-web.pages.dev */
function extractPagesUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/[^\s]+\.pages\.dev[^\s]*/);
  return match?.[0];
}
