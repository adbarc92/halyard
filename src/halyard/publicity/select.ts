import type { OrgConfig } from "../config/org-config.schema.js";
import { tryResolveSecret } from "../secrets/resolve.js";
import { getEntitlement } from "../licensing/index.js";
import { AnthropicDrafter } from "./anthropic-drafter.js";
import { TemplateDrafter } from "./template-drafter.js";
import type { Drafter } from "./drafter.js";
import { FilePublisher, HttpPublisher } from "./publishers.js";
import type { Publisher } from "./publishers.js";
import { FileNotifier, WebhookNotifier } from "./notify.js";
import type { Notifier } from "./notify.js";

/**
 * Select the publicity publisher from org config — single source of truth shared by the
 * CLI reconcile and future web consumers (do not fork this):
 *
 *   - `HttpPublisher` when `HALYARD_LIVE_PUBLISH` is set (back-compat env override), OR
 *     when at least one enabled channel declares `publish.type === "http"` with a resolvable
 *     `endpoint_ref` token;
 *   - `FilePublisher` otherwise (offline / credential-free default).
 *
 * A channel with an un-resolvable endpoint token simply falls through — callers stay
 * online-optional and never crash on an absent credential (invariant #4: token resolved at
 * runtime, never logged).
 *
 * Invariant #5: the `HttpPublisher` is used only for owned auto-publish channels; the schema
 * already enforces that `class: third_party` cannot pair with `gate: auto`, so a third-party
 * channel with a manual publish target never reaches this path.
 */
export function makePublisher(
  org: OrgConfig,
  stateDir: string,
  now: () => string,
): Publisher {
  // Back-compat env override: HALYARD_LIVE_PUBLISH forces the live publisher regardless of
  // what channels are configured (matches the legacy behaviour in cli.ts).
  if (process.env.HALYARD_LIVE_PUBLISH) return new HttpPublisher();

  // Config-driven path: return HttpPublisher iff some channel has a resolvable http endpoint.
  for (const channel of Object.values(org.channels)) {
    if (channel.publish.type === "http" && tryResolveSecret(channel.publish.endpoint_ref)) {
      return new HttpPublisher();
    }
  }

  return new FilePublisher(stateDir, now);
}

/**
 * Select the notifier from org config — single source of truth for the approval-surface
 * choice:
 *
 *   - `WebhookNotifier` when the `notifications.approval_channel_ref` token resolves;
 *   - `FileNotifier` otherwise (offline / credential-free default).
 */
export function makeNotifier(
  org: OrgConfig,
  stateDir: string,
  now: () => string,
): Notifier {
  const approvalRef = org.notifications.approval_channel_ref;
  return tryResolveSecret(approvalRef)
    ? new WebhookNotifier(approvalRef)
    : new FileNotifier(stateDir, now);
}

/**
 * Select the publicity drafter from org config — single source of truth for the drafter
 * choice:
 *
 *   - `AnthropicDrafter` when the `drafting.api_key_ref` token resolves AND the `ai-agents`
 *     Pro feature is entitled;
 *   - `TemplateDrafter` otherwise (deterministic, no-API default).
 *
 * Mirrors `chooseDrafter` in cli.ts exactly (same diagnostics for the non-Pro path).
 */
export function makeDrafter(org: OrgConfig): Drafter {
  const apiKey = tryResolveSecret(org.drafting.api_key_ref);
  if (apiKey && getEntitlement().has("ai-agents")) return new AnthropicDrafter(org.drafting.model, apiKey);
  if (apiKey) console.error("[publicity] AI drafting is a Halyard Pro feature; using the deterministic template");
  else console.error("[publicity] ANTHROPIC_API_KEY not set; drafting with the deterministic template");
  return new TemplateDrafter();
}
