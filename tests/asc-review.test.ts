import { describe, expect, it } from "vitest";
import {
  ascReviewSource,
  mapReviewStatusToTransition,
  type AscClient,
  type ReviewStatus,
} from "../src/halyard/coordinator/sources/asc-review.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

function iosReleaseAt(state: Release["state"]): Release {
  return { ...newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }), state };
}

class FixedAscClient implements AscClient {
  constructor(private readonly status: ReviewStatus) {}
  async getReviewStatus(): Promise<ReviewStatus> {
    return this.status;
  }
}

describe("M3: ASC review status → transition mapping is deterministic", () => {
  it("maps each status to the documented transition", () => {
    expect(mapReviewStatusToTransition("processing")).toBeNull();
    expect(mapReviewStatusToTransition("waiting_for_review")).toMatchObject({ to: "in_review" });
    expect(mapReviewStatusToTransition("in_review")).toMatchObject({ to: "in_review" });
    expect(mapReviewStatusToTransition("approved")).toMatchObject({ to: "shipped_dark" });
    expect(mapReviewStatusToTransition("rejected")).toMatchObject({ to: "rejected" });
  });

  it("approved proposes shipped_dark by the poll, not a human", () => {
    const p = mapReviewStatusToTransition("approved")!;
    expect(p.by).toBe("asc-review-poll");
    expect(p.externalRefs).toMatchObject({ review_status: "approved" });
  });
});

describe("M3: ASC review source only polls in-flight iOS releases", () => {
  it("applies to uploaded/in_review/rejected iOS releases, not others", () => {
    const src = ascReviewSource(new FixedAscClient("processing"));
    expect(src.appliesTo(iosReleaseAt("uploaded"))).toBe(true);
    expect(src.appliesTo(iosReleaseAt("in_review"))).toBe(true);
    expect(src.appliesTo(iosReleaseAt("shipped_dark"))).toBe(false); // parked — stop polling
    expect(src.appliesTo(iosReleaseAt("tagged"))).toBe(false);
    expect(src.appliesTo({ ...iosReleaseAt("uploaded"), surface: "web" })).toBe(false);
  });

  it("emits no proposal while still processing", async () => {
    const src = ascReviewSource(new FixedAscClient("processing"));
    const proposals = await src.poll(iosReleaseAt("uploaded"), { now: () => "t", log: () => {} });
    expect(proposals).toHaveLength(0);
  });
});
