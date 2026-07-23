import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `vercel` (web) — `vercel deploy --prod --yes`. The `vercel` CLI reads `VERCEL_TOKEN`
 * from the environment at runtime (injected by the workflow from secrets); it is never
 * written to config and never passed as a flag. Run with an explicit argv and NO shell —
 * outputDir/project are runtime values and must not be interpretable as shell
 * metacharacters (invariant: runtime values go through runArgv).
 */
export const vercelProvider: DeployProvider = {
  target: "vercel",
  surfaces: ["web"],
  configSchema: z
    .object({
      target: z.literal("vercel"),
      // Optional — Vercel infers the project from the linked dir; kept for `--project`.
      project: z.string().min(1).optional(),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { project } = cfg as { project?: string };
    const args = [
      "deploy",
      "--prod",
      "--yes",
      "--cwd",
      build.outputDir,
      ...(project ? ["--project", project] : []),
    ];
    ctx.log(`[web] deploy: vercel ${args.join(" ")}`);
    const command = await ctx.runner.runArgv("vercel", args, { cwd: ctx.workdir });
    const previewUrl = extractVercelUrl(command.stdout);
    return {
      ok: command.exitCode === 0 && previewUrl !== "",
      previewUrl,
      details: { target: "vercel", exitCode: command.exitCode },
    };
  },
};

/**
 * Pull the production URL Vercel prints on deploy, e.g.
 * `https://aurora-web-abc123.vercel.app`. Prefer a `*.vercel.app` URL; otherwise fall back
 * to the first https(s) URL on its own line. Returns "" when no URL is present.
 */
export function extractVercelUrl(stdout: string): string {
  const vercelApp = stdout.match(/https?:\/\/[^\s]+\.vercel\.app[^\s]*/);
  if (vercelApp) return vercelApp[0];
  const anyHttps = stdout.match(/https?:\/\/[^\s]+/);
  return anyHttps?.[0] ?? "";
}
