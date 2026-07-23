import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readRelease } from "../src/halyard/coordinator/record-store.js";
import { getAdapter, DesktopSurfaceAdapter } from "../src/halyard/surfaces/index.js";
import type {
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "apps/aurora/app.yml");

let clock = 0;
const now = () => `2025-06-05T00:00:${String(clock++).padStart(2, "0")}.000Z`;

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv — no real `tauri`/`gh` is on the test machine. */
interface RunCall {
  via: "run" | "runArgv";
  command?: string;
  file?: string;
  args?: string[];
  cwd: string;
}

class FakeCommandRunner implements CommandRunner {
  readonly calls: RunCall[] = [];
  constructor(private readonly results: Record<string, Partial<CommandResult>> = {}) {}

  async run(
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "run", command, cwd: opts.cwd });
    return this.result(command);
  }

  async runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "runArgv", file, args, cwd: opts.cwd });
    return this.result([file, ...args].join(" "));
  }

  private result(label: string): CommandResult {
    const override = this.results[label] ?? {};
    return {
      command: label,
      exitCode: override.exitCode ?? 0,
      stdout: override.stdout ?? "",
      stderr: override.stderr ?? "",
    };
  }
}

type DesktopDeploy =
  | { target: "github_releases"; repo: string; tag_pattern: string }
  | { target: "local_dir"; dir: string };

/** A desktop-enabled app config derived from aurora's yml (swap the disabled desktop
 * surface for an enabled one, and turn the others off so desktop is the only surface). */
function desktopAppConfig(deploy: DesktopDeploy): AppConfig {
  const raw = parseYaml(readFileSync(appPath, "utf8"));
  delete raw.surfaces.ios;
  delete raw.surfaces.android;
  delete raw.surfaces.web;
  raw.surfaces.desktop = {
    enabled: true,
    build: { command: "node build.mjs", output_dir: "bundle" },
    test: { command: "node pass.mjs" },
    deploy,
  };
  return validateAppConfig(raw);
}

function ctxFor(
  app: AppConfig,
  runner: CommandRunner,
  workdir: string,
): ReleaseContext {
  return {
    app,
    surface: "desktop",
    releaseId: "rel_aurora_desktop_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir,
    runner,
    log: () => {},
  };
}

describe("desktop surface: adapter resolution", () => {
  it("getAdapter(\"desktop\") returns the adapter (no throw)", () => {
    const adapter = getAdapter("desktop");
    expect(adapter).toBeInstanceOf(DesktopSurfaceAdapter);
    expect(adapter.surface).toBe("desktop");
  });
});

describe("desktop surface: build/test report exit codes, never decide pass/fail", () => {
  it("build runs the configured tauri command (shell) and resolves outputDir", async () => {
    const app = desktopAppConfig({ target: "local_dir", dir: "preview" });
    const runner = new FakeCommandRunner();
    const work = "/tmp/work";
    const adapter = new DesktopSurfaceAdapter();

    const build = await adapter.build(ctxFor(app, runner, work));
    expect(build.ok).toBe(true);
    expect(build.outputDir).toBe(resolve(work, "bundle"));
    expect(runner.calls[0]).toMatchObject({ via: "run", command: "node build.mjs" });
  });

  it("a non-zero build exit code yields ok:false (the gate decides, not the adapter)", async () => {
    const app = desktopAppConfig({ target: "local_dir", dir: "preview" });
    const runner = new FakeCommandRunner({ "node build.mjs": { exitCode: 7 } });
    const adapter = new DesktopSurfaceAdapter();
    const build = await adapter.build(ctxFor(app, runner, "/tmp/work"));
    expect(build.ok).toBe(false);
  });

  it("test surfaces the raw exit code", async () => {
    const app = desktopAppConfig({ target: "local_dir", dir: "preview" });
    const runner = new FakeCommandRunner({ "node pass.mjs": { exitCode: 3 } });
    const adapter = new DesktopSurfaceAdapter();
    const test = await adapter.test(ctxFor(app, runner, "/tmp/work"));
    expect(test.exitCode).toBe(3);
  });

  it("guards: build on a disabled/absent desktop surface throws", async () => {
    const app = desktopAppConfig({ target: "local_dir", dir: "preview" });
    const disabled: AppConfig = {
      ...app,
      surfaces: { ...app.surfaces, desktop: { ...app.surfaces.desktop!, enabled: false } },
    };
    const adapter = new DesktopSurfaceAdapter();
    await expect(adapter.build(ctxFor(disabled, new FakeCommandRunner(), "/tmp/work"))).rejects.toThrow(
      /desktop surface is not enabled/,
    );
  });
});

