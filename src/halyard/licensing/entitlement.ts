/**
 * Open-core entitlement model. Halyard's core (release coordination + publicity) is free;
 * a paid **Pro** tier unlocks the features below. Entitlement is decided from a signed
 * license key (see license.ts) verified offline — no phone-home, no network dependency.
 *
 * Fail-safe direction: anything unverified resolves to FREE (never an error, never Pro).
 */
export type LicenseTier = "free" | "pro";

/**
 * How a Pro entitlement was obtained. This is recorded on every entitlement so the grant is
 * *auditable* — a `"self-host"` grant is never silent (see `getEntitlement` and `halyard license`).
 *  - `"none"`      — no Pro entitlement (FREE).
 *  - `"license"`   — a signed Ed25519 license key was verified offline (paid or self-issued).
 *  - `"self-host"` — the portfolio owner unlocked their OWN instance via `HALYARD_SELF_HOST`.
 */
export type EntitlementGrant = "none" | "license" | "self-host";

/** The Pro boundary. Core release+publicity stays free; these require a Pro license. */
export const PRO_FEATURES = ["ai-agents", "auto-merge", "multi-app"] as const;
export type ProFeature = (typeof PRO_FEATURES)[number];

export interface Entitlement {
  tier: LicenseTier;
  licensee: string | null;
  features: ReadonlySet<string>;
  expiresAt: string | null;
  /** Provenance of this entitlement — how Pro was granted (for auditability). */
  grant: EntitlementGrant;
  /** Human-readable one-liner explaining the grant (surfaced in logs / `halyard license`). */
  reason: string;
  has(feature: ProFeature): boolean;
}

export function makeEntitlement(args: {
  tier: LicenseTier;
  licensee: string | null;
  features: readonly string[];
  expiresAt: string | null;
  grant?: EntitlementGrant;
  reason?: string;
}): Entitlement {
  const features = new Set(args.features);
  const grant: EntitlementGrant = args.grant ?? (args.tier === "pro" ? "license" : "none");
  const reason =
    args.reason ??
    (grant === "none"
      ? "no Pro license — running the free open-core tier"
      : `Pro entitlement granted via ${grant}`);
  return {
    tier: args.tier,
    licensee: args.licensee,
    features,
    expiresAt: args.expiresAt,
    grant,
    reason,
    has: (feature) => features.has(feature),
  };
}

/** The default tier when no valid Pro license is present. */
export const FREE: Entitlement = makeEntitlement({
  tier: "free",
  licensee: null,
  features: [],
  expiresAt: null,
  grant: "none",
});

/**
 * The `licensee` recorded for a self-host grant. It is intentionally NOT a real customer name —
 * it makes `halyard license` show `"licensee": "self-host"`, so the grant is visible at a glance.
 */
export const SELF_HOST_LICENSEE = "self-host";

/**
 * The self-host entitlement — the supported path for the portfolio OWNER to run multi-app acting
 * across their OWN instance without buying an external license.
 *
 * Why this is NOT a bypass for external users: the open-core gate still requires either a valid
 * signed license key OR this explicit, operator-set `HALYARD_SELF_HOST` flag on the machine that
 * runs Halyard. A random external consumer of the library/CLI has neither, so they stay gated.
 * "Self-host" means exactly "I operate this instance" — asserted by whoever controls the process
 * environment, which is the same trust boundary as the license key itself.
 */
export function selfHostEntitlement(): Entitlement {
  return makeEntitlement({
    tier: "pro",
    licensee: SELF_HOST_LICENSEE,
    features: [...PRO_FEATURES],
    expiresAt: null,
    grant: "self-host",
    reason:
      "self-host entitlement (HALYARD_SELF_HOST) — portfolio owner running their own instance; " +
      "not a paid license, unlocks Pro features for this operator's own portfolio",
  });
}

/**
 * Guard for the multi-app Pro feature. Throws a clear upgrade error rather than silently
 * dropping apps — a launch coordinator must never quietly ignore an app.
 */
export function enforceMultiApp(appCount: number, entitlement: Entitlement): void {
  if (appCount > 1 && !entitlement.has("multi-app")) {
    throw new Error(
      `multi-app coordination is a Halyard Pro feature (found ${appCount} apps). ` +
        `Provide a Pro license via HALYARD_LICENSE_KEY, set HALYARD_SELF_HOST=1 if you own and ` +
        `operate this instance, or operate one app at a time (--apps <slug>).`,
    );
  }
}
