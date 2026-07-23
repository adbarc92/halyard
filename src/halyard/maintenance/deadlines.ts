import type { AppConfig } from "../config/app-config.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { reconcileProposal } from "../coordinator/proposals.js";
import type { Backend } from "../coordinator/ports.js";
import type { Notifier } from "../publicity/notify.js";
import { daysUntil, urgency, type PlatformDeadlineProvider } from "./types.js";

/**
 * Platform-deadline watcher. Surfaces upcoming SDK-minimum / target-API cutoffs from the
 * deadlines calendar as alerts on the bus. ALERT only — the work is a human's; halyard
 * just makes sure the deadline can't be reached from your phone late.
 */
export interface DeadlineDeps {
  backend: Backend;
  apps: AppConfig[];
  provider: PlatformDeadlineProvider;
  notifier: Notifier;
  now: () => string;
  warnWithinDays?: number;
  log?: (message: string) => void;
}

export interface DeadlineWatchResult {
  created: Proposal[];
  errors: string[];
}

export async function runDeadlineWatch(deps: DeadlineDeps): Promise<DeadlineWatchResult> {
  const log = deps.log ?? (() => {});
  const window = deps.warnWithinDays ?? 60;
  const created: Proposal[] = [];
  const errors: string[] = [];

  for (const app of deps.apps) {
    let deadlines;
    try {
      deadlines = await deps.provider.getDeadlines(app.app.slug);
    } catch (err) {
      const message = `deadline ${app.app.slug}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(message);
      log(`[deadline] ${message}`);
      continue;
    }

    for (const deadline of deadlines) {
      const days = daysUntil(deadline.date, deps.now());
      const holds = days >= 0 && days <= window; // upcoming and not yet passed
      const proposalId = `prop_deadline_${app.app.slug}_${deadline.id}`;

      const result = await reconcileProposal(deps.backend.proposals, proposalId, holds, () => {
        const severity = urgency(days, 14, 30);
        const proposal: Proposal = {
          proposal_id: proposalId,
          kind: "platform_deadline",
          app: app.app.slug,
          severity,
          title: `[${severity}] ${deadline.title} in ${days}d`,
          body: `${deadline.title} — due ${deadline.date} (${days} days). Plan the work; this is an alert.`,
          status: "open",
          created_at: deps.now(),
        };
        return proposal;
      });

      if (result.action === "opened" && result.proposal) {
        await deps.notifier.notify(result.proposal);
        created.push(result.proposal);
        log(`[deadline] ${app.app.slug}/${deadline.id}: in ${days}d (alerted)`);
      } else if (result.action === "resolved") {
        log(`[deadline] ${app.app.slug}/${deadline.id}: passed / out of window → resolved`);
      }
    }
  }

  return { created, errors };
}
