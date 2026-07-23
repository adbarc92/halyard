import type { Proposal } from "../../contracts/proposal.schema.js";
import { proposeOnce } from "../../coordinator/proposals.js";
import type { Backend } from "../../coordinator/ports.js";
import type { Notifier } from "../../publicity/notify.js";
import type { RejectionDrafter } from "./rejection-drafter.js";

/**
 * For each release in `rejected`, draft a reviewer response and stage it as a proposal.
 * The drafter is an agent; the runner only enqueues + notifies. Submitting the response
 * stays a human action.
 */
export interface RejectionDeps {
  backend: Backend;
  drafter: RejectionDrafter;
  notifier: Notifier;
  now: () => string;
  log?: (message: string) => void;
}

export async function runRejectionResponses(deps: RejectionDeps): Promise<Proposal[]> {
  const log = deps.log ?? (() => {});
  const created: Proposal[] = [];

  for (const releaseId of await deps.backend.records.scanIds()) {
    const release = await deps.backend.records.read(releaseId);
    if (!release || release.state !== "rejected") continue;

    try {
      // Qualify the id by rejection attempt so a *second* store rejection (after a
      // resubmit: rejected → in_review → rejected#2) gets its own drafted response and
      // notification rather than colliding with the stale first one.
      const attempt = release.transitions.filter((t) => t.to === "rejected").length;
      const draft = await deps.drafter.draft(release);
      const proposal: Proposal = {
        proposal_id: `prop_rejresp_${release.release_id}_${attempt}`,
        kind: "rejection_response",
        app: release.app,
        release_id: release.release_id,
        launch_id: release.launch_id,
        title: draft.title,
        body: `${draft.body}\n\n[Draft response — review and submit yourself.]`,
        status: "open",
        created_at: deps.now(),
      };
      const { created: isNew, proposal: stored } = await proposeOnce(deps.backend.proposals, proposal);
      if (isNew) {
        await deps.notifier.notify(stored);
        created.push(stored);
        log(`[rejection] ${release.release_id}: drafted response (proposed)`);
      }
    } catch (err) {
      log(`[rejection] ${release.release_id}: skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return created;
}
