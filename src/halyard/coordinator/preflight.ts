import type { AppConfig } from "../config/app-config.schema.js";
import type { OrgConfig } from "../config/org-config.schema.js";
import type { Surface } from "../config/primitives.js";
import { secretName } from "../config/secret-ref.js";
import { validateDeployConfig } from "../surfaces/deploy/registry.js";

/**
 * Production-readiness assessment: for an app, is every third-party integration it needs
 * actually configured? This is the "one-stop production finish-line" check — it unifies the
 * per-provider verifications (flags, monitoring, payments, stores, web deploy, approval
 * surface) into one report.
 *
 * The core here is PURE: given a `get(name)` secret lookup it decides, per integration,
 * whether it is *required* (from the enabled surfaces / declared blocks) and *configured*
 * (its referenced secrets resolve). Live reachability probes (does the key actually
 * authenticate?) are layered on top by the CLI for the integrations that are cheap and safe
 * to probe; this keeps the decision logic fully testable offline.
 */
export interface ReadinessItem {
  integration: string;
  required: boolean;
  configured: boolean;
  /** Set only when a live reachability probe ran (CLI layer); undefined = not probed. */
  reachable?: boolean;
  detail: string;
}

export interface ReadinessReport {
  app: string;
  items: ReadinessItem[];
  /** True when every required integration is configured (and, if probed, reachable). */
  ready: boolean;
}

/** A required integration must be configured and — if a probe ran — reachable. */
export function isReady(items: ReadinessItem[]): boolean {
  return items.every((i) => !i.required || (i.configured && i.reachable !== false));
}

export function assessReadiness(
  app: AppConfig,
  org: OrgConfig,
  get: (name: string) => string | undefined,
): ReadinessReport {
  const has = (name: string) => {
    const v = get(name);
    return v !== undefined && v !== "";
  };
  const items: ReadinessItem[] = [];

  // Approval surface — required: a gate you can't reach from your phone isn't a gate.
  const approvalName = secretName(org.notifications.approval_channel_ref);
  items.push({
    integration: "approval-surface",
    required: true,
    configured: has(approvalName),
    detail: approvalName,
  });

  // Coordinator service backend — required when selected: every state command needs this token.
  if (org.coordinator.backend === "service" && org.coordinator.service) {
    const keyName = secretName(org.coordinator.service.api_key_ref);
    items.push({ integration: "coordinator-service", required: true, configured: has(keyName), detail: keyName });
  }

  // Flag provider — required: the flag flip is the launch moment.
  {
    const keyName = secretName(app.flags.api_key_ref);
    const urlOk = !!app.flags.api_url;
    const keyOk = has(keyName);
    items.push({
      integration: "flags",
      required: true,
      configured: urlOk && keyOk,
      detail: !urlOk ? "flags.api_url not set" : keyOk ? keyName : `${keyName} unresolved`,
    });
  }

  // Monitoring (Sentry or equivalent) — required: triage is configured.
  {
    const projName = secretName(app.triage.sentry.project_ref);
    items.push({
      integration: "monitoring",
      required: true,
      configured: has("SENTRY_AUTH_TOKEN") && has(projName),
      detail: `SENTRY_AUTH_TOKEN + ${projName}`,
    });
  }

  // Drafting (Anthropic) — optional: degrades to deterministic templates.
  {
    const keyName = secretName(org.drafting.api_key_ref);
    items.push({
      integration: "drafting",
      required: false,
      configured: has(keyName),
      detail: `${keyName} (optional; falls back to templates)`,
    });
  }

  // Payments — required only when an app declares a payments block.
  if (app.payments) {
    const keyName = secretName(app.payments.api_key_ref);
    items.push({ integration: "payments", required: true, configured: has(keyName), detail: keyName });
  }

  // iOS store — required when iOS is enabled. Check what is actually consumed: the ASC API
  // key trio (read by both the review poll and fastlane) + the match signing repo. The
  // app.yml `asc_api_key_ref` is a decorative ref that nothing reads, so don't require it.
  if (app.surfaces.ios?.enabled) {
    const ios = app.surfaces.ios;
    const ascEnv = has("ASC_KEY_ID") && has("ASC_ISSUER_ID") && has("ASC_PRIVATE_KEY");
    const matchName = secretName(ios.signing.match_repo_ref);
    const signing = has(matchName);
    items.push({
      integration: "ios-store",
      required: true,
      configured: ascEnv && signing,
      detail: !ascEnv ? "ASC_KEY_ID / ASC_ISSUER_ID / ASC_PRIVATE_KEY" : signing ? "ok" : matchName,
    });
  }

  // Android store — required when Android is enabled.
  if (app.surfaces.android?.enabled) {
    const name = secretName(app.surfaces.android.service_account_ref);
    items.push({ integration: "android-store", required: true, configured: has(name), detail: name });
  }

  // Web deploy (Cloudflare) — required when web with the cloudflare target is enabled.
  if (app.surfaces.web?.enabled && app.surfaces.web.deploy.target === "cloudflare_pages") {
    items.push({
      integration: "web-deploy",
      required: true,
      configured: has("CLOUDFLARE_API_TOKEN") && has("CLOUDFLARE_ACCOUNT_ID"),
      detail: "CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID",
    });
  }

  // Deploy providers — the launch gate for the provider registry. For every ENABLED surface
  // that carries a `deploy` block (web, desktop), require that its target is registered AND
  // valid for that surface: `validateDeployConfig` (config-only, offline) parses the block
  // against the provider's schema, so an unknown, cross-surface, or mis-typed target shows up
  // as NOT configured with the registry's own message. Any SECRET refs in the block are
  // resolved by that parse via SecretRefSchema; live cred probes are layered on by the CLI.
  // This is additive to the specific web-deploy secret check above.
  for (const surface of ["web", "desktop"] as const satisfies readonly Surface[]) {
    const s = app.surfaces[surface];
    if (!s?.enabled) continue;
    let configured = true;
    let detail: string;
    try {
      validateDeployConfig(surface, s.deploy);
      detail = `target "${(s.deploy as { target: string }).target}" registered + valid for ${surface}`;
    } catch (err) {
      configured = false;
      detail = err instanceof Error ? err.message : String(err);
    }
    items.push({ integration: `deploy:${surface}`, required: true, configured, detail });
  }

  return { app: app.app.slug, items, ready: isReady(items) };
}
