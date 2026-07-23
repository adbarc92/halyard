import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ProposalSchema, type Proposal } from "../contracts/proposal.schema.js";
import type { ProposalStore } from "./ports.js";

/**
 * The approval queue, git-backed as JSON under `state/proposals/`. Proposals are
 * suggestions for a human (invariants #2/#5); the system never acts on them itself.
 * `proposeOnce` is idempotent on the stable `proposal_id`, so a repeated reconcile pass
 * never enqueues the same suggestion twice.
 */

export function proposalPath(stateDir: string, proposalId: string): string {
  return join(stateDir, "proposals", `${proposalId}.json`);
}

export function readProposal(stateDir: string, proposalId: string): Proposal | null {
  const p = proposalPath(stateDir, proposalId);
  if (!existsSync(p)) return null;
  return ProposalSchema.parse(JSON.parse(readFileSync(p, "utf8")));
}

export function writeProposal(stateDir: string, proposal: Proposal): void {
  const validated = ProposalSchema.parse(proposal);
  const p = proposalPath(stateDir, proposal.proposal_id);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, JSON.stringify(validated, null, 2) + "\n", "utf8");
}

export function listProposals(stateDir: string): Proposal[] {
  const dir = join(stateDir, "proposals");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ProposalSchema.parse(JSON.parse(readFileSync(join(dir, f), "utf8"))))
    .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id));
}

/**
 * Enqueue a proposal only if one with the same id is not already present. Orchestration over a
 * `ProposalStore` (read-then-maybe-write) — the create-once guarantee lives here once, so every
 * adapter stays a dumb read/write.
 */
export async function proposeOnce(
  store: ProposalStore,
  proposal: Proposal,
): Promise<{ created: boolean; proposal: Proposal }> {
  const existing = await store.read(proposal.proposal_id);
  if (existing) return { created: false, proposal: existing };
  await store.write(proposal);
  return { created: true, proposal };
}

export type ReconcileProposalAction = "opened" | "resolved" | "noop";

/**
 * Reconcile a single system-raised proposal against current truth, giving it a real
 * lifecycle:
 *   - condition holds, and the proposal is absent or previously `resolved` → (re)open it.
 *   - condition holds, and it is `open`/`approved`/`dismissed` → leave it (a human owns it).
 *   - condition cleared, and it is `open` → auto-`resolved`.
 *   - otherwise → no-op.
 * A human `dismissed` is never auto-reopened (no alert fatigue). Callers notify only on
 * `"opened"`.
 */
export async function reconcileProposal(
  store: ProposalStore,
  proposalId: string,
  conditionHolds: boolean,
  buildProposal: () => Proposal,
): Promise<{ action: ReconcileProposalAction; proposal: Proposal | null }> {
  const existing = await store.read(proposalId);

  if (conditionHolds) {
    if (!existing || existing.status === "resolved") {
      const opened = { ...buildProposal(), status: "open" as const };
      await store.write(opened);
      return { action: "opened", proposal: opened };
    }
    return { action: "noop", proposal: existing };
  }

  if (existing && existing.status === "open") {
    const resolved = { ...existing, status: "resolved" as const };
    await store.write(resolved);
    return { action: "resolved", proposal: resolved };
  }

  return { action: "noop", proposal: existing };
}
