import { sign, verify } from "node:crypto";
import { FREE, makeEntitlement, selfHostEntitlement, type Entitlement } from "./entitlement.js";

/**
 * Offline license verification. A license is `base64url(payload).base64url(ed25519-sig)`;
 * Halyard ships the public key and verifies locally, so Pro works air-gapped and there is no
 * licensing server in the request path. The matching private key is held by the vendor and
 * used only to *issue* licenses (see scripts/issue-license.ts) — it is never in this repo.
 *
 * Replace DEFAULT_PUBLIC_KEY (or set HALYARD_LICENSE_PUBKEY) with your own verifier key.
 */
const DEFAULT_PUBLIC_KEY =
  "-----BEGIN PUBLIC KEY-----\n" +
  "MCowBQYDK2VwAyEAb20LXTLCJ4bfrUtFu9g2dVEJd4NQJPQI9ZWiIIb6iuE=\n" +
  "-----END PUBLIC KEY-----\n";

export interface LicensePayload {
  licensee: string;
  tier: "pro";
  features: string[];
  issued: string; // ISO timestamp
  expires?: string; // ISO timestamp; omit for a perpetual license
}

function b64url(b: Buffer): string {
  return b.toString("base64url");
}

/** Sign a license payload. Vendor-side only — needs the private key matching the verifier. */
export function issueLicense(payload: LicensePayload, privateKeyPem: string): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8");
  const signature = sign(null, body, privateKeyPem);
  return `${b64url(body)}.${b64url(signature)}`;
}

/**
 * Verify a license token offline. Returns the payload iff the signature checks out against
 * `publicKeyPem` and it hasn't expired; otherwise null. Never throws on a malformed token.
 */
export function verifyLicense(token: string, publicKeyPem: string, nowMs: number): LicensePayload | null {
  try {
    const [b, s] = token.split(".");
    if (!b || !s) return null;
    const body = Buffer.from(b, "base64url");
    const signature = Buffer.from(s, "base64url");
    if (!verify(null, body, publicKeyPem, signature)) return null;
    const payload = JSON.parse(body.toString("utf8")) as LicensePayload;
    if (payload.tier !== "pro" || !Array.isArray(payload.features)) return null;
    if (payload.expires && Date.parse(payload.expires) <= nowMs) return null;
    return payload;
  } catch {
    return null;
  }
}

/**
 * Truthy check for the self-host flag. Only explicit affirmatives enable it; anything else
 * (unset, "0", "false", "off", empty) leaves the open-core gate fully intact.
 */
export function isSelfHostEnabled(value: string | undefined): boolean {
  if (!value) return false;
  const v = value.trim().toLowerCase();
  return v === "1" || v === "true" || v === "yes" || v === "on";
}

/**
 * Resolve the active entitlement. Precedence:
 *   1. A valid signed license key (HALYARD_LICENSE_KEY) — the paid / self-issued path. This is
 *      checked FIRST and its verification is unchanged, so a forged/expired/wrong-key token never
 *      grants Pro (it falls through, fail-safe).
 *   2. Else, if HALYARD_SELF_HOST is explicitly enabled, the self-host entitlement — the supported
 *      path for the portfolio owner to run multi-app acting on their OWN instance. It composes
 *      *additively* with the gate: it grants Pro only when the operator sets the flag; it never
 *      relaxes the key verification above.
 *   3. Else FREE (fail-safe): an absent/invalid key and no self-host flag stays free.
 * The verifier key is HALYARD_LICENSE_PUBKEY if set, else the built-in default.
 */
export function loadEntitlement(opts: {
  get: (name: string) => string | undefined;
  nowMs: number;
  publicKeyPem?: string;
}): Entitlement {
  const token = opts.get("HALYARD_LICENSE_KEY");
  if (token) {
    const pub = opts.publicKeyPem ?? opts.get("HALYARD_LICENSE_PUBKEY") ?? DEFAULT_PUBLIC_KEY;
    const payload = verifyLicense(token, pub, opts.nowMs);
    if (payload) {
      // Valid key wins — keep the real licensee identity from the signed payload.
      return makeEntitlement({
        tier: payload.tier,
        licensee: payload.licensee,
        features: payload.features,
        expiresAt: payload.expires ?? null,
        grant: "license",
        reason: `Pro license verified offline for "${payload.licensee}"`,
      });
    }
    // Invalid/expired/forged token: do NOT grant Pro from it. Fall through to self-host / FREE.
  }
  if (isSelfHostEnabled(opts.get("HALYARD_SELF_HOST"))) return selfHostEntitlement();
  return FREE;
}

// Memoized active entitlement (lazy-loaded from env once), mirroring the secret-store pattern.
let active: Entitlement | null = null;

/** The process's entitlement, lazily resolved from the environment on first use. */
export function getEntitlement(): Entitlement {
  if (active === null) {
    active = loadEntitlement({ get: (n) => process.env[n], nowMs: Date.now() });
    // A self-host grant must be auditable, not silent — announce it once on first resolution.
    if (active.grant === "self-host") console.warn(`halyard: ${active.reason}`);
  }
  return active;
}

/** Override the active entitlement (tests / an embedding host that resolves its own license). */
export function setEntitlement(entitlement: Entitlement): void {
  active = entitlement;
}

/** Clear the memo so the next getEntitlement() re-resolves from the environment. */
export function resetEntitlement(): void {
  active = null;
}
