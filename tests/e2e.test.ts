import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig, validateOrgConfig } from "../src/halyard/config/loader.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, linkRelease, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import { ascReviewSource, type AscClient, type ReviewStatus } from "../src/halyard/coordinator/sources/asc-review.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FilePublisher, readPublished } from "../src/halyard/publicity/publishers.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import type { SentryClient, SentryStats } from "../src/halyard/agents/triage/types.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-06T00:00:${String(clock++).padStart(2, "0")}.000Z`;

const approvedAsc: AscClient = { async getReviewStatus(): Promise<ReviewStatus> { return "approved"; } };
class SpikeSentry implements SentryClient {
  async getReleaseHealth(): Promise<SentryStats> {
    return { crashFreePct: 94, eventCount: 9000, topIssueTitle: "NPE in SyncEngine" };
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-e2e-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("end-to-end: a single iOS launch from tag to live, then a crash-triage proposal", () => {
  it("walks the whole spine hands-off until the human flag-flip", async () => {
    const flag = "launch.aurora.offline_sync";

    // 1. CI: build → test → upload to TestFlight → `uploaded`.
    const ciRunner = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=4242\n" },
    ]);
    let release = await runRelease({
      app, surface: "ios", version: "1.4.0", commit: "abc1234",
      backend, workdir: "/tmp/aurora", runner: ciRunner, now,
    });
    expect(release.state).toBe("uploaded");

    // 2. Human creates the launch (flag born OFF) and links the release.
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "Aurora works on the subway.",
      announcePolicy: "per_surface", tier: "standard", flag, createdBy: "alex", createdAt: now(),
    });
    const flagClient = new FlagFileClient(stateDir, now);
    await flagClient.ensureFlag(flag);
    release = bindReleaseToLaunch(release, launch);
    writeRelease(stateDir, release);
    writeLaunch(stateDir, linkRelease(launch, release.release_id));

    const sources = [ascReviewSource(approvedAsc), flagPollSource(flagClient)];

    // 3. Reconcile: ASC review is approved → `shipped_dark`, parks (flag still OFF).
    await reconcile({ backend, sources, now });
    expect(readRelease(stateDir, release.release_id)!.state).toBe("shipped_dark");

    // 4. The human flips the flag ON (the launch moment).
    await flagClient.setState(flag, true);
    await reconcile({ backend, sources, now });
    const live = readRelease(stateDir, release.release_id)!;
    expect(live.state).toBe("live");

    // Everything up to `live` was hands-off (CI + polls); the flip was the only human act.
    const actors = new Set(live.transitions.map((t) => t.by));
    expect([...actors].sort()).toEqual(["asc-review-poll", "ci", "flag-poll"]);

    // 5. Publicity fires on live: owned auto-publish, third-party stage only.
    const fanout = await firePublicity({
      org, apps: [app], drafter: new TemplateDrafter(),
      publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
      voiceCanon: [], backend, now,
    });
    expect(fanout).toHaveLength(1);
    const published = readPublished(stateDir);
    expect(published.some((id) => id.startsWith("pub_blog_"))).toBe(true); // owned, auto-published
    const staged = listProposals(stateDir).filter((p) => p.kind === "social_post");
    expect(staged.map((p) => p.channel).sort()).toEqual(["linkedin", "x"]); // third-party, staged

    // 6. A crash spike yields a classified proposal — and takes NO action.
    const triaged = await runTriage({
      backend, apps: [app], sentryClient: new SpikeSentry(),
      classifier: new RuleTriageClassifier(), notifier: new FileNotifier(stateDir, now), now,
    });
    expect(triaged).toHaveLength(1);
    expect(triaged[0]).toMatchObject({ kind: "crash_triage", status: "open" });
    // The release is still live and the flag is still ON — nothing was auto-acted.
    expect(readRelease(stateDir, release.release_id)!.state).toBe("live");
    expect(await flagClient.getState(flag)).toBe("on");
  });
});
