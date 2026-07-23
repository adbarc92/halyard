import type { AppConfig } from "../config/app-config.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { reconcileProposal } from "../coordinator/proposals.js";
import type { Backend } from "../coordinator/ports.js";
import type { Notifier } from "../publicity/notify.js";
import type { DependencyUpdate, DependencyUpdateProvider, MergeClient, UpdateType } from "./types.js";

/**
 * Renovate dependency updates onto the bus. The `automerge` list in config is the
 * deterministic gate (not a model): an update whose type is in the list is auto-merged —
 * the one genuinely-automated maintenance action, authorized by config. Everything else
 * (typically `major`) proposes for human review. No model decides what merges.
 */
export interface RenovateDeps {
  backend: Backend;
  apps: AppConfig[];
  provider: DependencyUpdateProvider;
  mergeClient: MergeClient;
  notifier: Notifier;
  now: () => string;
  log?: (message: string) => void;
}

export interface RenovateResult {
  merged: DependencyUpdate[];
  proposed: Proposal[];
  errors: string[];
}

export async function runRenovate(deps: RenovateDeps): Promise<RenovateResult> {
  const log = deps.log ?? (() => {});
  const merged: DependencyUpdate[] = [];
  const proposed: Proposal[] = [];
  const errors: string[] = [];

  for (const app of deps.apps) {
    const automerge = new Set<UpdateType>(app.maintenance.dependencies.automerge);

    let updates: DependencyUpdate[];
    try {
      updates = await deps.provider.listUpdates(app.app.slug);
    } catch (err) {
      const message = `deps ${app.app.slug}: ${err instanceof Error ? err.message : String(err)}`;
      errors.push(message);
      log(`[deps] ${message}`);
      continue;
    }

    const currentProposalIds = new Set<string>();

    const repo = app.maintenance.dependencies.repo;

    for (const update of updates) {
      // Every update still reported by the provider this run is "live upstream" — record
      // its proposal id up front (both branches), so the stale-resolver below only closes
      // proposals whose underlying PR has actually disappeared (merged/closed), never one
      // we acted on this very run.
      const proposalId = `prop_dep_${app.app.slug}_${update.id}`;
      currentProposalIds.add(proposalId);

      // Auto-merge only when the type is in the config-authorized set AND a target repo
      // is configured. Without a repo we can't safely act, so fall through to a proposal.
      if (automerge.has(update.updateType) && repo) {
        try {
          await deps.mergeClient.merge(repo, update.pr);
          merged.push(update);
          log(`[deps] ${app.app.slug}: auto-merged ${update.name} ${update.from}→${update.to} (${update.updateType}) into ${repo}`);
        } catch (err) {
          const message = `deps ${app.app.slug}: merge of ${repo}#${update.pr} failed — ${err instanceof Error ? err.message : String(err)}`;
          errors.push(message);
          log(`[deps] ${message}`);
        }
        continue;
      }

      // Not auto-mergeable → propose for human review.
      const result = await reconcileProposal(deps.backend.proposals, proposalId, true, () => {
        const proposal: Proposal = {
          proposal_id: proposalId,
          kind: "dependency_update",
          app: app.app.slug,
          severity: update.updateType === "major" ? "high" : "medium",
          title: `Review ${update.updateType} update: ${update.name} ${update.from}→${update.to}`,
          body: `Renovate PR #${update.pr} is a ${update.updateType} bump (not in automerge). Review and merge yourself.`,
          status: "open",
          created_at: deps.now(),
        };
        return proposal;
      });
      if (result.action === "opened" && result.proposal) {
        await deps.notifier.notify(result.proposal);
        proposed.push(result.proposal);
        log(`[deps] ${app.app.slug}: ${update.name} ${update.updateType} → proposed for review`);
      }
    }

    // A dependency proposal whose PR is no longer in the current list (merged/closed
    // upstream) is resolved — the queue tracks live work, not history.
    for (const p of await deps.backend.proposals.list()) {
      if (
        p.kind === "dependency_update" &&
        p.app === app.app.slug &&
        p.status === "open" &&
        !currentProposalIds.has(p.proposal_id)
      ) {
        await deps.backend.proposals.write({ ...p, status: "resolved" });
        log(`[deps] ${app.app.slug}: ${p.proposal_id} no longer pending → resolved`);
      }
    }
  }

  return { merged, proposed, errors };
}
