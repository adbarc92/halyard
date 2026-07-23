import { z } from "zod";
import { AnnouncePolicySchema, TierSchema } from "../config/org-config.schema.js";
import { SlugSchema } from "../config/primitives.js";

/**
 * Launch object (§3) — surface-agnostic feature + narrative + announcement policy.
 * A launch fans out into one release per surface/version. "Did we launch X?" only
 * has an answer at this level (invariant: launch ≠ release).
 */

export const LAUNCH_ID_PREFIX = "lnch_";
const LaunchIdSchema = z
  .string()
  .regex(/^lnch_[a-z0-9_]+$/, 'launch_id must look like "lnch_<slug>"');

export const RELEASE_ID_PREFIX = "rel_";
const ReleaseIdSchema = z
  .string()
  .regex(/^rel_[a-z0-9_.]+$/, 'release_id must look like "rel_<app>_<surface>_<version>"');

export const LaunchSchema = z
  .object({
    launch_id: LaunchIdSchema,
    app: SlugSchema,
    title: z.string().min(1),
    // The single highest-value human input: *why it matters*, not what changed.
    narrative_seed: z.string().min(1),
    announce_policy: AnnouncePolicySchema,
    tier: TierSchema,
    releases: z.array(ReleaseIdSchema),
    // The feature flag the launch gates. Derived from the app's `naming` pattern at
    // launch creation (born OFF); each linked release inherits it. Optional because a
    // launch can be drafted before its flag exists.
    flag: z.string().min(1).optional(),
    created_by: z.string().min(1),
    created_at: z.string().datetime(),
  })
  .strict();

export type Launch = z.infer<typeof LaunchSchema>;
export { LaunchIdSchema, ReleaseIdSchema };
