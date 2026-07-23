import { z } from "zod";

/** The four surfaces the coordinator serves. Differences live in config, not the spine. */
export const SURFACES = ["ios", "android", "web", "desktop"] as const;
export const SurfaceSchema = z.enum(SURFACES);
export type Surface = (typeof SURFACES)[number];

/**
 * A 5-field cron expression (minute hour day-of-month month day-of-week).
 * Deliberately permissive on each field's internal syntax (*, ranges, lists,
 * steps) but strict on the shape, so a typo like a 4-field string fails loudly.
 */
const CRON_FIELD = String.raw`(\*|[0-9]+|\*\/[0-9]+|[0-9]+-[0-9]+|[0-9]+(,[0-9]+)+)(\/[0-9]+)?`;
const CRON_PATTERN = new RegExp(`^(${CRON_FIELD})(\\s+${CRON_FIELD}){4}$`);

export const CronSchema = z
  .string()
  .regex(CRON_PATTERN, 'must be a 5-field cron expression, e.g. "*/20 * * * *"');

/** Loose semver (major.minor.patch with optional pre-release/build). */
export const SemverSchema = z
  .string()
  .regex(
    /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/,
    "must be a semantic version, e.g. 1.4.0",
  );

/** Lowercase kebab/snake slug used in ids, flags, and tag patterns. */
export const SlugSchema = z
  .string()
  .regex(/^[a-z][a-z0-9_]*$/, "must be a lowercase slug (letters, digits, underscores)");
