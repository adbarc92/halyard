import { z } from "zod";
import type { DeployProvider } from "./provider.js";
import type { BuildResult, DeployResult, ReleaseContext } from "../types.js";

/**
 * `github_pages` (web) — publish the build output to GitHub Pages via the `gh` CLI.
 * The site content is assumed committed/uploaded by the build step; the deterministic
 * deploy action is triggering a Pages build (`gh api --method POST repos/<repo>/pages/builds`).
 * `gh` reads GITHUB_TOKEN/GH_TOKEN from env at runtime (injected by the workflow from
 * secrets); a token is never read from or written to config, and no credential is logged.
 * Runtime values go through `runner.runArgv` (NO shell).
 */
export const githubPagesProvider: DeployProvider = {
  target: "github_pages",
  surfaces: ["web"],
  configSchema: z
    .object({
      target: z.literal("github_pages"),
      repo: z.string().min(1), // "owner/name" the Pages site is published from
      branch: z.string().min(1).optional(), // publishing branch, default gh-pages
    })
    .strict(),

  async deploy(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    const { repo } = cfg as { repo: string; branch?: string };
    const url = pagesUrl(repo);
    const args = ["api", "--method", "POST", `repos/${repo}/pages/builds`];
    ctx.log(`[web] deploy: gh ${args.join(" ")} → ${url}`);
    const command = await ctx.runner.runArgv("gh", args, { cwd: ctx.workdir });
    const ok = command.exitCode === 0;
    return {
      ok,
      previewUrl: url,
      details: { target: "github_pages", repo, exitCode: command.exitCode },
      externalRefs: ok ? { github_pages_repo: repo } : {},
    };
  },
};

/**
 * Compute the public Pages URL from an `owner/name` repo:
 *   - `owner/repo`            → `https://owner.github.io/repo`
 *   - `owner/owner.github.io` → `https://owner.github.io` (the user/org root site)
 */
export function pagesUrl(repo: string): string {
  const [owner, name] = repo.split("/");
  const root = `https://${owner}.github.io`;
  return name === `${owner}.github.io` ? root : `${root}/${name}`;
}
