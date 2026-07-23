import { z } from "zod";

/**
 * The release state machine (§2). One shape serves all surfaces; web/desktop
 * collapse the review states but never leave the set.
 *
 *   tagged → built → tested → uploaded → in_review → shipped_dark → live → rolled_back
 *                       └─ fail ─► dead          └─ reject ─► rejected
 */
export const RELEASE_STATES = [
  "tagged",
  "built",
  "tested",
  "dead", // terminal: tests failed
  "uploaded",
  "in_review",
  "rejected", // store rejected; enters triage loop
  "shipped_dark", // build LIVE, flag OFF — a real resting state, not transient
  "live", // flag flipped ON — the launch moment; publicity fires here
  "rolled_back", // flag flipped OFF after live
] as const;

export const ReleaseStateSchema = z.enum(RELEASE_STATES);
export type ReleaseState = (typeof RELEASE_STATES)[number];
