import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readRelease } from "../src/halyard/coordinator/record-store.js";
import { ShellCommandRunner } from "../src/halyard/surfaces/command-runner.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "apps/aurora/app.yml");

let work: string;
let clock = 0;
const now = () => `2025-06-05T00:00:${String(clock++).padStart(2, "0")}.000Z`;

/** A fixture app config whose web surface builds/tests via local node scripts and
 * deploys to a local directory — a real end-to-end with no external services. */
function fixtureAppConfig(testScript: string): AppConfig {
  const raw = parseYaml(readFileSync(appPath, "utf8"));
  raw.surfaces.web.build = { command: "node build.mjs", output_dir: "dist" };
  raw.surfaces.web.test = { command: testScript };
  raw.surfaces.web.deploy = { target: "local_dir", dir: "preview" };
  return validateAppConfig(raw);
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "halyard-run-"));
  clock = 0;
  // A tiny "web app": its build emits dist/index.html.
  writeFileSync(
    join(work, "build.mjs"),
    `import { mkdirSync, writeFileSync } from "node:fs";\n` +
      `mkdirSync("dist", { recursive: true });\n` +
      `writeFileSync("dist/index.html", "<h1>aurora</h1>");\n`,
  );
  writeFileSync(join(work, "pass.mjs"), `process.exit(0);\n`);
  writeFileSync(join(work, "fail.mjs"), `process.exit(1);\n`);
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe("M1 verify: a tag yields a record in state/ + a deployed preview", () => {
  it("happy path: tagged → built → tested → uploaded with a real preview artifact", async () => {
    const stateDir = join(work, "state");
    const backend = makeGitBackend({ stateDir });
    const release = await runRelease({
      app: fixtureAppConfig("node pass.mjs"),
      surface: "web",
      version: "1.0.0",
      commit: "abc1234",
      backend,
      workdir: work,
      runner: new ShellCommandRunner(),
      now,
    });

    // State progression.
    expect(release.state).toBe("uploaded");
    expect(release.transitions.map((t) => t.to)).toEqual([
      "tagged",
      "built",
      "tested",
      "uploaded",
    ]);

    // A record exists in state/.
    const onDisk = readRelease(stateDir, "rel_aurora_web_1.0.0");
    expect(onDisk?.state).toBe("uploaded");
    expect(onDisk?.external_refs.commit_sha).toBe("abc1234");

    // A deployed preview actually exists on disk.
    const previewUrl = String(onDisk?.external_refs.preview_url ?? "");
    expect(previewUrl).toMatch(/^file:\/\//);
    const previewPath = fileURLToPath(previewUrl);
    expect(existsSync(previewPath)).toBe(true);
    expect(readFileSync(previewPath, "utf8")).toContain("aurora");
  });

  it("failing test gate ends at `dead` and never deploys", async () => {
    const stateDir = join(work, "state");
    const backend = makeGitBackend({ stateDir });
    const release = await runRelease({
      app: fixtureAppConfig("node fail.mjs"),
      surface: "web",
      version: "1.0.1",
      commit: "deadbee",
      backend,
      workdir: work,
      runner: new ShellCommandRunner(),
      now,
    });

    expect(release.state).toBe("dead");
    expect(release.transitions.map((t) => t.to)).toEqual(["tagged", "built", "dead"]);
    // No preview directory was created.
    expect(existsSync(join(work, "preview"))).toBe(false);
  });

  it("re-running an existing release is idempotent (no duplicate transitions)", async () => {
    const stateDir = join(work, "state");
    const backend = makeGitBackend({ stateDir });
    const input = {
      app: fixtureAppConfig("node pass.mjs"),
      surface: "web" as const,
      version: "1.0.2",
      commit: "abc1234",
      backend,
      workdir: work,
      runner: new ShellCommandRunner(),
      now,
    };
    await runRelease(input);
    const second = await runRelease(input);
    expect(second.transitions.map((t) => t.to)).toEqual([
      "tagged",
      "built",
      "tested",
      "uploaded",
    ]);
  });
});
