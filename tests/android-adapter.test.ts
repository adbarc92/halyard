import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { AndroidSurfaceAdapter } from "../src/halyard/surfaces/android.js";
import type { ReleaseContext } from "../src/halyard/surfaces/types.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

function ctx(runner: FakeCommandRunner): ReleaseContext {
  return {
    app,
    surface: "android",
    releaseId: "rel_aurora_android_1.4.0",
    version: "1.4.0",
    commit: "abc1234",
    workdir: "/tmp/aurora",
    runner,
    log: () => {},
  };
}

describe("Android adapter drives fastlane/gradle and parses the Play version code", () => {
  it("build invokes the build lane with non-secret identity env", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane android build", exitCode: 0 }]);
    const result = await new AndroidSurfaceAdapter().build(ctx(runner));
    expect(result.ok).toBe(true);
    const call = runner.calls[0]!;
    expect(call.command).toBe("bundle exec fastlane android build");
    expect(call.env).toMatchObject({
      HALYARD_PACKAGE: "com.example.aurora",
      HALYARD_PLAY_TRACK: "internal",
    });
    // No secret material ever passed to the runner env.
    expect(JSON.stringify(call.env)).not.toMatch(/SECRET:|SERVICE_ACCOUNT|JSON_KEY/);
  });

  it("test reports the lane exit code for the gate to adjudicate", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane android test", exitCode: 1 }]);
    const result = await new AndroidSurfaceAdapter().test(ctx(runner));
    expect(result.exitCode).toBe(1); // the gate, not the adapter, decides dead
  });

  it("deploy parses play_version_code and builds the Play ref", async () => {
    const runner = new FakeCommandRunner([
      { match: "fastlane android upload", exitCode: 0, stdout: "uploading...\nHALYARD_PLAY_VERSION_CODE=4242\ndone\n" },
    ]);
    const result = await new AndroidSurfaceAdapter().deploy(ctx(runner), {
      ok: true, outputDir: "/tmp/aurora", command: { command: "", exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.ok).toBe(true);
    expect(result.externalRefs).toMatchObject({ play_version_code: "4242", play_track: "internal" });
    expect(result.previewUrl).toContain("com.example.aurora");
  });

  it("deploy fails (not ok) when no version code is emitted", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane android upload", exitCode: 0, stdout: "no code here" }]);
    const result = await new AndroidSurfaceAdapter().deploy(ctx(runner), {
      ok: true, outputDir: "/tmp/aurora", command: { command: "", exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.ok).toBe(false);
  });
});
