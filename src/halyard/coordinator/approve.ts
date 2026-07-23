import type { Proposal } from "../contracts/proposal.schema.js";
import type { Backend } from "./ports.js";

/**
 * Approve a proposal (the human action). For a third-party `social_post`, approval also
 * feeds the post into the voice canon (M8) — the final, human-polished copy (`finalText`
 * if the human edited it, otherwise the draft body). Approving does NOT post anything:
 * the post button stays a human action (invariant #5).
 */
export interface ApproveResult {
  proposal: Proposal;
  canonAppended: boolean;
}

export async function approveProposal(args: {
  backend: Backend;
  proposalId: string;
  finalText?: string | undefined;
  now: () => string;
}): Promise<ApproveResult> {
  const proposal = await args.backend.proposals.read(args.proposalId);
  if (!proposal) throw new Error(`no such proposal: ${args.proposalId}`);

  const approved: Proposal = { ...proposal, status: "approved" };
  await args.backend.proposals.write(approved);

  let canonAppended = false;
  if (proposal.kind === "social_post") {
    canonAppended = await args.backend.canon.append({
      id: `canon_${proposal.proposal_id}`,
      channel: proposal.channel,
      text: args.finalText ?? proposal.body,
      approvedAt: args.now(),
    });
  }

  return { proposal: approved, canonAppended };
}
