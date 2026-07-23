import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import type { SentryClient, SentryStats } from "../src/halyard/agents/triage/types.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T11:00:${String(clock++).padStart(2, "0")}.000Z`;

class FakeSentry implements SentryClient {
  constructor(private readonly stats: SentryStats) {}
  async getReleaseHealth(): Promise<SentryStats> {
    return this.stats;
  }
}

class RecordingNotifier implements Notifier {
  readonly sent: Proposal[] = [];
  async notify(p: Proposal): Promise<void> {
    this.sent.push(p);
  }
}

/** A live iOS release bound to a kill-switch flag. */
function seedLiveRelease(): void {
  const launch = newLaunch({
    app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "n",
    announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
    createdBy: "alex", createdAt: now(),
  });
  let r = bindReleaseToLaunch(
    newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
    launch,
  );
  for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark", "live"] as const) {
    r = appendTransition(r, to, "ci", now);
  }
  writeRelease(stateDir, r);
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m6-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M6 verify: a synthetic crash spike yields a classified proposal, not an action", () => {
  it("a spike below threshold produces a classified crash_triage proposal — release untouched", async () => {
    seedLiveRelease();
    const before = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;
    const notifier = new RecordingNotifier();

    const created = await runTriage({
      backend,
      apps: [app],
      sentryClient: new FakeSentry({ crashFreePct: 94.0, eventCount: 8000, topIssueTitle: "NPE in SyncEngine" }),
      classifier: new RuleTriageClassifier(),
      notifier,
      now,
    });

    // A classified proposal exists...
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({
      kind: "crash_triage",
      severity: "critical",
      recommendation: "flag_kill",
      status: "open",
      flag: "launch.aurora.offline_sync",
    });
    expect(listProposals(stateDir).filter((p) => p.kind === "crash_triage")).toHaveLength(1);

    // ...and it was surfaced to the approval queue.
    expect(notifier.sent).toHaveLength(1);

    // ...but NO action was taken: the release is byte-for-byte unchanged (no flag flip,
    // no state change). The recommendation is flag_kill, yet nothing was killed.
    const after = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;
    expect(after).toEqual(before);
    expect(after.state).toBe("live");
  });

  it("a healthy release (above threshold) never reaches the classifier", async () => {
    seedLiveRelease();
    const created = await runTriage({
      backend,
      apps: [app],
      sentryClient: new FakeSentry({ crashFreePct: 99.9, eventCount: 8000, topIssueTitle: "none" }),
      classifier: new RuleTriageClassifier(),
      notifier: new RecordingNotifier(),
      now,
    });
    expect(created).toHaveLength(0);
    expect(listProposals(stateDir)).toHaveLength(0);
  });

  it("is idempotent — re-running does not duplicate the triage proposal", async () => {
    seedLiveRelease();
    const deps = {
      backend, apps: [app],
      sentryClient: new FakeSentry({ crashFreePct: 94.0, eventCount: 8000, topIssueTitle: "NPE" }),
      classifier: new RuleTriageClassifier(),
      notifier: new RecordingNotifier(),
      now,
    };
    expect(await runTriage(deps)).toHaveLength(1);
    expect(await runTriage(deps)).toHaveLength(0);
    expect(listProposals(stateDir)).toHaveLength(1);
  });
});
