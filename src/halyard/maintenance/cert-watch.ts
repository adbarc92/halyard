import type { AppConfig } from "../config/app-config.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { reconcileProposal } from "../coordinator/proposals.js";
import type { Backend } from "../coordinator/ports.js";
import type { Notifier } from "../publicity/notify.js";
import { daysUntil, urgency, type CertExpiryProvider } from "./types.js";

/**
 * Cert-expiry watcher. ALERTING ONLY — halyard never renews a certificate; the renewal
 * auth stays a human action (design §4). It surfaces a proposal when a watched cert is
 * within the warning window. One open alert per (app, cert kind).
 */
export interface CertWatchDeps {
  backend: Backend;
  apps: AppConfig[];
  provider: CertExpiryProvider;
  notifier: Notifier;
  now: () => string;
  warnWithinDays?: number;
  log?: (message: string) => void;
}

export interface CertWatchResult {
  created: Proposal[];
  /** Provider failures, isolated per cert — surfaced so the scheduled run can fail loud. */
  errors: string[];
}

export async function runCertWatch(deps: CertWatchDeps): Promise<CertWatchResult> {
  const log = deps.log ?? (() => {});
  const window = deps.warnWithinDays ?? 30;
  const created: Proposal[] = [];
  const errors: string[] = [];

  for (const app of deps.apps) {
    for (const cert of app.maintenance.cert_watch) {
      try {
        const status = await deps.provider.getCertStatus(app.app.slug, cert.kind);
        const days = daysUntil(status.notAfter, deps.now());
        const holds = days <= window;
        const proposalId = `prop_cert_${app.app.slug}_${cert.kind}`;

        const result = await reconcileProposal(deps.backend.proposals, proposalId, holds, () => {
          const severity = urgency(days, 7, 14);
          const proposal: Proposal = {
            proposal_id: proposalId,
            kind: "cert_expiry",
            app: app.app.slug,
            severity,
            title: `[${severity}] ${cert.kind} cert expires in ${days}d`,
            body:
              `${cert.kind} for ${app.app.slug} expires on ${status.notAfter} (${days} days). ` +
              `Renew it manually — halyard alerts but never renews a certificate. ` +
              `This is an alert, not an action.`,
            status: "open",
            created_at: deps.now(),
          };
          return proposal;
        });

        if (result.action === "opened" && result.proposal) {
          await deps.notifier.notify(result.proposal);
          created.push(result.proposal);
          log(`[cert] ${app.app.slug}/${cert.kind}: expires in ${days}d (alerted)`);
        } else if (result.action === "resolved") {
          log(`[cert] ${app.app.slug}/${cert.kind}: renewed / out of window → resolved`);
        }
      } catch (err) {
        const message = `cert ${app.app.slug}/${cert.kind}: ${err instanceof Error ? err.message : String(err)}`;
        errors.push(message);
        log(`[cert] ${message}`);
      }
    }
  }

  return { created, errors };
}
