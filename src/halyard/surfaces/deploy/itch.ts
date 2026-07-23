import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `itch` (desktop) — push the build output to an itch.io channel via the `butler` CLI.
 * `butler` reads BUTLER_API_KEY from the environment at runtime (injected by the workflow
 * from secrets); it is never written to config and never read/logged here. The push target
 * and output directory are runtime values, so they go through `runner.runArgv` with an
 * explicit argv and NO shell (invariant: runtime values never touch a shell).
 */
export const itchProvider: DeployProvider = {
  target: "itch",
  surfaces: ["desktop"],
  configSchema: z
    .object({
      target: z.literal("itch"),
      user: z.string().min(1), // itch.io account, e.g. "example"
      game: z.string().min(1), // project slug under that account
      channel: z.string().min(1), // e.g. "win", "osx", "linux"
    })
    .strict(),

  async deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { user, game, channel } = cfg as { user: string; game: string; channel: string };
    const pushTarget = `${user}/${game}:${channel}`;
    const args = ["push", build.outputDir, pushTarget];
    ctx.log(`[desktop] deploy: butler ${args.join(" ")}`);
    const command = await ctx.runner.runArgv("butler", args, { cwd: ctx.workdir });
    const ok = command.exitCode === 0;
    return {
      ok,
      previewUrl: `https://${user}.itch.io/${game}`,
      details: { target: "itch", channel: pushTarget, exitCode: command.exitCode },
      externalRefs: ok ? { itch_channel: pushTarget } : {},
    };
  },
};
