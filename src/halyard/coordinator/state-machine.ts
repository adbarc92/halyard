import type { Release } from "../contracts/release.schema.js";
import type { ReleaseState } from "../contracts/state.js";
import { appendTransition, isCurrentState } from "./record-store.js";

/**
 * The release state machine (§2), made explicit. The coordinator may only ever move a
 * record along a legal edge; an illegal proposal is rejected, not written. Combined
 * with the `(release_id + transition)` dedup key, this is what makes reconciliation
 * idempotent and replayable (invariant #3): a double-fire is either a duplicate (same
 * target, already present) or an illegal re-entry (state has since advanced).
 *
 *   tagged → built → tested → uploaded → in_review → shipped_dark → live → rolled_back
 *      └──── dead ◄──── (any pre-live state can fail) ────┘
 *   uploaded → live           (web/desktop: promote-to-prod, no review — wired at M4)
 *   in_review → rejected → in_review   (the triage/resubmit loop — wired at M3)
 */
export const LEGAL_TRANSITIONS: Record<ReleaseState, readonly ReleaseState[]> = {
  tagged: ["built", "dead"],
  built: ["tested", "dead"],
  tested: ["uploaded", "dead"],
  // The review poll is lossy: between cron passes a build may jump from processing
  // straight to approved or rejected, so `uploaded` may reach `shipped_dark`/`rejected`
  // without us observing the intermediate `in_review` (invariant #1).
  uploaded: ["in_review", "shipped_dark", "rejected", "live", "dead"],
  in_review: ["shipped_dark", "rejected", "dead"],
  // The same lossy poll applies to the resubmit path: between cron passes a rejected build
  // can be fixed, resubmitted, and re-approved by Apple, so the poll observes `approved`
  // (→ shipped_dark) without the intermediate `in_review`. Allow that jump or the release
  // strands at `rejected` forever (the edge mirrors `uploaded`'s lossy `→ shipped_dark`).
  rejected: ["in_review", "shipped_dark", "dead"],
  shipped_dark: ["live", "dead"],
  live: ["rolled_back"],
  // Re-flippable: flipping the flag back ON after a rollback returns the release to live
  // (recorded as `live#2` via the attempt-qualified dedup key).
  rolled_back: ["live", "dead"],
  dead: [], // terminal
};

export function legalNextStates(from: ReleaseState): readonly ReleaseState[] {
  return LEGAL_TRANSITIONS[from];
}

export function isLegalTransition(from: ReleaseState, to: ReleaseState): boolean {
  return LEGAL_TRANSITIONS[from].includes(to);
}

export function isTerminal(state: ReleaseState): boolean {
  return LEGAL_TRANSITIONS[state].length === 0;
}

export type ApplyOutcome =
  | { applied: true; release: Release }
  | { applied: false; release: Release; reason: "duplicate" | "illegal" };

/**
 * Apply a single transition with full guard rails:
 *   1. dedup — if the release is already in the target state, it's a no-op (double-fire).
 *      A re-entry into a *previously* visited state (resubmit, re-flip) is NOT a duplicate.
 *   2. legality — if the current state can't reach the target, reject without writing.
 *   3. otherwise append the transition with its (attempt-qualified) dedup key.
 */
export function applyTransition(
  release: Release,
  to: ReleaseState,
  by: string,
  now: () => string,
): ApplyOutcome {
  if (isCurrentState(release, to)) {
    return { applied: false, release, reason: "duplicate" };
  }
  if (!isLegalTransition(release.state, to)) {
    return { applied: false, release, reason: "illegal" };
  }
  return { applied: true, release: appendTransition(release, to, by, now) };
}
