import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runRejectionResponses } from "../src/halyard/agents/rejection/rejection-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { TemplateRejectionDrafter } from "../src/halyard/agents/rejection/rejection-drafter.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T12:00:${String(clock++).padStart(2, "0")}.000Z`;

class RecordingNotifier implements Notifier {
  readonly sent: Proposal[] = [];
  async notify(p: Proposal): Promise<void> {
    this.sent.push(p);
  }
}

function seedRejected(): void {
  let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
  for (const to of ["tagged", "built", "tested", "uploaded", "rejected"] as const) {
    r = appendTransition(r, to, "ci", now);
  }
  r = { ...r, external_refs: { ...r.external_refs, review_status: "rejected" } };
  writeRelease(stateDir, r);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-rej-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M6: rejection-response drafter proposes a draft, never submits", () => {
  it("a rejected release yields a rejection_response proposal", async () => {
    seedRejected();
    const before = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;
    const notifier = new RecordingNotifier();

    const created = await runRejectionResponses({
      backend,
      drafter: new TemplateRejectionDrafter(),
      notifier,
      now,
    });

    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "rejection_response", status: "open" });
    expect(created[0]!.body).toMatch(/submit/i); // explicitly a draft, human submits
    expect(notifier.sent).toHaveLength(1);

    // No action: the release stays rejected, untouched.
    expect(readRelease(stateDir, "rel_aurora_ios_1.4.0")!).toEqual(before);
    expect(listProposals(stateDir).filter((p) => p.kind === "rejection_response")).toHaveLength(1);
  });

  it("does nothing for releases that are not rejected", async () => {
    let r = newRelease({ releaseId: "rel_aurora_ios_1.5.0", app: "aurora", surface: "ios", version: "1.5.0" });
    r = appendTransition(r, "tagged", "ci", now);
    writeRelease(stateDir, r);
    const created = await runRejectionResponses({
      backend, drafter: new TemplateRejectionDrafter(), notifier: new RecordingNotifier(), now,
    });
    expect(created).toHaveLength(0);
  });
});
