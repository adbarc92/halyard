import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import {
  deployTargets,
  getDeployProvider,
  getMobileToolchain,
  getSigningStep,
  mobileToolchains,
  validateDeployConfig,
  DesktopSurfaceAdapter,
} from "../src/halyard/surfaces/index.js";
import { localDirProvider } from "../src/halyard/surfaces/deploy/local-dir.js";
import type {
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const appPath = resolve(here, "..", "apps/aurora/app.yml");

class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ via: "run" | "runArgv"; label: string; cwd: string }> = [];
  async run(command: string, opts: { cwd: string }): Promise<CommandResult> {
    this.calls.push({ via: "run", label: command, cwd: opts.cwd });
    return { command, exitCode: 0, stdout: "", stderr: "" };
  }
  async runArgv(file: string, args: string[], opts: { cwd: string }): Promise<CommandResult> {
    const label = [file, ...args].join(" ");
    this.calls.push({ via: "runArgv", label, cwd: opts.cwd });
    return { command: label, exitCode: 0, stdout: "", stderr: "" };
  }
}

function rawAurora(): Record<string, unknown> {
  return parseYaml(readFileSync(appPath, "utf8"));
}

describe("L0 deploy registry: resolution + surface guard", () => {
  it("registers the three pre-existing targets plus the provider-lane targets", () => {
    const targets = deployTargets();
    for (const t of ["local_dir", "cloudflare_pages", "github_releases"]) {
      expect(targets).toContain(t);
    }
    // Provider-lane stubs are registered so the registry compiles and validates config.
    for (const t of ["command", "vercel", "fly", "github_pages", "itch", "aws"]) {
      expect(targets).toContain(t);
    }
  });

  it("getDeployProvider throws a helpful error on an unknown target", () => {
    expect(() => getDeployProvider("does_not_exist")).toThrow(/unknown deploy target/);
  });

  it("validateDeployConfig enforces the per-surface constraint (no cross-surface targets)", () => {
    // cloudflare_pages is web-only; github_releases is desktop-only.
    expect(() =>
      validateDeployConfig("desktop", { target: "cloudflare_pages", project: "x" }),
    ).toThrow(/not valid for the desktop surface/);
    expect(() =>
      validateDeployConfig("web", { target: "github_releases", repo: "o/n", tag_pattern: "v{version}" }),
    ).toThrow(/not valid for the web surface/);
    // local_dir is surface-agnostic — valid for both.
    expect(() => validateDeployConfig("web", { target: "local_dir", dir: "preview" })).not.toThrow();
    expect(() =>
      validateDeployConfig("desktop", { target: "local_dir", dir: "preview" }),
    ).not.toThrow();
  });

  it("validateDeployConfig rejects a missing target and unknown provider fields", () => {
    expect(() => validateDeployConfig("web", {})).toThrow(/target/);
    expect(() =>
      validateDeployConfig("web", { target: "cloudflare_pages", project: "x", extra: 1 }),
    ).toThrow();
  });
});

describe("L0 deploy registry: config validation wiring", () => {
  it("a cross-surface target is rejected at config load (web using github_releases)", () => {
    const raw = rawAurora();
    (raw.surfaces as { web: { deploy: unknown } }).web.deploy = {
      target: "github_releases",
      repo: "o/n",
      tag_pattern: "v{version}",
    };
    expect(() => validateAppConfig(raw)).toThrow();
  });

  it("an unknown deploy target is rejected at config load", () => {
    const raw = rawAurora();
    (raw.surfaces as { web: { deploy: unknown } }).web.deploy = { target: "ftp_upload" };
    expect(() => validateAppConfig(raw)).toThrow();
  });

  it("the aurora web cloudflare_pages config still validates unchanged (regression)", () => {
    const app = validateAppConfig(rawAurora());
    expect((app.surfaces.web!.deploy as { target: string }).target).toBe("cloudflare_pages");
  });
});

describe("L0 local_dir provider: unified, surface-aware preview URL", () => {
  let work: string;
  let buildDir: string;
  beforeEach(() => {
    work = mkdtempSync(join(tmpdir(), "halyard-localdir-"));
    buildDir = join(work, "build");
    mkdirSync(buildDir, { recursive: true });
    writeFileSync(join(buildDir, "index.html"), "<h1>hi</h1>");
  });
  afterEach(() => rmSync(work, { recursive: true, force: true }));

  function ctx(surface: "web" | "desktop"): ReleaseContext {
    return {
      app: {} as AppConfig,
      surface,
      releaseId: "rel_x",
      version: "1.0.0",
      commit: "abc1234",
      workdir: work,
      runner: new FakeCommandRunner(),
      log: () => {},
    };
  }

  it("web → previewUrl points at index.html (a servable page)", async () => {
    const out = join(work, "out");
    const result = await localDirProvider.deploy(
      ctx("web"),
      { ok: true, outputDir: buildDir, command: {} as CommandResult },
      { target: "local_dir", dir: out },
    );
    expect(result.previewUrl).toMatch(/index\.html$/);
    expect(existsSync(fileURLToPath(result.previewUrl))).toBe(true);
  });

  it("desktop → previewUrl points at the copied directory (a bundle)", async () => {
    const out = join(work, "out2");
    const result = await localDirProvider.deploy(
      ctx("desktop"),
      { ok: true, outputDir: buildDir, command: {} as CommandResult },
      { target: "local_dir", dir: out },
    );
    expect(result.previewUrl).not.toMatch(/index\.html$/);
    expect(existsSync(fileURLToPath(result.previewUrl))).toBe(true);
  });
});

