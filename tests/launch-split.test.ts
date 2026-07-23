import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  bindReleaseToLaunch,
  linkRelease,
  newLaunch,
  readLaunch,
  writeLaunch,
} from "../src/halyard/coordinator/launch-store.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { flagKeyFor } from "../src/halyard/flags/naming.js";

let stateDir: string;
const now = () => "2025-06-05T06:00:00.000Z";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-launch-"));
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M4: launch/release split + flag born OFF", () => {
  it("derives the flag key from the naming pattern", () => {
    expect(flagKeyFor("launch.{slug}.{feature}", "aurora", "offline_sync")).toBe(
      "launch.aurora.offline_sync",
    );
  });

  it("creates a launch with a flag and binds a release to it", async () => {
    const flag = flagKeyFor("launch.{slug}.{feature}", "aurora", "offline_sync");
    const launch = newLaunch({
      app: "aurora",
      feature: "offline_sync",
      title: "Offline sync",
      narrativeSeed: "Aurora now works on the subway.",
      announcePolicy: "per_surface",
      tier: "standard",
      flag,
      createdBy: "alex",
      createdAt: now(),
    });
    writeLaunch(stateDir, launch);
    expect(launch.launch_id).toBe("lnch_aurora_offline_sync");

    // Flag is born OFF.
    const client = new FlagFileClient(stateDir, now);
    await client.ensureFlag(flag);
    expect(await client.getState(flag)).toBe("off");

    // A release created by a tag is initially unbound (launch_id/flag null)...
    let release = appendTransition(
      newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
      "tagged",
      "ci",
      now,
    );
    expect(release.launch_id).toBeNull();
    expect(release.flag).toBeNull();

    // ...then linking binds the launch_id + flag both ways.
    release = bindReleaseToLaunch(release, launch);
    writeRelease(stateDir, release);
    writeLaunch(stateDir, linkRelease(launch, release.release_id));

    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.flag).toBe(flag);
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!.launch_id).toBe("lnch_aurora_offline_sync");
    expect(readLaunch(stateDir, "lnch_aurora_offline_sync")!.releases).toContain("rel_aurora_ios_1.4.0");
  });

  it("linkRelease is idempotent", () => {
    const launch = newLaunch({
      app: "aurora", feature: "f", title: "t", narrativeSeed: "n",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.f",
      createdBy: "x", createdAt: now(),
    });
    const once = linkRelease(launch, "rel_aurora_web_1.0.0");
    const twice = linkRelease(once, "rel_aurora_web_1.0.0");
    expect(twice.releases).toEqual(["rel_aurora_web_1.0.0"]);
  });
});
