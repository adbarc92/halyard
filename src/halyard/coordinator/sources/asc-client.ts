import { createSign } from "node:crypto";
import type { Release } from "../../contracts/release.schema.js";
import type { AscClient, ReviewStatus } from "./asc-review.js";
import { fetchWithTimeout } from "../../net.js";

/**
 * Live App Store Connect client. Mints a short-lived ES256 JWT from the ASC API key and
 * reads the app's current App Store version state, normalized to `ReviewStatus`.
 *
 * Credentials come from the environment (populated from the secret store by the
 * workflow) — never from config, never logged. NOTE: this talks to a live Apple
 * endpoint and so is not exercised by the test suite; the review *logic* is verified
 * through `mapReviewStatusToTransition` and a fake client. Treat changes here as
 * integration-tested in CI, not locally.
 */

interface AscCredentials {
  keyId: string;
  issuerId: string;
  privateKeyPem: string;
}

function readCredsFromEnv(): AscCredentials {
  const keyId = process.env.ASC_KEY_ID;
  const issuerId = process.env.ASC_ISSUER_ID;
  const privateKeyPem = process.env.ASC_PRIVATE_KEY;
  if (!keyId || !issuerId || !privateKeyPem) {
    throw new Error(
      "ASC credentials missing from env (ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY)",
    );
  }
  return { keyId, issuerId, privateKeyPem };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

function mintToken(creds: AscCredentials): string {
  const header = { alg: "ES256", kid: creds.keyId, typ: "JWT" };
  const nowSec = Math.floor(Date.now() / 1000);
  const payload = {
    iss: creds.issuerId,
    iat: nowSec,
    exp: nowSec + 600, // ASC caps token lifetime at 20 minutes; 10 is safe
    aud: "appstoreconnect-v1",
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(payload))}`;
  const signer = createSign("SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign({ key: creds.privateKeyPem, dsaEncoding: "ieee-p1363" });
  return `${signingInput}.${b64url(signature)}`;
}

/** ASC raw appStoreState → our normalized status. Exported for testing — this is the
 *  security-relevant mapping that decides when a build becomes `approved` (→ shipped_dark). */
export const RAW_TO_STATUS: Record<string, ReviewStatus> = {
  PROCESSING_FOR_APP_STORE: "processing",
  PREPARE_FOR_SUBMISSION: "processing",
  WAITING_FOR_REVIEW: "waiting_for_review",
  IN_REVIEW: "in_review",
  PENDING_DEVELOPER_RELEASE: "approved",
  PENDING_APPLE_RELEASE: "approved",
  READY_FOR_SALE: "approved",
  ACCEPTED: "approved",
  REJECTED: "rejected",
  DEVELOPER_REJECTED: "rejected",
  METADATA_REJECTED: "rejected",
  INVALID_BINARY: "rejected",
};

/** Normalize a raw ASC appStoreState, defaulting unknown states to `processing` (safe —
 *  an unrecognized state never auto-advances a release to shipped_dark/live). */
export function mapRawAscState(raw: string | undefined): ReviewStatus {
  return (raw && RAW_TO_STATUS[raw]) || "processing";
}

export class LiveAscClient implements AscClient {
  constructor(private readonly ascAppId: string) {}

  async getReviewStatus(_release: Release): Promise<ReviewStatus> {
    const token = mintToken(readCredsFromEnv());
    const url =
      `https://api.appstoreconnect.apple.com/v1/apps/${this.ascAppId}/appStoreVersions` +
      `?limit=1&fields%5BappStoreVersions%5D=appStoreState`;
    const res = await fetchWithTimeout(fetch, url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) {
      throw new Error(`ASC API ${res.status} ${res.statusText}`);
    }
    const body = (await res.json()) as {
      data?: Array<{ attributes?: { appStoreState?: string } }>;
    };
    const raw = body.data?.[0]?.attributes?.appStoreState;
    // An unrecognized state is treated as `processing` (safe — it never auto-advances), but
    // surface it loudly so a release can't sit invisibly on a state Apple newly introduced.
    if (raw && !(raw in RAW_TO_STATUS)) {
      console.warn(`::warning::unrecognized ASC appStoreState '${raw}' for app ${this.ascAppId} — treating as processing`);
    }
    return mapRawAscState(raw);
  }
}
