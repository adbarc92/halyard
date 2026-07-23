import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, newLaunch, writeLaunch, linkRelease } from "../src/halyard/coordinator/launch-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-05T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-android-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("Android end-to-end: tag → uploaded, then flag-flip → live (internal track)", () => {
  it("CI uploads to Play (uploaded), and flipping the flag projects it to live", async () => {
    // 1. CI builds + tests + uploads via fastlane → `uploaded`.
    const runner = new FakeCommandRunner([
      { match: "fastlane android build", exitCode: 0 },
      { match: "fastlane android test", exitCode: 0 },
      { match: "fastlane android upload", exitCode: 0, stdout: "HALYARD_PLAY_VERSION_CODE=4242\n" },
    ]);
    const afterCi = await runRelease({
      app, surface: "android", version: "1.4.0", commit: "abc1234",
      backend, workdir: "/tmp/aurora", runner, now,
    });
    expect(afterCi.state).toBe("uploaded");
    expect(afterCi.external_refs.play_version_code).toBe("4242");

    // 2. Bind to a launch (born-OFF flag) — no Play review on the internal track, so it
    //    rests at `uploaded` awaiting the flag-flip (like web).
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
      createdBy: "alex", createdAt: now(),
    });
    writeRelease(stateDir, bindReleaseToLaunch(afterCi, launch));
    writeLaunch(stateDir, linkRelease(launch, afterCi.release_id));

    const client = new FlagFileClient(stateDir, now);
    await client.ensureFlag(launch.flag!);
    const sources = [flagPollSource(client)];

    // Flag OFF → stays uploaded.
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, afterCi.release_id)!.state).toBe("uploaded");

    // The human flips ON → projects to live.
    await client.setState(launch.flag!, true);
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, afterCi.release_id)!.state).toBe("live");
  });
});
