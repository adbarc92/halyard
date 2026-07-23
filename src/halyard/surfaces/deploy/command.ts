import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `command` — the generic escape-hatch target. An operator-configured `deploy.command`
 * shell string is run via `runner.run` (config strings are operator-trusted and may use
 * shell features), with `previewUrl` taken from the optional `deploy.url`. Surface-agnostic
 * (no `surfaces`), so it gives every app a launch path immediately, before its specific
 * provider lands.
 *
 * This is the ONE provider where the shell is correct: `command` is an operator-config
 * string, not a runtime value. Never log or interpolate a secret — `gh`/`wrangler`-style
 * credentials are read from the environment at runtime by the command itself.
 */
export const commandProvider: DeployProvider = {
  target: "command",
  configSchema: z
    .object({
      target: z.literal("command"),
      command: z.string().min(1),
      url: z.string().url().optional(),
    })
    .strict(),

  async deploy(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { command: cmd, url } = cfg as { command: string; url?: string };
    ctx.log(`[${ctx.surface}] deploy: ${cmd}`);
    const command = await ctx.runner.run(cmd, { cwd: ctx.workdir });
    const previewUrl = url ?? "";
    return {
      ok: command.exitCode === 0,
      previewUrl,
      details: { target: "command", exitCode: command.exitCode },
    };
  },
};