describe("L0 mobile toolchain registry", () => {
  it("resolves match (default) and eas; throws on unknown", () => {
    expect(getMobileToolchain("match").name).toBe("match");
    expect(getMobileToolchain("eas").name).toBe("eas");
    expect(mobileToolchains()).toEqual(expect.arrayContaining(["match", "eas"]));
    expect(() => getMobileToolchain("nope")).toThrow(/unknown mobile toolchain/);
  });

  it("ios/android config default toolchain to `match`", () => {
    const app = validateAppConfig(rawAurora());
    expect(app.surfaces.ios!.toolchain).toBe("match");
    expect(app.surfaces.android!.toolchain).toBe("match");
  });

  it("the eas toolchain is implemented (Lane L7) — build shells `eas` via runArgv", async () => {
    const calls: Array<{ file: string; args: string[] }> = [];
    const runner: CommandRunner = {
      async run(command) {
        return { command, exitCode: 0, stdout: "", stderr: "" };
      },
      async runArgv(file, args) {
        calls.push({ file, args });
        return { command: [file, ...args].join(" "), exitCode: 0, stdout: "", stderr: "" };
      },
    };
    const ctx = {
      app: {} as AppConfig,
      surface: "ios" as const,
      releaseId: "rel_x",
      version: "1.0.0",
      commit: "abc1234",
      workdir: "/tmp/work",
      runner,
      log: () => {},
    };
    const build = await getMobileToolchain("eas").build(ctx, {});
    expect(build.ok).toBe(true);
    expect(calls[0]!.file).toBe("eas");
    expect(calls[0]!.args).toContain("build");
  });
});

describe("L0 signing seam", () => {
  it("resolves macos and windows signing steps", () => {
    expect(getSigningStep("macos").platform).toBe("macos");
    expect(getSigningStep("windows").platform).toBe("windows");
  });

  function desktopApp(signing?: unknown): AppConfig {
    const raw = rawAurora();
    const surfaces = raw.surfaces as Record<string, unknown>;
    delete surfaces.ios;
    delete surfaces.android;
    delete surfaces.web;
    surfaces.desktop = {
      enabled: true,
      build: { command: "node build.mjs", output_dir: "bundle" },
      test: { command: "node pass.mjs" },
      deploy: { target: "local_dir", dir: "preview" },
      ...(signing ? { signing } : {}),
    };
    return validateAppConfig(raw);
  }

  function ctxFor(app: AppConfig, runner: CommandRunner, workdir: string): ReleaseContext {
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

  it("signing defaults off: an absent block runs no signer (deploy proceeds)", async () => {
    const work = mkdtempSync(join(tmpdir(), "halyard-sign-"));
    try {
      const bundle = join(work, "bundle");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "art.bin"), "X");
      const app = desktopApp();
      const deploy = await new DesktopSurfaceAdapter().deploy(
        ctxFor(app, new FakeCommandRunner(), work),
        { ok: true, outputDir: bundle, command: {} as CommandResult },
      );
      expect(deploy.ok).toBe(true); // local_dir deploy succeeded, no signing attempted
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("signing enabled wires the macOS signer in between build and deploy (Lane L8)", async () => {
    const work = mkdtempSync(join(tmpdir(), "halyard-sign2-"));
    try {
      const bundle = join(work, "bundle");
      mkdirSync(bundle, { recursive: true });
      writeFileSync(join(bundle, "app.bin"), "X");
      const app = desktopApp({ enabled: true, platform: "macos" });
      const runner = new FakeCommandRunner();
      const deploy = await new DesktopSurfaceAdapter().deploy(ctxFor(app, runner, work), {
        ok: true,
        outputDir: bundle,
        command: {} as CommandResult,
      });
      // The signer ran (notarytool via runArgv) before the local_dir deploy succeeded.
      expect(runner.calls.some((c) => c.via === "runArgv" && c.label.includes("notarytool"))).toBe(true);
      expect(deploy.ok).toBe(true);
    } finally {
      rmSync(work, { recursive: true, force: true });
    }
  });

  it("config: signing.enabled defaults to false when only platform is given", () => {
    const app = desktopApp({ platform: "macos" });
    expect(app.surfaces.desktop!.signing!.enabled).toBe(false);
  });
});
