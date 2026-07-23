import { z } from "zod";
import { AnnouncePolicySchema } from "./org-config.schema.js";
import { CronSchema, SlugSchema, type Surface } from "./primitives.js";
import { SecretRefSchema } from "./secret-ref.js";
import { validateDeployConfig } from "../surfaces/deploy/registry.js";

/**
 * A `deploy` block is validated against the deploy-provider registry rather than a closed
 * per-surface union: the block must carry a `target` discriminator, the target must be
 * registered and valid for this surface, and its provider-specific fields must parse against
 * that provider's schema. Adding a deploy target = adding a provider module (its own lane),
 * never editing this schema.
 */
const DeployTargetSchema = z.object({ target: z.string().min(1) }).passthrough();
function deploySchemaFor(surface: Surface) {
  return DeployTargetSchema.superRefine((cfg, ctx) => {
    try {
      validateDeployConfig(surface, cfg);
    } catch (err) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  });
}

/**
 * Per-app config — `apps/<slug>/app.yml` (§4). One file per app. Everything that
 * differs between apps lives here (bundle ids, signing identities, flag keys,
 * channel list, version scheme) so the spine stays surface-agnostic.
 */

const VersionSchemeSchema = z
  .object({
    semver: z.boolean(),
    tag_pattern: z.string().min(1), // e.g. "{surface}-v{version}"
  })
  .strict();

const FlagsSchema = z
  .object({
    provider: z.string().min(1),
    // Base URL of the provider's REST API. The generic HttpFlagClient speaks
    // `{api_url}/flags/{key}`; omit to fall back to the git-backed file client. Non-secret
    // (URLs aren't credentials) — the token comes from `api_key_ref`, resolved at runtime.
    api_url: z.string().url().optional(),
    api_key_ref: SecretRefSchema,
    naming: z
      .string()
      .min(1)
      .refine((n) => !n.startsWith("halyard."), {
        message: "flags.naming must not use the reserved 'halyard.' namespace (used by web auto-promote)",
      }), // e.g. "launch.{slug}.{feature}" — launch flags born OFF
    graduate_after_days: z.number().int().positive(),
  })
  .strict();

const ChangelogSchema = z
  .object({
    source: z.enum(["conventional_commits"]),
    since: z.enum(["last_tag"]),
  })
  .strict();

// Payment processing is one of the third-party integrations Halyard helps configure on the
// way to production. The provider sits behind a port; config holds only a secret reference
// (the key resolves at runtime). Optional — apps without billing simply omit it.
const PaymentsSchema = z
  .object({
    provider: z.string().min(1), // e.g. "stripe"; the concrete adapter is wired at runtime
    api_key_ref: SecretRefSchema, // resolved from the secret store, never stored in config
  })
  .strict();

// --- Surface adapters: a common shape, surface-specific signing/deploy details ---

const IosSurfaceSchema = z
  .object({
    enabled: z.boolean(),
    // Build/test/submit toolchain: `match` = fastlane (default, pre-existing), `eas` = Expo
    // Application Services. The fastlane identity fields below are required for `match`;
    // an EAS app supplies EXPO_TOKEN + the ASC key as SECRET refs instead (Lane L7).
    toolchain: z.enum(["match", "eas"]).default("match"),
    bundle_id: z.string().min(1),
    asc_app_id: z.string().min(1),
    team_id: z.string().min(1),
    signing: z
      .object({
        method: z.enum(["match"]),
        match_repo_ref: SecretRefSchema,
        asc_api_key_ref: SecretRefSchema,
      })
      .strict(),
    testflight_group: z.string().min(1),
    // The per-surface review cadence. The sweep still runs on the org-level
    // coordinator.reconcile_cron (mirrored in reconcile.yml), but the ASC review poll only
    // joins a given sweep when this cron is due since the previous sweep (see
    // coordinator/schedule.ts). A surface without this field is polled every sweep.
    review_poll_cron: CronSchema,
  })
  .strict();

const AndroidSurfaceSchema = z
  .object({
    enabled: z.boolean(),
    // Build/test/submit toolchain: `match` = fastlane/gradle (default), `eas` = Expo
    // Application Services. `service_account_ref` (the Play JSON) applies to both.
    toolchain: z.enum(["match", "eas"]).default("match"),
    package: z.string().min(1),
    track: z.enum(["internal", "alpha", "beta", "production"]),
    service_account_ref: SecretRefSchema,
  })
  .strict();

// Deploy target is validated against the deploy-provider registry (see DeployTargetSchema).
// Web providers include `cloudflare_pages` (wrangler), `local_dir` (local verify), and the
// provider lanes (vercel, fly, github_pages, aws, generic command); creds come from env at
// runtime, never config.
const WebDeploySchema = deploySchemaFor("web");

const WebSurfaceSchema = z
  .object({
    enabled: z.boolean(),
    build: z
      .object({
        command: z.string().min(1),
        output_dir: z.string().min(1),
      })
      .strict(),
    test: z
      .object({
        command: z.string().min(1), // deterministic gate keys off this command's exit code
      })
      .strict(),
    deploy: WebDeploySchema,
    prod_url: z.string().url(),
    // When true, web's promote-to-prod gate IS the manual flag flip: the build rests at
    // `uploaded` and goes `live` only when the flag is flipped ON (see flag-poll). When false,
    // a STANDALONE web release auto-promotes — its flag is born ON on deploy (coordinator/
    // auto-promote.ts) so flag-poll projects it `live`; rollback is the usual flip-off.
    promote_gate: z.boolean(),
  })
  .strict();

