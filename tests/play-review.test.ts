import { describe, expect, it, vi } from "vitest";
import {
  playReviewSource,
  mapPlayReviewStatusToTransition,
  type PlayReviewStatus,
} from "../src/halyard/coordinator/sources/play-review.js";
import type { PlayClient } from "../src/halyard/coordinator/sources/play-client.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

type ExternalRefs = Release["external_refs"];

function androidReleaseAt(state: Release["state"], externalRefs: ExternalRefs = {}): Release {
  return {
    ...newRelease({
      releaseId: "rel_aurora_android_1.4.0",
      app: "aurora",
      surface: "android",
      version: "1.4.0",
    }),
    state,
    external_refs: externalRefs,
  };
}

const PROD = { play_track: "production" as const, play_version_code: "42" };

class FixedPlayClient implements PlayClient {
  constructor(private readonly status: PlayReviewStatus) {}
  async getReviewStatus(): Promise<PlayReviewStatus> {
    return this.status;
  }
}

const ctx = { now: () => "t", log: () => {} };

describe("Play review status → transition mapping is deterministic", () => {
  it("maps each status to the documented transition", () => {
    expect(mapPlayReviewStatusToTransition("processing")).toBeNull();
    expect(mapPlayReviewStatusToTransition("in_review")).toMatchObject({ to: "in_review" });
    expect(mapPlayReviewStatusToTransition("approved")).toMatchObject({ to: "shipped_dark" });
    expect(mapPlayReviewStatusToTransition("rejected")).toMatchObject({ to: "rejected" });
  });

  it("approved proposes shipped_dark by the poll, not a human", () => {
    const p = mapPlayReviewStatusToTransition("approved")!;
    expect(p.by).toBe("play-review-poll");
    expect(p.externalRefs).toMatchObject({ review_status: "approved" });
  });

  it("in_review records the raw status it observed", () => {
    const p = mapPlayReviewStatusToTransition("in_review")!;
    expect(p.by).toBe("play-review-poll");
    expect(p.externalRefs).toMatchObject({ review_status: "in_review" });
  });
});

describe("Play review source only polls in-flight production-track Android releases", () => {
  const src = playReviewSource(new FixedPlayClient("processing"));

  it("applies to uploaded/in_review/rejected production Android releases", () => {
    expect(src.appliesTo(androidReleaseAt("uploaded", PROD))).toBe(true);
    expect(src.appliesTo(androidReleaseAt("in_review", PROD))).toBe(true);
    expect(src.appliesTo(androidReleaseAt("rejected", PROD))).toBe(true);
  });

  it("does not apply to parked/early states", () => {
    expect(src.appliesTo(androidReleaseAt("shipped_dark", PROD))).toBe(false); // parked — stop polling
    expect(src.appliesTo(androidReleaseAt("tagged", PROD))).toBe(false);
  });

  it("does not apply to non-android surfaces", () => {
    expect(src.appliesTo({ ...androidReleaseAt("uploaded", PROD), surface: "ios" })).toBe(false);
    expect(src.appliesTo({ ...androidReleaseAt("uploaded", PROD), surface: "web" })).toBe(false);
  });

  it("does not apply to non-production tracks (internal/alpha/beta rest at uploaded)", () => {
    for (const track of ["internal", "alpha", "beta"] as const) {
      const rel = androidReleaseAt("uploaded", { play_track: track, play_version_code: "42" });
      expect(src.appliesTo(rel)).toBe(false);
    }
    // A production-track release with no track set at all also does not apply.
    expect(src.appliesTo(androidReleaseAt("uploaded", { play_version_code: "42" }))).toBe(false);
  });
});

describe("Play review poll requires a versionCode before consulting the client", () => {
  it("yields no proposal and does not consult the client when play_version_code is missing", async () => {
    const client = new FixedPlayClient("approved"); // would advance if consulted
    const spy = vi.spyOn(client, "getReviewStatus");
    const src = playReviewSource(client);
    const rel = androidReleaseAt("uploaded", { play_track: "production" }); // no version code
    const proposals = await src.poll(rel, ctx);
    expect(proposals).toHaveLength(0);
    expect(spy).not.toHaveBeenCalled();
  });

  it("emits no proposal while still processing", async () => {
    const src = playReviewSource(new FixedPlayClient("processing"));
    const proposals = await src.poll(androidReleaseAt("uploaded", PROD), ctx);
    expect(proposals).toHaveLength(0);
  });
});

describe("Play review poll advances a production release across sweeps", () => {
  it("uploaded → in_review → shipped_dark as the fake client reports each status", async () => {
    const inReviewSrc = playReviewSource(new FixedPlayClient("in_review"));
    const approvedSrc = playReviewSource(new FixedPlayClient("approved"));

    const uploaded = androidReleaseAt("uploaded", PROD);
    const first = await inReviewSrc.poll(uploaded, ctx);
    expect(first).toEqual([
      { to: "in_review", by: "play-review-poll", externalRefs: { review_status: "in_review" } },
    ]);

    const inReview = androidReleaseAt("in_review", PROD);
    const second = await approvedSrc.poll(inReview, ctx);
    expect(second).toEqual([
      { to: "shipped_dark", by: "play-review-poll", externalRefs: { review_status: "approved" } },
    ]);
  });

  it("a non-production release has no applicable source (left untouched)", () => {
    const src = playReviewSource(new FixedPlayClient("approved"));
    const rel = androidReleaseAt("uploaded", { play_track: "beta", play_version_code: "42" });
    expect(src.appliesTo(rel)).toBe(false);
  });
});
