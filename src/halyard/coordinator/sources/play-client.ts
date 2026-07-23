import { createSign } from "node:crypto";
import type { Release } from "../../contracts/release.schema.js";
import type { PlayReviewStatus } from "./play-review.js";
import { fetchWithTimeout } from "../../net.js";

/**
 * Live Google Play Developer API client. Mirrors the spirit of LiveAscClient, but auth is
 * a SERVICE-ACCOUNT JSON (not ASC's API-key JWT): we mint a Google OAuth2 access token by
 * signing a JWT assertion with the service account's private key (RS256), exchange it at
 * the Google token endpoint, then read the build's track-release status, normalized to
 * `PlayReviewStatus`.
 *
 * The service-account JSON comes from the environment under `SUPPLY_JSON_KEY_DATA` — the
 * SAME runtime env var the Android `supply` upload path uses (fastlane/Fastfile lane
 * `upload`; .github/workflows/release.yml maps `secrets.PLAY_SERVICE_ACCOUNT` →
 * `SUPPLY_JSON_KEY_DATA`; see docs/LAUNCH-READINESS.md). It is read from env, never from
 * config, and NEVER logged (invariant #4).
 *
 * NOTE: this talks to a live Google endpoint and so is not exercised by the test suite;
 * the review *logic* is verified through `mapPlayReviewStatusToTransition`, `mapRawPlayStatus`,
 * and a fake client. Treat changes here as CI-integration-tested, not locally.
 */

export interface PlayClient {
  /** Normalized review status for a release (keys off external_refs.play_version_code). */
  getReviewStatus(release: Release): Promise<PlayReviewStatus>;
}

interface ServiceAccount {
  client_email: string;
  private_key: string;
}

function readServiceAccountFromEnv(): ServiceAccount {
  const raw = process.env.SUPPLY_JSON_KEY_DATA;
  if (!raw) {
    throw new Error(
      "Play service-account JSON missing from env (SUPPLY_JSON_KEY_DATA) — set by the workflow from the secret store",
    );
  }
  let parsed: Partial<ServiceAccount>;
  try {
    parsed = JSON.parse(raw) as Partial<ServiceAccount>;
  } catch {
    // Never echo the raw value — it's the credential.
    throw new Error("SUPPLY_JSON_KEY_DATA is not valid JSON");
  }
  if (!parsed.client_email || !parsed.private_key) {
    throw new Error("SUPPLY_JSON_KEY_DATA missing client_email/private_key");
  }
  return { client_email: parsed.client_email, private_key: parsed.private_key };
}

function b64url(input: string | Buffer): string {
  return Buffer.from(input).toString("base64url");
}

/**
 * Mint a Google OAuth2 access token from the service account via the JWT-bearer grant
 * (RS256-signed assertion → token endpoint). Scope is read-only Android publisher.
 */
async function mintAccessToken(sa: ServiceAccount): Promise<string> {
  const nowSec = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claims = {
    iss: sa.client_email,
    scope: "https://www.googleapis.com/auth/androidpublisher",
    aud: "https://oauth2.googleapis.com/token",
    iat: nowSec,
    exp: nowSec + 3600, // Google caps assertion lifetime at 1 hour
  };
  const signingInput = `${b64url(JSON.stringify(header))}.${b64url(JSON.stringify(claims))}`;
  const signer = createSign("RSA-SHA256");
  signer.update(signingInput);
  signer.end();
  const signature = signer.sign(sa.private_key);
  const assertion = `${signingInput}.${b64url(signature)}`;

  const res = await fetchWithTimeout(fetch, "https://oauth2.googleapis.com/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion,
    }),
  });
  if (!res.ok) {
    // Body may carry a Google error code; it does not contain the private key.
    throw new Error(`Google token endpoint ${res.status} ${res.statusText}`);
  }
  const body = (await res.json()) as { access_token?: string };
  if (!body.access_token) {
    throw new Error("Google token endpoint returned no access_token");
  }
  return body.access_token;
}

