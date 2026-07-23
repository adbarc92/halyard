import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runRelease, releaseSucceeded } from "../src/halyard/coordinator/release-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readRelease } from "../src/halyard/coordinator/record-store.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-06T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-deployfail-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("§E: release runner deploy-failure path", () => {
  it("a failed deploy after a green build+test stays at `tested` and never claims `uploaded`", async () => {
    // build + test pass; upload emits NO build id → the iOS deploy is not ok.
    const runner = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "uploaded but no id line\n" },
    ]);

    const release = await runRelease({
      app, surface: "ios", version: "1.4.0", commit: "abc1234",
      backend, workdir: "/tmp/aurora", runner, now,
    });

    // Stopped before `uploaded`.
    expect(release.state).toBe("tested");
    expect(release.transitions.map((t) => t.to)).toEqual(["tagged", "built", "tested"]);
    // The refs gathered before the failure were still persisted.
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.external_refs.commit_sha).toBe("abc1234");
  });

  it("a re-run after the deploy recovers advances to `uploaded` (idempotent resume)", async () => {
    const failing = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "no id\n" },
    ]);
    await runRelease({ app, surface: "ios", version: "1.4.0", commit: "abc1234", backend, workdir: "/tmp/aurora", runner: failing, now });

    const recovered = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=4242\n" },
    ]);
    const release = await runRelease({ app, surface: "ios", version: "1.4.0", commit: "abc1234", backend, workdir: "/tmp/aurora", runner: recovered, now });

    expect(release.state).toBe("uploaded");
    expect(release.transitions.filter((t) => t.to === "uploaded")).toHaveLength(1); // no duplicate
  });

  it("releaseSucceeded maps a deploy-failure (`tested`) to a non-zero exit, `uploaded`+ to success", () => {
    // The CLI exit code keys off this: a failed deploy that stalls at `tested` must turn the
    // job red, not pass green (no reconcile source re-runs a deploy).
    expect(releaseSucceeded("tested")).toBe(false);
    expect(releaseSucceeded("built")).toBe(false);
    expect(releaseSucceeded("dead")).toBe(false);
    expect(releaseSucceeded("uploaded")).toBe(true);
    expect(releaseSucceeded("shipped_dark")).toBe(true);
    expect(releaseSucceeded("live")).toBe(true);
  });
});
