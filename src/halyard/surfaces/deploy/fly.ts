import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `fly` (web) — `flyctl deploy --app <app>`. flyctl reads FLY_API_TOKEN from the env at
 * runtime (injected by the workflow from secrets, exactly like wrangler reads
 * CLOUDFLARE_API_TOKEN); it is never written to or read from config, and never logged.
 * Runtime values (the app name, optional config path) go through `runner.runArgv` with NO
 * shell (invariant: runtime values never touch a shell).
 */
export const flyProvider: DeployProvider = {
  target: "fly",
  surfaces: ["web"],
  configSchema: z
    .object({
      target: z.literal("fly"),
      app: z.string().min(1),
      config: z.string().min(1).optional(),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { app, config } = cfg as { app: string; config?: string };
    const args = ["deploy", "--app", app, ...(config ? ["--config", config] : [])];
    ctx.log(`[web] deploy: flyctl ${args.join(" ")}`);
    const command = await ctx.runner.runArgv("flyctl", args, { cwd: ctx.workdir });
    // Prefer a URL flyctl printed; otherwise fall back to Fly's default hostname.
    const previewUrl = extractFlyUrl(command.stdout) ?? `https://${app}.fly.dev`;
    const ok = command.exitCode === 0;
    return {
      ok,
      previewUrl,
      details: { target: "fly", app, exitCode: command.exitCode },
      externalRefs: ok ? { fly_app: app } : {},
    };
  },
};

/** Pull a deployment URL flyctl prints, e.g. https://my-app.fly.dev */
function extractFlyUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/[^\s]+\.fly\.dev[^\s]*/);
  return match?.[0];
}
