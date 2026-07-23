import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { collectChangelog } from "../src/halyard/coordinator/changelog.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

const base = { runner: undefined as never, workdir: "/tmp/aurora", app: "aurora", surface: "web", version: "2025.06.06", tagPattern: "{surface}-v{version}" };

describe("collectChangelog: Conventional Commits since the previous surface tag", () => {
  it("ranges from the previous tag and keeps only conventional subjects", async () => {
    const runner = new FakeCommandRunner([
      { match: "git tag", stdout: "web-v2025.06.06\nweb-v2025.06.05\n" },
      { match: "git log", stdout: "feat: offline sync\nfix: token refresh race\nMerge branch x\nWIP scratch\nchore: bump deps\n" },
    ]);
    const log = await collectChangelog({ ...base, runner });
    expect(log).toEqual(["feat: offline sync", "fix: token refresh race", "chore: bump deps"]);
    // It computed the range from the previous tag, not the current one.
    expect(runner.calls.some((c) => c.command.includes("web-v2025.06.05..HEAD"))).toBe(true);
  });

  it("falls back to full history when there is no previous tag", async () => {
    const runner = new FakeCommandRunner([
      { match: "git tag", stdout: "web-v2025.06.06\n" }, // only the current tag
      { match: "git log", stdout: "feat: first release\n" },
    ]);
    await collectChangelog({ ...base, runner });
    expect(runner.calls.some((c) => c.command.includes("git log HEAD"))).toBe(true);
  });

  it("returns [] when git is unavailable (non-zero exit)", async () => {
    const runner = new FakeCommandRunner([{ match: "git tag", exitCode: 128, stderr: "not a git repo" }]);
    expect(await collectChangelog({ ...base, runner })).toEqual([]);
  });
});

describe("release runner populates the changelog", () => {
  let stateDir: string;
  let clock = 0;
  const now = () => `2025-06-06T00:00:${String(clock++).padStart(2, "0")}.000Z`;
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "halyard-cl-"));
    clock = 0;
  });
  afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

  it("a release records the conventional commits for its surface", async () => {
    const runner = new FakeCommandRunner([
      { match: "git tag", stdout: "ios-v1.4.0\nios-v1.3.0\n" },
      { match: "git log", stdout: "feat: offline sync\nfix: token refresh race\n" },
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=4242\n" },
    ]);
    const release = await runRelease({
      app, surface: "ios", version: "1.4.0", commit: "abc1234",
      backend: makeGitBackend({ stateDir }), workdir: "/tmp/aurora", runner, now,
    });
    expect(release.changelog).toEqual(["feat: offline sync", "fix: token refresh race"]);
  });
});
