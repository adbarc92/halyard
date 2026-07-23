import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { IosSurfaceAdapter } from "../src/halyard/surfaces/ios.js";
import type { ReleaseContext } from "../src/halyard/surfaces/types.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

function ctx(runner: FakeCommandRunner): ReleaseContext {
  return {
    app,
    surface: "ios",
    releaseId: "rel_aurora_ios_1.4.0",
    version: "1.4.0",
    commit: "abc1234",
    workdir: "/tmp/aurora",
    runner,
    log: () => {},
  };
}

describe("M3: iOS adapter drives fastlane and parses the build id", () => {
  it("build invokes the build lane with non-secret identity env", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane ios build", exitCode: 0 }]);
    const result = await new IosSurfaceAdapter().build(ctx(runner));
    expect(result.ok).toBe(true);
    const call = runner.calls[0]!;
    expect(call.command).toBe("bundle exec fastlane ios build");
    expect(call.env).toMatchObject({
      HALYARD_BUNDLE_ID: "com.example.aurora",
      HALYARD_ASC_APP_ID: "1234567890",
      HALYARD_TESTFLIGHT_GROUP: "external",
    });
    // No secret material is ever passed to the runner env.
    expect(JSON.stringify(call.env)).not.toMatch(/SECRET:|ASC_API_KEY|MATCH_REPO/);
  });

  it("test reports the lane exit code for the gate to adjudicate", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane ios test", exitCode: 65 }]);
    const result = await new IosSurfaceAdapter().test(ctx(runner));
    expect(result.exitCode).toBe(65); // the gate, not the adapter, decides dead
  });

  it("deploy parses asc_build_id and builds the TestFlight ref", async () => {
    const runner = new FakeCommandRunner([
      { match: "fastlane ios upload", exitCode: 0, stdout: "uploading...\nHALYARD_ASC_BUILD_ID=4242\ndone\n" },
    ]);
    const result = await new IosSurfaceAdapter().deploy(ctx(runner), {
      ok: true,
      outputDir: "/tmp/aurora",
      command: { command: "", exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.ok).toBe(true);
    expect(result.externalRefs).toMatchObject({ asc_build_id: "4242" });
    expect(result.previewUrl).toContain("/apps/1234567890/testflight/ios/4242");
  });

  it("deploy fails (not ok) when no build id is emitted", async () => {
    const runner = new FakeCommandRunner([{ match: "fastlane ios upload", exitCode: 0, stdout: "no id here" }]);
    const result = await new IosSurfaceAdapter().deploy(ctx(runner), {
      ok: true,
      outputDir: "/tmp/aurora",
      command: { command: "", exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.ok).toBe(false);
  });
});
