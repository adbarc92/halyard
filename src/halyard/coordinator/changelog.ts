import type { CommandRunner } from "../surfaces/types.js";

/**
 * Populate a release's changelog from Conventional Commits since the previous tag for the
 * same surface (design §3/§4: `changelog: { source: conventional_commits, since: last_tag }`).
 * Best-effort: if git isn't available or there's no history, returns [] rather than failing
 * the release.
 *
 * The git invocations interpolate only trusted values — the surface (validated upstream
 * against the four known surfaces) and our own tags (matched by the surface glob) — so the
 * shell `run` path is safe here.
 */
export interface ChangelogInput {
  runner: CommandRunner;
  workdir: string;
  app: string;
  surface: string;
  version: string;
  tagPattern: string; // e.g. "{surface}-v{version}" or "{app}-{surface}-v{version}"
}

// A Conventional Commit subject: `type(scope)!: summary`.
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?:\s/;

export async function collectChangelog(input: ChangelogInput): Promise<string[]> {
  const { runner, workdir, app, surface, version, tagPattern } = input;
  const expand = (v: string) =>
    tagPattern.replace("{app}", app).replace("{surface}", surface).replace("{version}", v);
  const glob = expand("*"); // e.g. web-v*
  const currentTag = expand(version); // e.g. web-v2025.06.06

  // Most-recent-first tags for this surface; the previous one bounds "since last_tag".
  const tagsRes = await runner.run(`git tag --list "${glob}" --sort=-creatordate`, { cwd: workdir });
  if (tagsRes.exitCode !== 0) return [];
  const tags = tagsRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  const prevTag = tags.find((t) => t !== currentTag);

  const range = prevTag ? `${prevTag}..HEAD` : "HEAD";
  const logRes = await runner.run(`git log ${range} --no-merges --pretty=format:%s`, { cwd: workdir });
  if (logRes.exitCode !== 0) return [];

  return logRes.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => CONVENTIONAL.test(s));
}
