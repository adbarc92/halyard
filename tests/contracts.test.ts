import { describe, expect, it } from "vitest";
import { LaunchSchema } from "../src/halyard/contracts/launch.schema.js";
import { ReleaseSchema, dedupKey } from "../src/halyard/contracts/release.schema.js";

const validLaunch = {
  launch_id: "lnch_aurora_offline_sync",
  app: "aurora",
  title: "Offline sync",
  narrative_seed:
    "Aurora now works on the subway — full read/write offline, syncs on reconnect.",
  announce_policy: "per_surface",
  tier: "standard",
  releases: ["rel_aurora_ios_1.4.0", "rel_aurora_web_2025.06.04"],
  created_by: "alex",
  created_at: "2025-06-04T00:00:00Z",
};

const validRelease = {
  release_id: "rel_aurora_ios_1.4.0",
  launch_id: "lnch_aurora_offline_sync",
  app: "aurora",
  surface: "ios",
  version: "1.4.0",
  state: "built",
  flag: "launch.aurora.offline_sync",
  changelog: ["feat: offline sync", "fix: token refresh race"],
  external_refs: { asc_build_id: "9001", review_status: "pending" },
  transitions: [
    {
      to: "built",
      at: "2025-06-04T00:01:00Z",
      by: "ci",
      dedup_key: "rel_aurora_ios_1.4.0:built",
    },
  ],
};

describe("M0 verify: contracts validate sample records", () => {
  it("accepts a valid launch object", () => {
    expect(() => LaunchSchema.parse(validLaunch)).not.toThrow();
  });

  it("accepts a valid release record", () => {
    expect(() => ReleaseSchema.parse(validRelease)).not.toThrow();
  });

  it("dedupKey builds the canonical (release_id + transition) key", () => {
    expect(dedupKey("rel_aurora_ios_1.4.0", "built")).toBe("rel_aurora_ios_1.4.0:built");
  });
});

describe("M0 verify: contracts reject malformed records", () => {
  it("rejects a transition whose dedup_key is missing", () => {
    const bad = structuredClone(validRelease);
    // @ts-expect-error intentionally drop the key
    delete bad.transitions[0].dedup_key;
    expect(() => ReleaseSchema.parse(bad)).toThrow();
  });

  it("rejects a transition whose dedup_key is not (release_id + transition)", () => {
    const bad = structuredClone(validRelease);
    bad.transitions[0]!.dedup_key = "rel_aurora_ios_1.4.0:wrong";
    expect(() => ReleaseSchema.parse(bad)).toThrowError(/release_id \+ transition/);
  });

  it("rejects a record whose state disagrees with its last transition", () => {
    const bad = structuredClone(validRelease);
    bad.state = "live";
    expect(() => ReleaseSchema.parse(bad)).toThrowError(
      /does not match last transition/,
    );
  });

  it("rejects an unknown state", () => {
    const bad = structuredClone(validRelease);
    bad.state = "frozen";
    expect(() => ReleaseSchema.parse(bad)).toThrow();
  });

  it("rejects a launch_id with the wrong prefix", () => {
    const bad = structuredClone(validLaunch);
    bad.launch_id = "launch_aurora_offline_sync";
    expect(() => LaunchSchema.parse(bad)).toThrow();
  });
});
