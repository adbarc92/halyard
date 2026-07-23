import { SURFACES, type Surface } from "../config/primitives.js";

/**
 * The app.yml template emitter (R-ONBOARD). Pure: given an app name/slug and the chosen
 * surfaces it builds the plain-object form of `apps/<slug>/app.yml`, mirroring
 * `apps/aurora/app.yml` but emitting **only** the selected surfaces. Every credential is a
 * `SECRET:NAME` reference (invariant #4) and every operator-supplied identifier is a
 * `REPLACE_ME` marker — never a real value. The result is fed straight through
 * `validateAppConfig`, so the schema is the contract this must satisfy.
 */

/** The placeholder an operator must replace with a real (non-secret) identifier. */
export const REPLACE_ME = "REPLACE_ME" as const;

export interface OnboardInput {
  name: string;
  slug: string;
  /** At least one; deduped + ordered canonically by the caller. */
  surfaces: Surface[];
}

/** Per-app secret name (UPPER_SNAKE) derived from the slug, e.g. aurora → AURORA. */
function slugUpper(slug: string): string {
  return slug.toUpperCase();
}

/** A `SECRET:NAME` reference for a per-app secret keyed off the slug. */
function appSecret(slug: string, suffix: string): string {
  return `SECRET:${slugUpper(slug)}_${suffix}`;
}

/** Canonical surface order (matches the schema's surface key order) with no duplicates. */
export function normalizeSurfaces(input: readonly string[]): Surface[] {
  const chosen = new Set(input.map((s) => s.trim().toLowerCase()));
  const ordered = SURFACES.filter((s) => chosen.has(s));
  const unknown = [...chosen].filter((s) => !SURFACES.includes(s as Surface));
  if (unknown.length > 0) {
    throw new Error(`unknown surface(s): ${unknown.join(", ")} — choose from ${SURFACES.join(", ")}`);
  }
  if (ordered.length === 0) {
    throw new Error(`at least one surface must be chosen (${SURFACES.join(", ")})`);
  }
  return ordered;
}

/** The iOS surface block — identifiers as REPLACE_ME, signing as shared SECRET refs. */
function iosSurface() {
  return {
    enabled: true,
    bundle_id: REPLACE_ME, // e.g. com.yourco.<slug>
    asc_app_id: REPLACE_ME, // App Store Connect numeric app id
    team_id: REPLACE_ME, // Apple Developer team id
    signing: {
      method: "match",
      match_repo_ref: "SECRET:MATCH_REPO",
      asc_api_key_ref: "SECRET:ASC_API_KEY",
    },
    testflight_group: "external",
    review_poll_cron: "*/30 * * * *",
  };
}

/** The Android surface block — package as REPLACE_ME, service account as a SECRET ref. */
function androidSurface() {
  return {
    enabled: true,
    package: REPLACE_ME, // e.g. com.yourco.<slug>
    track: "internal",
    service_account_ref: "SECRET:PLAY_SERVICE_ACCOUNT",
  };
}

/** The web surface block — prod_url + Cloudflare project as REPLACE_ME markers. */
function webSurface(slug: string) {
  return {
    enabled: true,
    build: { command: "npm ci && npm run build", output_dir: "dist" },
    test: { command: "npm test" },
    deploy: { target: "cloudflare_pages", project: `${slug}-web` },
    prod_url: "https://REPLACE_ME.example.com",
    promote_gate: true,
  };
}

/** The desktop surface block — GitHub Releases repo as a REPLACE_ME marker. */
function desktopSurface() {
  return {
    enabled: true,
    build: { command: "npm run tauri build", output_dir: "src-tauri/target/release/bundle" },
    test: { command: "npm test" },
    deploy: { target: "github_releases", repo: "REPLACE_ME/REPLACE_ME", tag_pattern: "desktop-v{version}" },
  };
}

/**
 * Build the plain-object form of `apps/<slug>/app.yml` for the chosen surfaces. Mirrors
 * `apps/aurora/app.yml` exactly where the schema is fixed (version scheme, changelog, triage,
 * channels, maintenance) and emits ONLY the selected surface blocks. No `payments` block —
 * onboarding stays minimal; an operator adds it later if they bill.
 */
export function buildAppConfig(input: OnboardInput): Record<string, unknown> {
  const { name, slug } = input;
  const surfaces = normalizeSurfaces(input.surfaces);

  const surfaceBlocks: Record<string, unknown> = {};
  if (surfaces.includes("ios")) surfaceBlocks.ios = iosSurface();
  if (surfaces.includes("android")) surfaceBlocks.android = androidSurface();
  if (surfaces.includes("web")) surfaceBlocks.web = webSurface(slug);
  if (surfaces.includes("desktop")) surfaceBlocks.desktop = desktopSurface();

  return {
    version: 1,
    app: { name, slug },
    version_scheme: { semver: true, tag_pattern: "{surface}-v{version}" },
    flags: {
      provider: "http",
      // api_url is omitted on purpose — until the operator points it at a real provider the
      // git-backed file client is used (and preflight reports flags not-yet-configured).
      api_key_ref: appSecret(slug, "FLAG_PROVIDER_KEY"),
      naming: `launch.${slug}.{feature}`,
      graduate_after_days: 30,
    },
    changelog: { source: "conventional_commits", since: "last_tag" },
    surfaces: surfaceBlocks,
    triage: {
      sentry: { project_ref: appSecret(slug, "SENTRY_DSN"), org: REPLACE_ME },
      severity_thresholds: { crash_free_users_pct: 99.5 },
      classify: "agent",
    },
    channels: { enabled: ["blog", "waitlist_email"], overrides: {} },
    launch_defaults: { announce_policy: "per_surface" },
    maintenance: {
      cert_watch: surfaces.includes("ios")
        ? [{ kind: "apple_distribution" }, { kind: "apple_push_key" }]
        : [],
      platform_deadlines: { calendar_ref: "SECRET:DEADLINES_CAL" },
      dependencies: { tool: "renovate", automerge: ["patch", "minor"] },
    },
  };
}

/**
 * The exact env vars / secrets an operator must set for the chosen surfaces, derived from the
 * `LAUNCH-READINESS.md` secrets-by-integration table. Always-required ones (approval surface,
 * flags, monitoring) come first; per-surface store secrets follow. These are NAMES to set in
 * the secret store — never values.
 */
export function secretsForSurfaces(slug: string, surfaces: readonly Surface[]): string[] {
  const out: string[] = [
    "HALYARD_APPROVAL_WEBHOOK", // approval surface — a gate you can't reach from your phone isn't a gate
    `${slugUpper(slug)}_FLAG_PROVIDER_KEY`, // flag provider token (+ set flags.api_url)
    "SENTRY_AUTH_TOKEN", // crash triage
    `${slugUpper(slug)}_SENTRY_DSN`, // this app's Sentry project ref
  ];
  if (surfaces.includes("ios")) {
    out.push("MATCH_REPO", "MATCH_PASSWORD", "MATCH_GIT_BASIC_AUTHORIZATION", "ASC_KEY_ID", "ASC_ISSUER_ID", "ASC_PRIVATE_KEY");
  }
  if (surfaces.includes("android")) {
    out.push("PLAY_SERVICE_ACCOUNT");
  }
  if (surfaces.includes("web")) {
    out.push("CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID");
  }
  // desktop publishes via the `gh` CLI's GITHUB_TOKEN (provided by CI), so no extra app secret.
  return out;
}
