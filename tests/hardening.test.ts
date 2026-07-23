import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { applyTransition } from "../src/halyard/coordinator/state-machine.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { bindReleaseToLaunch, linkRelease, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FilePublisher } from "../src/halyard/publicity/publishers.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import { runCertWatch } from "../src/halyard/maintenance/cert-watch.js";
import { listProposals, readProposal, writeProposal } from "../src/halyard/coordinator/proposals.js";
import type { SentryClient, SentryStats } from "../src/halyard/agents/triage/types.js";
import type { CertExpiryProvider, CertKind, CertStatus } from "../src/halyard/maintenance/types.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-05T00:00:${String(clock++).padStart(2, "0")}.000Z`;

class RecordingNotifier implements Notifier {
  readonly sent: Proposal[] = [];
  async notify(p: Proposal): Promise<void> { this.sent.push(p); }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-hard-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("Workstream A: the rejected → in_review resubmit loop is no longer stuck", () => {
  it("a resubmit after rejection re-enters in_review (#2) and can reach shipped_dark", () => {
    let r = newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" });
    for (const to of ["tagged", "built", "tested", "uploaded"] as const) r = appendTransition(r, to, "ci", now);

    const step = (to: Parameters<typeof applyTransition>[1]) => {
      const out = applyTransition(r, to, "asc-review-poll", now);
      r = out.release;
      return out;
    };

    expect(step("in_review").applied).toBe(true);
    expect(step("rejected").applied).toBe(true);
    // While rejected, a re-poll that still says "rejected" is a duplicate (no churn).
    expect(step("rejected")).toMatchObject({ applied: false, reason: "duplicate" });
    // Developer resubmits → ASC says in_review again → a *new* in_review is recorded.
    expect(step("in_review").applied).toBe(true);
    expect(step("shipped_dark").applied).toBe(true);

    expect(r.state).toBe("shipped_dark"); // no longer stuck at rejected
    const inReviewKeys = r.transitions.filter((t) => t.to === "in_review").map((t) => t.dedup_key);
    expect(inReviewKeys).toEqual(["rel_aurora_ios_1.4.0:in_review", "rel_aurora_ios_1.4.0:in_review#2"]);
  });

  it("a fast Apple re-approval after a rejection (lossy jump rejected→approved) reaches shipped_dark", () => {
    // The review poll is lossy: a developer fixes a rejection and resubmits, and ASC moves
    // REJECTED → READY_FOR_SALE between two cron passes, so the poll observes `approved`
    // (→ shipped_dark) directly from `rejected`. Without the legal edge this strands forever.
    let r = newRelease({ releaseId: "rel_aurora_ios_1.5.0", app: "aurora", surface: "ios", version: "1.5.0" });
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "rejected"] as const) {
      r = appendTransition(r, to, "ci", now);
    }

    const out = applyTransition(r, "shipped_dark", "asc-review-poll", now);
    expect(out.applied).toBe(true); // was {applied:false, reason:"illegal"} before the fix
    expect(out.release.state).toBe("shipped_dark"); // not stranded at rejected
  });
});

describe("Workstream C: re-flip after rollback returns the release to live", () => {
  function setupLinkedShippedDark(): { flag: string; client: FlagFileClient } {
    const flag = "launch.aurora.offline_sync";
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
      announcePolicy: "per_surface", tier: "standard", flag, createdBy: "alex", createdAt: now(),
    });
    let r = bindReleaseToLaunch(
      newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
      launch,
    );
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"] as const) {
      r = appendTransition(r, to, "ci", now);
    }
    writeRelease(stateDir, r);
    writeLaunch(stateDir, linkRelease(launch, r.release_id));
    return { flag, client: new FlagFileClient(stateDir, now) };
  }

  it("shipped_dark → live → rolled_back → (re-flip) → live#2", async () => {
    const { flag, client } = await Promise.resolve(setupLinkedShippedDark());
    const sources = [flagPollSource(client)];
    const id = "rel_aurora_ios_1.4.0";

    await client.setState(flag, true);
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, id)!.state).toBe("live");

    await client.setState(flag, false);
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, id)!.state).toBe("rolled_back");

    await client.setState(flag, true);
    await reconcile({ backend, sources, now });
    const rec = readRelease(stateDir, id)!;
    expect(rec.state).toBe("live"); // re-flipped back on
    const liveKeys = rec.transitions.filter((t) => t.to === "live").map((t) => t.dedup_key);
    expect(liveKeys).toEqual([`${id}:live`, `${id}:live#2`]);
  });

  it("publicity does not re-announce on the second live (ledger holds)", async () => {
    const { flag, client } = setupLinkedShippedDark();
    const sources = [flagPollSource(client)];
    const pubDeps = () => ({
      org, apps: [app], drafter: new TemplateDrafter(),
      publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
      voiceCanon: [] as string[], backend, now,
    });

    await client.setState(flag, true);
    await reconcile({ backend, sources, now });
    expect(await firePublicity(pubDeps())).toHaveLength(1); // first live announces

    await client.setState(flag, false);
    await reconcile({ backend, sources, now }); // → rolled_back
    await client.setState(flag, true);
    await reconcile({ backend, sources, now }); // → live#2
    expect(await firePublicity(pubDeps())).toHaveLength(0); // already announced
  });
});

