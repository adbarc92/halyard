/**
 * Expand a flag naming pattern (e.g. "launch.{slug}.{feature}") into a concrete key.
 * Launch flags are short-lived kill-switches; this is the one place the key is formed,
 * so the convention stays consistent across creation, polling, and graduation.
 */
export function flagKeyFor(naming: string, slug: string, feature: string): string {
  return naming.replaceAll("{slug}", slug).replaceAll("{feature}", feature);
}

/**
 * Reserved flag namespace for web auto-promote (`promote_gate: false`). Kept here in the leaf
 * naming module so both the auto-promote helper and graduation can import it without coupling to
 * the reconcile subsystem. Graduation skips this namespace; `flags.naming` may not use it.
 */
export const AUTO_PROMOTE_PREFIX = "halyard.autopromote.";

/** Per-version born-ON flag key for a standalone auto-promoted web release. Version is slugified
 *  to a single safe segment (semver is only conditionally validated upstream). */
export function autoPromoteFlagKey(slug: string, version: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9.]+/g, "-");
  return `${AUTO_PROMOTE_PREFIX}${slug}.${safeVersion}`;
}
