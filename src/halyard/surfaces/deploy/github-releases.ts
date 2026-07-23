import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `github_releases` (desktop) — publish the build output as an artifact attached to a
 * tagged GitHub Release via the `gh` CLI. `gh` reads GITHUB_TOKEN/GH_TOKEN from env at
 * runtime (injected by the workflow from secrets); it is never written to config. Run with
 * an explicit argv and NO shell — the tag and artifact path are runtime values and must not
 * be interpretable as shell (invariant: runtime values go through runArgv).
 */
export const githubReleasesProvider: DeployProvider = {
  target: "github_releases",
  surfaces: ["desktop"],
  configSchema: z
    .object({
      target: z.literal("github_releases"),
      repo: z.string().min(1), // "owner/name" the release is published to
      tag_pattern: z.string().min(1), // e.g. "desktop-v{version}"
    })
    .strict(),

  async deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { repo, tag_pattern } = cfg as { repo: string; tag_pattern: string };
    const tag = renderTag(tag_pattern, ctx.version);
    const args = [
      "release", "create", tag,
      build.outputDir,
      "--repo", repo,
      "--title", tag,
      "--notes", `Desktop release ${ctx.version} (${ctx.commit})`,
    ];
    ctx.log(`[desktop] deploy: gh ${args.join(" ")}`);
    const command = await ctx.runner.runArgv("gh", args, { cwd: ctx.workdir });
    const ok = command.exitCode === 0;
    const previewUrl = ok ? extractReleaseUrl(command.stdout) ?? "" : "";
    return {
      ok,
      previewUrl,
      details: { target: "github_releases", repo, tag, exitCode: command.exitCode },
      externalRefs: ok ? { github_release_tag: tag, github_repo: repo } : {},
    };
  },
};

/** Substitute `{version}` (and `{surface}`) into the configured tag pattern, e.g.
 * "desktop-v{version}" → "desktop-v1.4.0". Kept deliberately simple. */
function renderTag(pattern: string, version: string): string {
  return pattern.replace(/\{version\}/g, version).replace(/\{surface\}/g, "desktop");
}

/** `gh release create` prints the release URL on success, e.g.
 * https://github.com/owner/repo/releases/tag/desktop-v1.4.0 */
function extractReleaseUrl(stdout: string): string | undefined {
  const match = stdout.match(/https?:\/\/[^\s]+\/releases\/tag\/[^\s]+/);
  return match?.[0];
}
