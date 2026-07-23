import type { Release } from "../../contracts/release.schema.js";
import type { ReconcileSource, TransitionProposal } from "../reconcile.js";
import type { PlayClient } from "./play-client.js";

/**
 * Google Play production-track review poll — the exact mirror of the App Store Connect
 * review poll (asc-review.ts). The coordinator is a projection: this source asks Play for
 * a build's review/track-release status and turns it into a transition proposal. The
 * status→transition map is a pure, deterministic function kept separate from the API
 * client, so the "what does Play's state mean for us" decision stays trivially auditable
 * (invariant #2). The client (truth) and the mapping (meaning) are split.
 *
 * Opt-in is `external_refs.play_track === "production"`, NOT a new config field. Only the
 * production track goes through a real Play review; internal/alpha/beta tracks have no
 * review gate and rest at `uploaded`, flipping to `live` via the flag-poll (the same
 * resting shape as web). See surfaces/android.ts.
 *
 * Rejection behavior (mirrors ASC): a `rejected` production release STAYS pollable, so a
 * developer resubmit re-enters `in_review` on the next sweep. The poll itself does NOT
 * auto-resubmit — sources report external truth and never take outward action.
 */

/**
 * Normalized review status, decoupled from Play's raw track-release / review vocabulary.
 * Mirrors asc-review's `ReviewStatus`. Map Play's raw names EXPLICITLY in play-client.ts —
 * do not assume Play's names match ASC's.
 */
export type PlayReviewStatus =
  | "processing" // uploaded, Play still processing the bundle — stay at `uploaded`
  | "in_review" // queued for or actively under Play review
  | "approved" // approved/published build → ships dark (flag still OFF)
  | "rejected"; // rejected/halted by Play review

/** Deterministic: Play review status → the transition it implies (or none). */
export function mapPlayReviewStatusToTransition(
  status: PlayReviewStatus,
): TransitionProposal | null {
  switch (status) {
    case "processing":
      return null; // no movement yet
    case "in_review":
      return { to: "in_review", by: "play-review-poll", externalRefs: { review_status: status } };
    case "approved":
      // The build is live on Play but the feature flag stays OFF — this is `shipped_dark`,
      // the resting state where the release waits for the human flag-flip (M4).
      return {
        to: "shipped_dark",
        by: "play-review-poll",
        externalRefs: { review_status: "approved" },
      };
    case "rejected":
      return { to: "rejected", by: "play-review-poll", externalRefs: { review_status: "rejected" } };
  }
}

/** The reconcile source: polls Play for in-flight production-track Android releases. */
export function playReviewSource(client: PlayClient): ReconcileSource {
  // Same pollable set as ASC: an uploaded build is in flight; a rejected one stays
  // pollable so a resubmit re-enters in_review; shipped_dark is parked (stop polling).
  const POLLABLE_STATES = new Set(["uploaded", "in_review", "rejected"]);
  return {
    name: "play-review-poll",
    appliesTo: (release) =>
      release.surface === "android" &&
      release.external_refs.play_track === "production" &&
      POLLABLE_STATES.has(release.state),
    poll: async (release, ctx) => {
      // Unlike ASC (whose client queries the latest version and ignores the release), the
      // Play API needs the package + versionCode to identify the build. Without the
      // versionCode we can't query, so propose nothing — never call the client blind.
      const versionCode = release.external_refs.play_version_code;
      if (!versionCode) {
        ctx.log(`[play] ${release.release_id}: no play_version_code yet — skipping poll`);
        return [];
      }
      const status = await client.getReviewStatus(release);
      ctx.log(`[play] ${release.release_id}: review=${status} (versionCode=${versionCode})`);
      const proposal = mapPlayReviewStatusToTransition(status);
      return proposal ? [proposal] : [];
    },
  };
}
