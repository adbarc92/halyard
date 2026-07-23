import type { Release } from "../../contracts/release.schema.js";
import type { ReconcileSource, TransitionProposal } from "../reconcile.js";

/**
 * App Store Connect review poll (M3). The coordinator is a projection: this source
 * asks ASC for a build's review status and turns it into a transition proposal. The
 * status→transition map is a pure, deterministic function kept separate from the HTTP
 * client, so the "what does Apple's state mean for us" decision stays trivially
 * auditable (invariant #2). The client (truth) and the mapping (meaning) are split.
 */

/** Normalized review status, decoupled from ASC's raw `appStoreState` vocabulary. */
export type ReviewStatus =
  | "processing" // uploaded, Apple still processing — stay at `uploaded`
  | "waiting_for_review" // submitted, queued at Apple
  | "in_review" // actively under review
  | "approved" // approved/released build → ships dark (flag still OFF)
  | "rejected";

export interface AscClient {
  /** Normalized review status for a release (keys off external_refs.asc_build_id). */
  getReviewStatus(release: Release): Promise<ReviewStatus>;
}

/** Deterministic: ASC review status → the transition it implies (or none). */
export function mapReviewStatusToTransition(status: ReviewStatus): TransitionProposal | null {
  switch (status) {
    case "processing":
      return null; // no movement yet
    case "waiting_for_review":
    case "in_review":
      return { to: "in_review", by: "asc-review-poll", externalRefs: { review_status: status } };
    case "approved":
      // The build is live but the feature flag stays OFF — this is `shipped_dark`,
      // the resting state where the release waits for the human flag-flip (M4).
      return {
        to: "shipped_dark",
        by: "asc-review-poll",
        externalRefs: { review_status: "approved" },
      };
    case "rejected":
      return { to: "rejected", by: "asc-review-poll", externalRefs: { review_status: "rejected" } };
  }
}

/** The reconcile source: polls ASC for in-flight iOS releases and proposes transitions. */
export function ascReviewSource(client: AscClient): ReconcileSource {
  const POLLABLE_STATES = new Set(["uploaded", "in_review", "rejected"]);
  return {
    name: "asc-review-poll",
    appliesTo: (release) => release.surface === "ios" && POLLABLE_STATES.has(release.state),
    poll: async (release, ctx) => {
      const status = await client.getReviewStatus(release);
      ctx.log(`[asc] ${release.release_id}: review=${status}`);
      const proposal = mapReviewStatusToTransition(status);
      return proposal ? [proposal] : [];
    },
  };
}