/**
 * Play track-release `status` (and review-derived states) → our normalized status.
 * Exported for testing — this is the security-relevant mapping that decides when a build
 * becomes `approved` (→ shipped_dark).
 *
 * Source: Google Play Developer API v3, `edits.tracks` resource — a track release carries
 * `status ∈ { statusUnspecified, draft, inProgress, halted, completed }`
 * (https://developers.google.com/android-publisher/api-ref/rest/v3/edits.tracks#Status).
 * A `completed` production release is live for review/rollout (→ approved → shipped_dark);
 * `inProgress` is a staged/in-flight rollout, treated as still under review (→ in_review);
 * `halted` is an operator/Play stop (→ rejected, mirroring a developer-rejected ASC build);
 * `draft`/`statusUnspecified` are not yet submitted (→ processing, no auto-advance). The
 * extra raw keys (`inReview`, `pendingPublication`, `rejected`) cover Play Console review
 * vocabulary so a future surfacing of an explicit review state maps explicitly, not by
 * accident.
 */
export const RAW_TO_STATUS: Record<string, PlayReviewStatus> = {
  statusUnspecified: "processing",
  draft: "processing",
  inProgress: "in_review",
  inReview: "in_review",
  pendingPublication: "in_review",
  completed: "approved",
  halted: "rejected",
  rejected: "rejected",
};

/** Normalize a raw Play status, defaulting unknown statuses to `processing` (safe — an
 *  unrecognized status never auto-advances a release to shipped_dark/live). */
export function mapRawPlayStatus(raw: string | undefined): PlayReviewStatus {
  return (raw && RAW_TO_STATUS[raw]) || "processing";
}

export class LivePlayClient implements PlayClient {
  constructor(private readonly packageName: string) {}

  async getReviewStatus(release: Release): Promise<PlayReviewStatus> {
    const versionCode = release.external_refs.play_version_code;
    const track = release.external_refs.play_track ?? "production";
    // The source never calls us without a versionCode, but guard so the live client can't
    // silently query the wrong build.
    if (!versionCode) {
      throw new Error(`release ${release.release_id} has no play_version_code`);
    }

    const token = await mintAccessToken(readServiceAccountFromEnv());

    // Reading a track's releases requires an active edit. Create a throwaway (read-only)
    // edit, fetch the track, then find the release that contains this versionCode.
    // (Kept minimal/hand-rolled — like asc-client — and CI-integration-tested, not locally.)
    const base = `https://androidpublisher.googleapis.com/androidpublisher/v3/applications/${encodeURIComponent(this.packageName)}`;
    const auth = { Authorization: `Bearer ${token}` };

    const editRes = await fetchWithTimeout(fetch, `${base}/edits`, { method: "POST", headers: auth });
    if (!editRes.ok) {
      throw new Error(`Play edits.insert ${editRes.status} ${editRes.statusText}`);
    }
    const edit = (await editRes.json()) as { id?: string };
    if (!edit.id) {
      throw new Error("Play edits.insert returned no edit id");
    }

    const trackRes = await fetchWithTimeout(
      fetch,
      `${base}/edits/${encodeURIComponent(edit.id)}/tracks/${encodeURIComponent(track)}`,
      { headers: auth },
    );
    if (!trackRes.ok) {
      throw new Error(`Play edits.tracks.get ${trackRes.status} ${trackRes.statusText}`);
    }
    const trackBody = (await trackRes.json()) as {
      releases?: Array<{ status?: string; versionCodes?: string[] }>;
    };

    // Find the release that carries our versionCode; fall back to the first release.
    const match =
      trackBody.releases?.find((r) => r.versionCodes?.some((vc) => String(vc) === String(versionCode))) ??
      trackBody.releases?.[0];
    const raw = match?.status;

    // An unrecognized status is treated as `processing` (safe — never auto-advances), but
    // surface it loudly so a release can't sit invisibly on a status Play newly introduced.
    if (raw && !(raw in RAW_TO_STATUS)) {
      console.warn(
        `::warning::unrecognized Play track-release status '${raw}' for ${this.packageName} versionCode ${versionCode} — treating as processing`,
      );
    }
    return mapRawPlayStatus(raw);
  }
}
