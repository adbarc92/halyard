import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/halyard/cli.js";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { bindReleaseToLaunch, linkRelease, newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { readRelease } from "../src/halyard/coordinator/record-store.js";
import { releaseSucceeded, runRelease } from "../src/halyard/coordinator/release-runner.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { isTerminal } from "../src/halyard/coordinator/state-machine.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { AndroidSurfaceAdapter } from "../src/halyard/surfaces/android.js";
import { DesktopSurfaceAdapter } from "../src/halyard/surfaces/desktop.js";
import { IosSurfaceAdapter } from "../src/halyard/surfaces/ios.js";
import { WebSurfaceAdapter } from "../src/halyard/surfaces/web.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

// The claim under test: a release gate that fails ends the release at the terminal `dead`
// state and the deploy step never runs. Every case plants a red gate (a non-zero build or
// test exit) and asserts on BOTH halves — the recorded state and the absence of a deploy —
// so it goes red if a gate is bypassed (a gate that always passes, or a runner that ignores
// the gate's decision). The green control proves the deploy spy can see a deploy at all.

const here = dirname(fileURLToPath(import.meta.url));
const auroraYml = readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8");

/** The shipped example app with every surface enabled (desktop ships disabled). */
function allSurfacesApp() {
  const raw = parseYaml(auroraYml);
  raw.surfaces.desktop.enabled = true;
  return validateAppConfig(raw);
}

// Per surface: the adapter whose deploy we watch, and a substring of its build/test command.
const SURFACES = [
  { surface: "web", adapter: WebSurfaceAdapter, build: "npm run build", test: "npm test" },
  { surface: "ios", adapter: IosSurfaceAdapter, build: "fastlane ios build", test: "fastlane ios test" },
  { surface: "android", adapter: AndroidSurfaceAdapter, build: "fastlane android build", test: "fastlane android test" },
  { surface: "desktop", adapter: DesktopSurfaceAdapter, build: "tauri build", test: "npm test" },
] as const;

