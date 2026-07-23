import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { getMobileToolchain } from "../src/halyard/surfaces/index.js";
import { easToolchain } from "../src/halyard/surfaces/mobile/eas.js";
import type {
  BuildResult,
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { Surface } from "../src/halyard/config/primitives.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(
  parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")),
);

/** Records WHICH path (shell `run` vs no-shell `runArgv`) was used and with exactly which
 * argv, plus scripted results keyed by the joined command. */
interface RunCall {
  via: "run" | "runArgv";
  command?: string;
  file?: string;
  args?: string[];
  cwd: string;
  env?: Record<string, string>;
}

class FakeCommandRunner implements CommandRunner {
  readonly calls: RunCall[] = [];
  constructor(private readonly results: Record<string, Partial<CommandResult>> = {}) {}

  async run(
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "run", command, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
    return this.result(command);
  }

  async runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "runArgv", file, args, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
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

function ctx(surface: Surface, runner: FakeCommandRunner): ReleaseContext {
  return {
    app,
    surface,
    releaseId: `rel_aurora_${surface}_1.4.0`,
    version: "1.4.0",
    commit: "abc1234",
    workdir: "/tmp/aurora",
    runner,
    log: () => {},
  };
}

const iosCfg = {
  asc_app_id: "123",
  bundle_id: "x",
  team_id: "y",
  testflight_group: "external",
  toolchain: "eas",
  enabled: true,
};
const androidCfg = { package: "com.x", track: "internal", toolchain: "eas", enabled: true };

const okBuild: BuildResult = {
  ok: true,
  outputDir: "/tmp/aurora",
  command: { command: "", exitCode: 0, stdout: "", stderr: "" },
};

describe("L7: eas toolchain build uses runArgv with the right platform", () => {
  for (const [surface, platform] of [
    ["ios", "ios"],
    ["android", "android"],
  ] as const) {
    it(`build (${surface}) calls eas build --platform ${platform} via runArgv`, async () => {
      const runner = new FakeCommandRunner();
      const result = await easToolchain.build(ctx(surface, runner), surface === "ios" ? iosCfg : androidCfg);
      expect(result.ok).toBe(true);
      expect(result.outputDir).toBe("/tmp/aurora");
      const call = runner.calls[0]!;
      expect(call.via).toBe("runArgv"); // NO shell
      expect(call.file).toBe("eas");
      expect(call.args).toContain("build");
      expect(call.args).toEqual(
        expect.arrayContaining(["--platform", platform, "--non-interactive"]),
      );
    });

    it(`build (${surface}) reports ok:false on a non-zero exit (gate decides)`, async () => {
      const runner = new FakeCommandRunner({
        [`eas build --platform ${platform} --profile production --non-interactive --json`]: {
          exitCode: 1,
        },
      });
      const result = await easToolchain.build(ctx(surface, runner), surface === "ios" ? iosCfg : androidCfg);
      expect(result.ok).toBe(false);
    });
  }
});

describe("L7: eas toolchain test surfaces the raw exit code via runArgv (npm test)", () => {
  it("test reports the lane exit code for the gate to adjudicate", async () => {
    const runner = new FakeCommandRunner({ "npm test": { exitCode: 3 } });
    const result = await easToolchain.test(ctx("ios", runner), iosCfg);
    expect(result.exitCode).toBe(3);
    const call = runner.calls[0]!;
    expect(call.via).toBe("runArgv");
    expect(call.file).toBe("npm");
    expect(call.args).toEqual(["test"]);
  });
});

describe("L7: eas iOS submit parses the ASC build id and lands at uploaded", () => {
  it("parses HALYARD_ASC_BUILD_ID, builds the TestFlight url, ok:true", async () => {
    const runner = new FakeCommandRunner({
      "eas submit --platform ios --non-interactive --profile production": {
        exitCode: 0,
        stdout: "submitting...\nHALYARD_ASC_BUILD_ID=4242\ndone\n",
      },
    });
    const result = await easToolchain.submit(ctx("ios", runner), okBuild, iosCfg);
    expect(result.ok).toBe(true);
    expect(result.externalRefs).toMatchObject({ asc_build_id: "4242" });
    expect(result.previewUrl).toContain("/apps/123/testflight/ios/4242");
    expect(result.externalRefs).toMatchObject({ testflight_url: result.previewUrl });
    expect(result.details).toMatchObject({ target: "eas", surface: "ios", exitCode: 0 });

    const call = runner.calls[0]!;
    expect(call.via).toBe("runArgv");
    expect(call.file).toBe("eas");
    expect(call.args!.slice(0, 4)).toEqual(["submit", "--platform", "ios", "--non-interactive"]);
  });

  it("ok:false when no build id is emitted", async () => {
    const runner = new FakeCommandRunner({
      "eas submit --platform ios --non-interactive --profile production": {
        exitCode: 0,
        stdout: "no id here",
      },
    });
    const result = await easToolchain.submit(ctx("ios", runner), okBuild, iosCfg);
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toEqual({});
    expect(result.previewUrl).toBe("");
  });
});

describe("L7: eas android submit parses the Play version code", () => {
  it("parses HALYARD_PLAY_VERSION_CODE and records the play refs", async () => {
    const runner = new FakeCommandRunner({
      "eas submit --platform android --non-interactive --profile production": {
        exitCode: 0,
        stdout: "uploading...\nHALYARD_PLAY_VERSION_CODE=99\ndone\n",
      },
    });
    const result = await easToolchain.submit(ctx("android", runner), okBuild, androidCfg);
    expect(result.ok).toBe(true);
    expect(result.externalRefs).toMatchObject({ play_version_code: "99", play_track: "internal" });
    expect(result.previewUrl).toContain("com.x");
    expect(result.details).toMatchObject({ target: "eas", surface: "android", exitCode: 0 });

    const call = runner.calls[0]!;
    expect(call.via).toBe("runArgv");
    expect(call.file).toBe("eas");
    expect(call.args).toEqual(
      expect.arrayContaining(["submit", "--platform", "android", "--non-interactive"]),
    );
  });

  it("ok:false when no version code is emitted", async () => {
    const runner = new FakeCommandRunner({
      "eas submit --platform android --non-interactive --profile production": {
        exitCode: 0,
        stdout: "no code here",
      },
    });
    const result = await easToolchain.submit(ctx("android", runner), okBuild, androidCfg);
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toEqual({});
  });
});

describe("L7: registry resolves the eas toolchain", () => {
  it('getMobileToolchain("eas") returns this toolchain (name "eas")', () => {
    const toolchain = getMobileToolchain("eas");
    expect(toolchain).toBe(easToolchain);
    expect(toolchain.name).toBe("eas");
  });
});