describe("Workstream B: proposals close on resolve and reopen on recurrence", () => {
  class MutableSentry implements SentryClient {
    constructor(public stats: SentryStats) {}
    async getReleaseHealth(): Promise<SentryStats> { return this.stats; }
  }

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

  it("triage: spike opens → recovery resolves → re-spike reopens", async () => {
    seedLiveRelease();
    const sentry = new MutableSentry({ crashFreePct: 94, eventCount: 8000, topIssueTitle: "NPE" });
    const deps = { backend, apps: [app], sentryClient: sentry, classifier: new RuleTriageClassifier(), notifier: new RecordingNotifier(), now };
    const id = "prop_triage_rel_aurora_ios_1.4.0_1"; // live cycle 1

    expect(await runTriage(deps)).toHaveLength(1);
    expect(readProposal(stateDir, id)!.status).toBe("open");

    // Crash-free recovers → auto-resolved, drops out of the default queue.
    sentry.stats = { crashFreePct: 99.95, eventCount: 8000, topIssueTitle: "none" };
    await runTriage(deps);
    expect(readProposal(stateDir, id)!.status).toBe("resolved");
    expect(listProposals(stateDir).filter((p) => p.status === "open")).toHaveLength(0);

    // Re-spike → reopened.
    sentry.stats = { crashFreePct: 92, eventCount: 9000, topIssueTitle: "NPE again" };
    expect(await runTriage(deps)).toHaveLength(1);
    expect(readProposal(stateDir, id)!.status).toBe("open");
  });

  it("a human-dismissed triage alert is never auto-reopened", async () => {
    seedLiveRelease();
    const sentry = new MutableSentry({ crashFreePct: 94, eventCount: 8000, topIssueTitle: "NPE" });
    const deps = { backend, apps: [app], sentryClient: sentry, classifier: new RuleTriageClassifier(), notifier: new RecordingNotifier(), now };
    const id = "prop_triage_rel_aurora_ios_1.4.0_1"; // live cycle 1

    await runTriage(deps);
    writeProposal(stateDir, { ...readProposal(stateDir, id)!, status: "dismissed" }); // human says ignore

    expect(await runTriage(deps)).toHaveLength(0); // spike still on, but stays dismissed
    expect(readProposal(stateDir, id)!.status).toBe("dismissed");
  });

  it("cert alert resolves once the cert is renewed out of the window", async () => {
    const certs: Record<CertKind, string> = {
      apple_distribution: "2026-06-10T00:00:00.000Z", // 5 days → alert
      apple_push_key: "2027-01-01T00:00:00.000Z",
      authenticode: "2027-01-01T00:00:00.000Z",
    };
    const provider: CertExpiryProvider = {
      async getCertStatus(_a, kind): Promise<CertStatus> { return { kind, notAfter: certs[kind] }; },
    };
    const deps = { backend, apps: [app], provider, notifier: new RecordingNotifier(), now };
    const id = "prop_cert_aurora_apple_distribution";

    expect((await runCertWatch(deps)).created).toHaveLength(1);
    expect(readProposal(stateDir, id)!.status).toBe("open");

    // Renewed: pushed well beyond the window → resolved.
    certs.apple_distribution = "2027-06-10T00:00:00.000Z";
    await runCertWatch(deps);
    expect(readProposal(stateDir, id)!.status).toBe("resolved");
  });
});
