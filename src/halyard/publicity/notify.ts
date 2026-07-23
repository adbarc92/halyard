import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSecret } from "../secrets/resolve.js";
import type { SecretRef } from "../config/secret-ref.js";
import type { Proposal } from "../contracts/proposal.schema.js";

/**
 * The mobile-reachable approval surface (config notifications.approval_channel_ref). A
 * gate is only real if you can reach it from your phone — when a third-party draft (or
 * any proposal) is staged, it is pushed here. Approving remains a human action
 * (`halyard approve`); the notifier only *delivers*.
 */
export interface Notifier {
  notify(proposal: Proposal): Promise<void>;
}

export function notificationText(proposal: Proposal): string {
  const action = proposal.kind === "social_post"
    ? `Review & post to ${proposal.channel}`
    : "Review";
  return `🔔 [${proposal.kind}] ${proposal.title}\n${proposal.body}\n→ ${action}: halyard approve --proposal ${proposal.proposal_id}`;
}

/** Git-backed notifier: writes the delivered notification to disk (local/test surface). */
export class FileNotifier implements Notifier {
  constructor(private readonly stateDir: string, private readonly now: () => string) {}

  async notify(proposal: Proposal): Promise<void> {
    const path = join(this.stateDir, "notifications", `${proposal.proposal_id}.json`);
    if (existsSync(path)) return; // idempotent
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({ proposal_id: proposal.proposal_id, text: notificationText(proposal), sent_at: this.now() }, null, 2) + "\n",
      "utf8",
    );
  }
}

/** Real webhook notifier — POSTs to the approval channel resolved from the secret store. */
export class WebhookNotifier implements Notifier {
  constructor(private readonly webhookRef: SecretRef) {}

  async notify(proposal: Proposal): Promise<void> {
    const url = resolveSecret(this.webhookRef);
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: notificationText(proposal), proposal_id: proposal.proposal_id }),
    });
    if (!res.ok) throw new Error(`approval notification failed: ${res.status}`);
  }
}
