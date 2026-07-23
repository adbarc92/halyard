import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { proposeFlagGraduations } from "../src/halyard/coordinator/graduation.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { runRejectionResponses } from "../src/halyard/agents/rejection/rejection-runner.js";
import { TemplateRejectionDrafter } from "../src/halyard/agents/rejection/rejection-drafter.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import { listProposals, readProposal, writeProposal } from "../src/halyard/coordinator/proposals.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";
import type { SentryClient, SentryStats } from "../src/halyard/agents/triage/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-auditfix-"));
  backend = makeGitBackend({ stateDir });
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const at = (ts: string) => () => ts;

class RecordingNotifier implements Notifier {
  readonly sent: Proposal[] = [];
  async notify(p: Proposal): Promise<void> { this.sent.push(p); }
}

/** Build a release record (with a flag) by walking [state, timestamp] pairs. */
function build(id: string, surface: Release["surface"], steps: Array<[Release["state"], string]>): Release {
  let r: Release = {
    ...newRelease({ releaseId: id, app: "aurora", surface, version: "1.4.0" }),
    flag: "launch.aurora.offline_sync",
    launch_id: "lnch_aurora_offline_sync",
  };
  for (const [to, ts] of steps) r = appendTransition(r, to, "test", at(ts));
  writeRelease(stateDir, r);
  return r;
}

describe("§A bug fix: graduation measures from the LATEST live, not the first", () => {
  it("does not propose removal right after a re-flip, even if the first live was long ago", async () => {
    build("rel_aurora_ios_1.4.0", "ios", [
      ["tagged", "2026-01-01T00:00:00.000Z"],
      ["built", "2026-01-01T00:01:00.000Z"],
      ["tested", "2026-01-01T00:02:00.000Z"],
      ["uploaded", "2026-01-01T00:03:00.000Z"],
      ["in_review", "2026-01-01T00:04:00.000Z"],
      ["shipped_dark", "2026-01-01T00:05:00.000Z"],
      ["live", "2026-01-01T00:06:00.000Z"], // first live: 100+ days ago
      ["rolled_back", "2026-01-02T00:00:00.000Z"],
      ["live", "2026-04-11T00:00:00.000Z"], // re-flip: 1 day before "now"
    ]);
    const created = await proposeFlagGraduations({
      backend,
      now: () => "2026-04-12T00:00:00.000Z",
      thresholdDaysByApp: { aurora: 30 },
    });
    expect(created).toHaveLength(0); // current live cycle is 1 day old
  });

  it("still proposes when the (single) live cycle is older than the window", async () => {
    build("rel_aurora_ios_1.5.0", "ios", [
      ["tagged", "2026-01-01T00:00:00.000Z"],
      ["built", "2026-01-01T00:01:00.000Z"],
      ["tested", "2026-01-01T00:02:00.000Z"],
      ["uploaded", "2026-01-01T00:03:00.000Z"],
      ["in_review", "2026-01-01T00:04:00.000Z"],
      ["shipped_dark", "2026-01-01T00:05:00.000Z"],
      ["live", "2026-01-01T00:06:00.000Z"],
    ]);
    const created = await proposeFlagGraduations({
      backend,
      now: () => "2026-06-01T00:00:00.000Z", // ~151 days live
      thresholdDaysByApp: { aurora: 30 },
    });
    expect(created).toHaveLength(1);
  });
});

describe("§A bug fix: a second store rejection gets its own drafted response", () => {
  it("re-rejection (rejected → in_review → rejected#2) produces a distinct proposal", async () => {
    let r = build("rel_aurora_ios_1.4.0", "ios", [
      ["tagged", "2026-06-01T00:00:00.000Z"],
      ["built", "2026-06-01T00:01:00.000Z"],
      ["tested", "2026-06-01T00:02:00.000Z"],
      ["uploaded", "2026-06-01T00:03:00.000Z"],
      ["rejected", "2026-06-01T00:04:00.000Z"],
    ]);
    const deps = { backend, drafter: new TemplateRejectionDrafter(), notifier: new RecordingNotifier(), now: () => "2026-06-01T00:05:00.000Z" };

    expect(await runRejectionResponses(deps)).toHaveLength(1); // first rejection drafted

    // Developer resubmits → re-rejected.
    r = appendTransition(r, "in_review", "asc-review-poll", at("2026-06-02T00:00:00.000Z"));
    r = appendTransition(r, "rejected", "asc-review-poll", at("2026-06-03T00:00:00.000Z"));
    writeRelease(stateDir, r);

    expect(await runRejectionResponses(deps)).toHaveLength(1); // second rejection drafted (not suppressed)
    const drafts = listProposals(stateDir).filter((p) => p.kind === "rejection_response");
    expect(drafts.map((p) => p.proposal_id).sort()).toEqual([
      "prop_rejresp_rel_aurora_ios_1.4.0_1",
      "prop_rejresp_rel_aurora_ios_1.4.0_2",
    ]);
  });
});

describe("§A bug fix: a crash spike in a new live cycle is not suppressed by a prior cycle's decision", () => {
  class FixedSentry implements SentryClient {
    constructor(private readonly pct: number) {}
    async getReleaseHealth(): Promise<SentryStats> {
      return { crashFreePct: this.pct, eventCount: 8000, topIssueTitle: "NPE" };
    }
  }

  it("post-re-flip spike opens a fresh triage proposal even after the first was dismissed", async () => {
    let r = build("rel_aurora_ios_1.4.0", "ios", [
      ["tagged", "2026-06-01T00:00:00.000Z"],
      ["built", "2026-06-01T00:01:00.000Z"],
      ["tested", "2026-06-01T00:02:00.000Z"],
      ["uploaded", "2026-06-01T00:03:00.000Z"],
      ["in_review", "2026-06-01T00:04:00.000Z"],
      ["shipped_dark", "2026-06-01T00:05:00.000Z"],
      ["live", "2026-06-01T00:06:00.000Z"], // cycle 1
    ]);
    const deps = {
      backend, apps: [app], sentryClient: new FixedSentry(94),
      classifier: new RuleTriageClassifier(), notifier: new RecordingNotifier(),
      now: () => "2026-06-01T00:07:00.000Z",
    };

    await runTriage(deps);
    const firstId = "prop_triage_rel_aurora_ios_1.4.0_1";
    expect(readProposal(stateDir, firstId)!.status).toBe("open");

    // Human dismisses cycle-1's alert.
    writeProposal(stateDir, { ...readProposal(stateDir, firstId)!, status: "dismissed" });

    // Rollback + re-flip → live cycle 2.
    r = appendTransition(r, "rolled_back", "flag-poll", at("2026-06-02T00:00:00.000Z"));
    r = appendTransition(r, "live", "flag-poll", at("2026-06-03T00:00:00.000Z"));
    writeRelease(stateDir, r);

    // A new spike in cycle 2 must NOT be suppressed by cycle 1's dismissed proposal.
    expect(await runTriage(deps)).toHaveLength(1);
    expect(readProposal(stateDir, "prop_triage_rel_aurora_ios_1.4.0_2")!.status).toBe("open");
    expect(readProposal(stateDir, firstId)!.status).toBe("dismissed"); // untouched
  });
});