let work: string;
let stateDir: string;
let clock = 0;
const now = () => `2026-10-12T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), "halyard-gate-"));
  stateDir = join(work, "state");
  clock = 0;
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

/** The commands the release ran, minus the informational changelog `git` lookups. */
const ran = (runner: FakeCommandRunner) =>
  runner.calls.map((c) => c.command).filter((c) => !c.startsWith("git "));

describe.each(SURFACES)("a failed gate fails closed ($surface)", ({ surface, adapter, build, test }) => {
  const run = (runner: FakeCommandRunner) =>
    runRelease({
      app: allSurfacesApp(),
      surface,
      version: "1.0.0",
      commit: "abc1234",
      backend: makeGitBackend({ stateDir }),
      workdir: work,
      runner,
      now,
    });

  it("a red BUILD gate ends the release `dead`; neither test nor deploy runs", async () => {
    const deploy = vi.spyOn(adapter.prototype, "deploy");
    const runner = new FakeCommandRunner([{ match: build, exitCode: 1 }]);

    const release = await run(runner);

    expect(release.state).toBe("dead");
    expect(isTerminal(release.state)).toBe(true);
    expect(release.transitions.map((t) => t.to)).toEqual(["tagged", "dead"]);
    expect(readRelease(stateDir, release.release_id)?.state).toBe("dead");
    expect(releaseSucceeded(release.state)).toBe(false);
    // No deploy step: the adapter's deploy was never entered, and the only command was the build.
    expect(deploy).not.toHaveBeenCalled();
    expect(ran(runner)).toEqual([expect.stringContaining(build)]);
  });

  it("a red TEST gate ends the release `dead`; deploy never runs", async () => {
    const deploy = vi.spyOn(adapter.prototype, "deploy");
    const runner = new FakeCommandRunner([{ match: test, exitCode: 1 }]);

    const release = await run(runner);

    expect(release.state).toBe("dead");
    expect(isTerminal(release.state)).toBe(true);
    expect(release.transitions.map((t) => t.to)).toEqual(["tagged", "built", "dead"]);
    expect(readRelease(stateDir, release.release_id)?.state).toBe("dead");
    expect(releaseSucceeded(release.state)).toBe(false);
    // No deploy step: the adapter's deploy was never entered, and nothing ran after the test.
    expect(deploy).not.toHaveBeenCalled();
    expect(ran(runner)).toEqual([expect.stringContaining(build), expect.stringContaining(test)]);
  });

  it("control: with both gates green the deploy step DOES run", async () => {
    const deploy = vi.spyOn(adapter.prototype, "deploy");
    const runner = new FakeCommandRunner([]);

    const release = await run(runner);

    expect(deploy).toHaveBeenCalledTimes(1);
    expect(release.state).not.toBe("dead");
    expect(ran(runner).length).toBeGreaterThan(2); // build, test, then a deploy command
  });
});

describe("a failed gate fails closed (end to end, through the `halyard release run` command)", () => {
  /** A real web app in `work`: `gate` picks which configured command exits non-zero. */
  function writeApp(gate: "build" | "test" | "none"): string {
    writeFileSync(
      join(work, "build.mjs"),
      `import { mkdirSync, writeFileSync } from "node:fs";\n` +
        `mkdirSync("dist", { recursive: true });\n` +
        `writeFileSync("dist/index.html", "<h1>aurora</h1>");\n`,
    );
    writeFileSync(join(work, "pass.mjs"), `process.exit(0);\n`);
    writeFileSync(join(work, "fail.mjs"), `process.exit(1);\n`);
    const raw = parseYaml(auroraYml);
    raw.surfaces.web.build = { command: gate === "build" ? "node fail.mjs" : "node build.mjs", output_dir: "dist" };
    raw.surfaces.web.test = { command: gate === "test" ? "node fail.mjs" : "node pass.mjs" };
    raw.surfaces.web.deploy = { target: "local_dir", dir: "preview" };
    const appPath = join(work, "app.yml");
    writeFileSync(appPath, stringifyYaml(raw), "utf8");
    return appPath;
  }

  const releaseRun = (appPath: string) =>
    dispatch([
      "release", "run", "--app", "aurora", "--surface", "web", "--version", "1.0.0", "--commit", "abc1234",
      "--app-config", appPath, "--workdir", work, "--state-dir", stateDir,
    ]);

  beforeEach(() => {
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
  });

  it.each(["build", "test"] as const)("a red %s gate exits non-zero, records `dead`, and deploys nothing", async (gate) => {
    const code = await releaseRun(writeApp(gate));

    expect(code).toBe(1); // what turns the release workflow red and stops it
    expect(readRelease(stateDir, "rel_aurora_web_1.0.0")?.state).toBe("dead");
    expect(existsSync(join(work, "preview"))).toBe(false); // the deploy target was never written
  });

  it("control: with both gates green the same command exits 0 and the deploy lands", async () => {
    const code = await releaseRun(writeApp("none"));

    expect(code).toBe(0);
    expect(readRelease(stateDir, "rel_aurora_web_1.0.0")?.state).toBe("uploaded");
    expect(existsSync(join(work, "preview"))).toBe(true);
  });
});

describe("`dead` stays dead: the launch moment cannot revive a gated-out release", () => {
  it("flipping the launch flag ON leaves a `dead` release `dead` (no transition applied)", async () => {
    const backend = makeGitBackend({ stateDir });
    const dead = await runRelease({
      app: allSurfacesApp(),
      surface: "web",
      version: "1.0.0",
      commit: "abc1234",
      backend,
      workdir: work,
      runner: new FakeCommandRunner([{ match: "npm test", exitCode: 1 }]),
      now,
    });
    expect(dead.state).toBe("dead");

    // Bind it to a launch and perform the human launch action: flip the flag ON.
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "why it matters",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
      createdBy: "test", createdAt: now(),
    });
    await backend.launches.write(linkRelease(launch, dead.release_id));
    await backend.records.write(bindReleaseToLaunch(dead, launch));
    const flags = new FlagFileClient(stateDir, now);
    await flags.setState("launch.aurora.offline_sync", true);

    const report = await reconcile({ backend, sources: [flagPollSource(flags)], now });

    expect(report.applied).toEqual([]);
    expect(readRelease(stateDir, dead.release_id)?.state).toBe("dead");
  });
});
