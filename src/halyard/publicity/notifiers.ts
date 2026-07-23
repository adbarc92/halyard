import { resolveSecret } from "../secrets/resolve.js";
import type { SecretRef } from "../config/secret-ref.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { fetchWithTimeout } from "../net.js";
import type { Notifier } from "./notify.js";
import { notificationText } from "./notify.js";

/**
 * Notifier presets for the approval queue (L10).
 *
 * These push a short "staged for approval / needs a human" nudge to the operator's OWN
 * Slack or Discord workspace via an incoming-webhook URL. That is an *owned* notification
 * surface — the operator's own channel — and is emphatically NOT third-party social
 * posting: the message only says "something is staged, come approve it" and links back to
 * `halyard approve`. Approving remains a human action (invariant #5); a notifier only
 * *delivers*, it never publishes to a third-party network.
 *
 * Each webhook URL is a `SECRET:` reference resolved at call time (invariant #4) — the URL
 * is never written to config or logged, mirroring `WebhookNotifier` in `notify.ts`. Every
 * POST routes through `fetchWithTimeout` so a wedged webhook host can't stall a sweep.
 */

async function postWebhook(
  webhookRef: SecretRef,
  label: string,
  payload: Record<string, unknown>,
): Promise<void> {
  const url = resolveSecret(webhookRef);
  const res = await fetchWithTimeout(fetch, url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (!res.ok) throw new Error(`${label} approval notification failed: ${res.status}`);
}

/**
 * Slack incoming-webhook notifier. Slack's incoming webhooks take a `{ text }` body, so the
 * staged-approval message is delivered as `text`.
 */
export class SlackWebhookNotifier implements Notifier {
  constructor(private readonly webhookRef: SecretRef) {}

  async notify(proposal: Proposal): Promise<void> {
    await postWebhook(this.webhookRef, "slack", { text: notificationText(proposal) });
  }
}

/**
 * Discord incoming-webhook notifier. Discord's webhooks take a `{ content }` body (not
 * `text`), so the staged-approval message is delivered as `content`.
 */
export class DiscordWebhookNotifier implements Notifier {
  constructor(private readonly webhookRef: SecretRef) {}

  async notify(proposal: Proposal): Promise<void> {
    await postWebhook(this.webhookRef, "discord", { content: notificationText(proposal) });
  }
}
