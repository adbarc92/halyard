import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { approveProposal } from "../src/halyard/coordinator/approve.js";
import { proposeOnce, readProposal } from "../src/halyard/coordinator/proposals.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readVoiceCanon } from "../src/halyard/publicity/voice-canon.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

let stateDir: string;
let canonDir: string;
let backend: ReturnType<typeof makeGitBackend>;
const now = () => "2026-06-06T00:00:00.000Z";

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-approve-"));
  canonDir = mkdtempSync(join(tmpdir(), "halyard-canon-"));
  backend = makeGitBackend({ stateDir, canonDir });
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(canonDir, { recursive: true, force: true });
});

function social(id: string, body = "AI draft"): Proposal {
  return { proposal_id: id, kind: "social_post", app: "aurora", channel: "x", title: "Post to x", body, status: "open", created_at: now() };
}

describe("§E: approveProposal", () => {
  it("approves a social_post and feeds the FINAL edited copy into the canon", async () => {
    await proposeOnce(backend.proposals, social("prop_post_x"));
    const final = "Aurora works on the subway. No spinners.";
    const res = await approveProposal({ backend, proposalId: "prop_post_x", finalText: final, now });

    expect(res.proposal.status).toBe("approved");
    expect(res.canonAppended).toBe(true);
    expect(readProposal(stateDir, "prop_post_x")!.status).toBe("approved");
    expect(readVoiceCanon(canonDir).join("\n")).toContain(final); // the edited copy, not the draft
  });

  it("falls back to the draft body when no finalText is given", async () => {
    await proposeOnce(backend.proposals, social("prop_post_x", "the original draft body"));
    await approveProposal({ backend, proposalId: "prop_post_x", now });
    expect(readVoiceCanon(canonDir).join("\n")).toContain("the original draft body");
  });

  it("does not touch the canon for a non-social proposal", async () => {
    await proposeOnce(backend.proposals, {
      proposal_id: "prop_flagrm_x", kind: "flag_removal", app: "aurora",
      title: "Remove stale flag", body: "...", status: "open", created_at: now(),
    });
    const res = await approveProposal({ backend, proposalId: "prop_flagrm_x", now });
    expect(res.canonAppended).toBe(false);
    expect(readVoiceCanon(canonDir)).toHaveLength(0);
  });

  it("throws on an unknown proposal id", async () => {
    await expect(approveProposal({ backend, proposalId: "nope", now })).rejects.toThrow(/no such proposal/);
  });
});