// Desktop deploy target is validated against the deploy-provider registry (see
// DeployTargetSchema). Desktop providers include `github_releases` (the `gh` CLI),
// `local_dir` (local verify), and the itch.io provider lane; creds come from env at
// runtime, never config.
const DesktopDeploySchema = deploySchemaFor("desktop");

// Optional pre-deploy signing (§ desktop signing). Defaults `enabled:false` — no signing
// runs unless an app opts in. macOS notarization runs now; Windows Authenticode is built
// but ships disabled (2026-07-08 portfolio decision). All creds are SECRET refs resolved at
// runtime; a raw credential in config is rejected by SecretRefSchema.
const DesktopSigningSchema = z
  .object({
    enabled: z.boolean().default(false),
    platform: z.enum(["macos", "windows"]),
    // Non-secret notarytool keychain-profile name (created once on the runner via
    // `xcrun notarytool store-credentials`); only its name crosses config. Optional —
    // the macOS signer defaults to "halyard-notary".
    notary_profile: z.string().min(1).optional(),
    // macOS Developer ID notarize+staple (Gate #2).
    apple_id_ref: SecretRefSchema.optional(),
    apple_team_id_ref: SecretRefSchema.optional(),
    apple_password_ref: SecretRefSchema.optional(),
    // Windows Authenticode (deferred).
    windows_certificate_ref: SecretRefSchema.optional(),
    windows_certificate_password_ref: SecretRefSchema.optional(),
  })
  .strict();

// Desktop is a Tauri pipeline: a `tauri build` produces an artifact bundle which rests at
// `uploaded` until the flag flip projects it to `live`. No web-style prod_url/promote_gate
// (those are web-promote concepts); distribution is GitHub Releases, not a CDN deploy.
const DesktopSurfaceSchema = z
  .object({
    enabled: z.boolean(),
    build: z
      .object({
        command: z.string().min(1), // e.g. "npm run tauri build"
        output_dir: z.string().min(1), // the Tauri bundle output directory
      })
      .strict(),
    test: z
      .object({
        command: z.string().min(1), // deterministic gate keys off this command's exit code
      })
      .strict(),
    deploy: DesktopDeploySchema,
    signing: DesktopSigningSchema.optional(),
  })
  .strict();

const SurfacesSchema = z
  .object({
    ios: IosSurfaceSchema.optional(),
    android: AndroidSurfaceSchema.optional(),
    web: WebSurfaceSchema.optional(),
    desktop: DesktopSurfaceSchema.optional(),
  })
  .strict()
  .refine((s) => Object.values(s).some((surface) => surface?.enabled), {
    message: "at least one surface must be enabled",
  });

const TriageSchema = z
  .object({
    sentry: z
      .object({
        project_ref: SecretRefSchema,
        org: z.string().min(1),
      })
      .strict(),
    severity_thresholds: z
      .object({
        crash_free_users_pct: z.number().min(0).max(100),
      })
      .strict(),
    classify: z.enum(["agent"]),
  })
  .strict();

const ChannelsSchema = z
  .object({
    enabled: z.array(z.string().min(1)).min(1),
    overrides: z.record(z.string(), z.unknown()).default({}),
  })
  .strict();

const CertWatchItemSchema = z
  .object({
    kind: z.enum(["apple_distribution", "apple_push_key", "authenticode"]),
  })
  .strict();

const MaintenanceSchema = z
  .object({
    cert_watch: z.array(CertWatchItemSchema),
    platform_deadlines: z
      .object({
        calendar_ref: SecretRefSchema,
      })
      .strict(),
    dependencies: z
      .object({
        tool: z.string().min(1),
        // Auto-merge is the one automated outward action — bound to the safe set only.
        // `major` is never auto-mergeable; a major bump is always proposed for review.
        automerge: z.array(z.enum(["patch", "minor"])),
        // "owner/name" of the repo whose Renovate PRs are auto-merged. Required for
        // auto-merge to act; without it eligible updates are proposed, not merged.
        repo: z.string().min(1).optional(),
      })
      .strict(),
  })
  .strict();

export const AppConfigSchema = z
  .object({
    version: z.literal(1),
    app: z
      .object({
        name: z.string().min(1),
        slug: SlugSchema,
      })
      .strict(),
    version_scheme: VersionSchemeSchema,
    flags: FlagsSchema,
    changelog: ChangelogSchema,
    payments: PaymentsSchema.optional(),
    surfaces: SurfacesSchema,
    triage: TriageSchema,
    channels: ChannelsSchema,
    launch_defaults: z
      .object({
        announce_policy: AnnouncePolicySchema,
      })
      .strict(),
    maintenance: MaintenanceSchema,
  })
  .strict();

export type AppConfig = z.infer<typeof AppConfigSchema>;
