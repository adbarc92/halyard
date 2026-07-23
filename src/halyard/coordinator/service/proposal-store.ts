// src/halyard/coordinator/service/proposal-store.ts
import { ProposalSchema, type Proposal } from "../../contracts/proposal.schema.js";
import type { ProposalStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceProposalStore implements ProposalStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(proposalId: string): Promise<Proposal | null> {
    const raw = await this.client.getJson(`/proposals/${encodeURIComponent(proposalId)}`);
    return raw === null ? null : ProposalSchema.parse(raw);
  }

  async write(proposal: Proposal): Promise<void> {
    await this.client.sendJson("PUT", `/proposals/${encodeURIComponent(proposal.proposal_id)}`, proposal);
  }

  async list(): Promise<Proposal[]> {
    const raw = (await this.client.getJson("/proposals")) as unknown[] | null;
    return (raw ?? [])
      .map((p) => ProposalSchema.parse(p))
      .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id)); // matches listProposals
  }
}