describe("desktop surface: deploy github_releases uses gh via runArgv (NO shell)", () => {
  it("invokes `gh release create <tag> <artifact>` with the captured argv", async () => {
    const app = desktopAppConfig({
      target: "github_releases",
      repo: "example/aurora",
      tag_pattern: "desktop-v{version}",
    });
    const releaseUrl = "https://github.com/example/aurora/releases/tag/desktop-v1.0.0";
    const adapter = new DesktopSurfaceAdapter();
    const build = { ok: true, outputDir: "/tmp/work/bundle", command: {} as CommandResult };

    // Provide stdout for the gh call so the adapter can extract the release URL.
    const ghRunner = new FakeCommandRunner({
      [`gh release create desktop-v1.0.0 /tmp/work/bundle --repo example/aurora --title desktop-v1.0.0 --notes Desktop release 1.0.0 (abc1234)`]:
        { stdout: releaseUrl },
    });
    const deploy = await adapter.deploy(ctxFor(app, ghRunner, "/tmp/work"), build);

    const ghCall = ghRunner.calls.find((c) => c.via === "runArgv");
    expect(ghCall).toBeDefined();
    expect(ghCall!.via).toBe("runArgv"); // NO shell was used for runtime values
    expect(ghCall!.file).toBe("gh");
    expect(ghCall!.args!.slice(0, 3)).toEqual(["release", "create", "desktop-v1.0.0"]);
    expect(ghCall!.args).toContain("/tmp/work/bundle");
    expect(ghCall!.args).toContain("--repo");
    expect(ghCall!.args).toContain("example/aurora");

    expect(deploy.ok).toBe(true);
    expect(deploy.previewUrl).toBe(releaseUrl);
    expect(deploy.details).toMatchObject({ target: "github_releases", tag: "desktop-v1.0.0" });
    expect(deploy.externalRefs).toMatchObject({ github_release_tag: "desktop-v1.0.0" });

    // Sanity: the deploy path used ONLY runArgv (no shell `run`).
    expect(ghRunner.calls.every((c) => c.via === "runArgv")).toBe(true);
  });

  it("a non-zero gh exit code yields ok:false with no external refs", async () => {
    const app = desktopAppConfig({
      target: "github_releases",
      repo: "example/aurora",
      tag_pattern: "desktop-v{version}",
    });
    const runner = new FakeCommandRunner({
      [`gh release create desktop-v1.0.0 /tmp/work/bundle --repo example/aurora --title desktop-v1.0.0 --notes Desktop release 1.0.0 (abc1234)`]:
        { exitCode: 1 },
    });
    const adapter = new DesktopSurfaceAdapter();
    const build = { ok: true, outputDir: "/tmp/work/bundle", command: {} as CommandResult };
    const deploy = await adapter.deploy(ctxFor(app, runner, "/tmp/work"), build);
    expect(deploy.ok).toBe(false);
    expect(deploy.externalRefs).toEqual({});
  });
});

describe("desktop surface: strict schema rejects unknown fields", () => {
  it("validateAppConfig throws on a typo'd desktop field", () => {
    const raw = parseYaml(readFileSync(appPath, "utf8"));
    delete raw.surfaces.ios;
    delete raw.surfaces.android;
    delete raw.surfaces.web;
    raw.surfaces.desktop = {
      enabled: true,
      build: { command: "npm run tauri build", output_dir: "bundle" },
      test: { command: "npm test" },
      deploy: { target: "local_dir", dir: "preview" },
      updater_channel: "stable", // unknown — strict schema must reject
    };
    expect(() => validateAppConfig(raw)).toThrow();
  });

  it("rejects a deploy target with an unknown field", () => {
    const raw = parseYaml(readFileSync(appPath, "utf8"));
    delete raw.surfaces.ios;
    delete raw.surfaces.android;
    delete raw.surfaces.web;
    raw.surfaces.desktop = {
      enabled: true,
      build: { command: "npm run tauri build", output_dir: "bundle" },
      test: { command: "npm test" },
      deploy: { target: "github_releases", repo: "o/n", tag_pattern: "v{version}", extra: 1 },
    };
    expect(() => validateAppConfig(raw)).toThrow();
  });
});

describe("desktop surface: end-to-end local_dir deploy lands at uploaded", () => {
  let work: string;

  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "halyard-desktop-"));
    clock = 0;
    // A tiny "desktop app": its build emits bundle/app.bin.
    writeFileSync(
      join(work, "build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
        `mkdirSync("bundle", { recursive: true });\n` +
        `writeFileSync("bundle/app.bin", "AURORA-DESKTOP");\n`,
    );
    writeFileSync(join(work, "pass.mjs"), `process.exit(0);\n`);
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  it("tagged → built → tested → uploaded with a real preview artifact", async () => {
    const { ShellCommandRunner } = await import("../src/halyard/surfaces/command-runner.js");
    const stateDir = join(work, "state");
    const backend = makeGitBackend({ stateDir });
    const release = await runRelease({
      app: desktopAppConfig({ target: "local_dir", dir: "preview" }),
      surface: "desktop",
      version: "1.0.0",
      commit: "abc1234",
      backend,
      workdir: work,
      runner: new ShellCommandRunner(),
      now,
    });

    expect(release.state).toBe("uploaded");
    expect(release.transitions.map((t) => t.to)).toEqual([
      "tagged",
      "built",
      "tested",
      "uploaded",
    ]);

    const onDisk = readRelease(stateDir, "rel_aurora_desktop_1.0.0");
    expect(onDisk?.state).toBe("uploaded");
    expect(onDisk?.external_refs.commit_sha).toBe("abc1234");
    expect(onDisk?.external_refs.deploy_target).toBe("local_dir");

    // A deployed preview directory actually exists on disk with the copied bundle.
    const previewUrl = String(onDisk?.external_refs.preview_url ?? "");
    expect(previewUrl).toMatch(/^file:\/\//);
    const previewPath = fileURLToPath(previewUrl);
    expect(existsSync(previewPath)).toBe(true);
    expect(readFileSync(join(previewPath, "app.bin"), "utf8")).toBe("AURORA-DESKTOP");
  });
});
