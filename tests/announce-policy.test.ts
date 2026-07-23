import { describe, expect, it } from "vitest";
import { pendingAnnouncements, scopeKey } from "../src/halyard/publicity/announce-policy.js";
import { newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import type { AnnouncePolicy } from "../src/halyard/config/org-config.schema.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

function launch(policy: AnnouncePolicy) {
  return newLaunch({
    app: "aurora", feature: "f", title: "Offline sync", narrativeSeed: "subway",
    announcePolicy: policy, tier: "standard", flag: "launch.aurora.f",
    createdBy: "x", createdAt: "2025-06-05T00:00:00.000Z",
  });
}

function rel(surface: Release["surface"], state: Release["state"]): Release {
  return {
    ...newRelease({ releaseId: `rel_aurora_${surface}_1`, app: "aurora", surface, version: "1" }),
    state,
    flag: "launch.aurora.f",
    launch_id: "lnch_aurora_f",
  };
}

const none = new Set<string>();

describe("M5: announce policy is deterministic and fires on live", () => {
  it("per_surface: announces each surface as it goes live, once", () => {
    const releases = [rel("web", "live"), rel("ios", "shipped_dark")];
    const first = pendingAnnouncements(launch("per_surface"), releases, none);
    expect(first).toEqual([{ scope: "surface", surface: "web", reason: "web live" }]);

    // After web announced, nothing pending until ios goes live.
    const announced = new Set(["surface:web"]);
    expect(pendingAnnouncements(launch("per_surface"), releases, announced)).toEqual([]);
    expect(
      pendingAnnouncements(launch("per_surface"), [rel("web", "live"), rel("ios", "live")], announced),
    ).toEqual([{ scope: "surface", surface: "ios", reason: "ios live" }]);
  });

  it("first_surface: announces once, on the first live surface", () => {
    const releases = [rel("web", "live"), rel("ios", "live")];
    const p = pendingAnnouncements(launch("first_surface"), releases, none);
    expect(p).toEqual([{ scope: "launch", surface: "web", reason: "first surface live" }]);
    expect(pendingAnnouncements(launch("first_surface"), releases, new Set(["launch"]))).toEqual([]);
  });

  it("all_surfaces: waits until every DECLARED release is live", () => {
    // A launch that declares two releases.
    const declared = { ...launch("all_surfaces"), releases: ["rel_aurora_web_1", "rel_aurora_ios_1"] };

    // One live, one not → wait.
    expect(pendingAnnouncements(declared, [rel("web", "live"), rel("ios", "shipped_dark")], none)).toEqual([]);

    // Both live → announce.
    expect(pendingAnnouncements(declared, [rel("web", "live"), rel("ios", "live")], none)).toEqual([
      { scope: "launch", reason: "all surfaces live" },
    ]);

    // Regression: only one of the two declared releases exists/loaded yet, and it's live.
    // Must NOT announce "all surfaces" with a subset (previously fired prematurely).
    expect(pendingAnnouncements(declared, [rel("web", "live")], none)).toEqual([]);
  });

  it("never fires when no release is live", () => {
    expect(pendingAnnouncements(launch("per_surface"), [rel("web", "shipped_dark")], none)).toEqual([]);
  });

  it("scopeKey distinguishes surface vs launch scope", () => {
    expect(scopeKey({ scope: "surface", surface: "web", reason: "" })).toBe("surface:web");
    expect(scopeKey({ scope: "launch", reason: "" })).toBe("launch");
  });
});
