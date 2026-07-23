import { z } from "zod";
import { SurfaceSchema } from "../config/primitives.js";
import { LaunchIdSchema, ReleaseIdSchema } from "./launch.schema.js";
import { ReleaseStateSchema } from "./state.js";

/**
 * Release record (§3) — the projection, per surface per version. The coordinator
 * polls external systems and reconciles them into this record; it is never assumed
 * to be authoritative (invariant #1).
 */

/**
 * Every transition carries a dedup key of `(release_id + transition)` (invariant #3).
 * The system spans days across external services and WILL double-fire; the key is
 * what makes handlers idempotent and replayable. We validate the key's shape here
 * and cross-check it against the record below.
 */
const TransitionSchema = z
  .object({
    to: ReleaseStateSchema,
    at: z.string().datetime(),
    by: z.string().min(1), // "ci", "reconcile", "alex", ...
    dedup_key: z.string().min(1),
  })
  .strict();

export type Transition = z.infer<typeof TransitionSchema>;

export const ExternalRefsSchema = z
  .object({
    asc_build_id: z.string().optional(),
    review_status: z.string().optional(),
    // Android (Play) projection ids, captured at deploy. play_track distinguishes the
    // production track (which goes through a Play review poll, mirroring iOS) from the
    // internal/alpha/beta tracks (which rest at `uploaded` and flip via the flag).
    play_version_code: z.string().optional(),
    play_track: z.enum(["internal", "alpha", "beta", "production"]).optional(),
  })
  .passthrough(); // forward-compat: other surfaces add their own external ids

export const ReleaseSchema = z
  .object({
    release_id: ReleaseIdSchema,
    // A release is created by a tag and MAY be bound to a launch (M4); until then this is null.
    // A standalone auto-promoted web release reaches `live` with launch_id still null — only a
    // non-null flag is required for live/rolled_back (enforced below).
    launch_id: LaunchIdSchema.nullable(),
    app: z.string().min(1),
    surface: SurfaceSchema,
    version: z.string().min(1),
    state: ReleaseStateSchema,
    flag: z.string().min(1).nullable(),
    changelog: z.array(z.string()),
    external_refs: ExternalRefsSchema.default({}),
    transitions: z.array(TransitionSchema),
  })
  .strict()
  .superRefine((rel, ctx) => {
    // Invariant #3 corollary: the launch moment (flag flip) cannot exist without a flag. Earlier
    // states don't need one. (launch_id is NOT required at live — auto-promoted web is standalone;
    // do NOT add a launch_id check here or every auto-promoted release fails validation.)
    if ((rel.state === "live" || rel.state === "rolled_back") && rel.flag === null) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["flag"],
        message: `state "${rel.state}" requires a non-null flag (the flag-flip is the launch moment).`,
      });
    }
    // The canonical dedup key is `${release_id}:${to}` for the first visit to a state,
    // and `${release_id}:${to}#${n}` for the nth re-entry (the resubmit / re-flip loops).
    // Validate each key against a running occurrence count so a malformed or out-of-order
    // key can't slip a duplicate transition past the idempotency check.
    const counts: Partial<Record<string, number>> = {};
    rel.transitions.forEach((t, i) => {
      const n = (counts[t.to] = (counts[t.to] ?? 0) + 1);
      const expected = dedupKey(rel.release_id, t.to, n);
      if (t.dedup_key !== expected) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["transitions", i, "dedup_key"],
          message: `expected "${expected}" (release_id + transition [+ attempt]), got "${t.dedup_key}".`,
        });
      }
    });

    // The record's current state must match its most recent transition.
    const last = rel.transitions.at(-1);
    if (last && last.to !== rel.state) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["state"],
        message: `state "${rel.state}" does not match last transition "${last.to}".`,
      });
    }
  });

export type Release = z.infer<typeof ReleaseSchema>;

/**
 * Build the canonical dedup key for a transition. The one place the rule lives. The first
 * visit to a state is `${releaseId}:${to}` (unchanged from the design); the nth re-entry
 * (n ≥ 2) is `${releaseId}:${to}#${n}`, which is what keeps the resubmit/re-flip loops
 * idempotent without colliding across visits.
 */
export function dedupKey(releaseId: string, to: string, attempt = 1): string {
  return attempt <= 1 ? `${releaseId}:${to}` : `${releaseId}:${to}#${attempt}`;
}
