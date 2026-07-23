import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { appendTransition, newRelease, readRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import type { SentryClient, SentryStats, TriageClassification, TriageClassifier } from "../src/halyard/agents/triage/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

class CriticalSentry implements SentryClient {
  async getReleaseHealth(): Promise<SentryStats> {
    return { crashFreePct: 80, eventCount: 50000, topIssueTitle: "hard crash on launch" };
  }
}
/** A classifier that always recommends the most aggressive action — the test proves even
 *  this never causes an action. */
class AlwaysKillClassifier implements TriageClassifier {
  async classify(): Promise<TriageClassification> {
    return { severity: "critical", recommendation: "flag_kill", rationale: "model says kill" };
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-noact-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("invariant #2: a model's flag_kill recommendation never flips a flag or moves the release", () => {
  it("triage proposes flag_kill but the flag stays ON and the release stays live", async () => {
    const flag = "launch.aurora.offline_sync";
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "n",
      announcePolicy: "per_surface", tier: "standard", flag, createdBy: "alex", createdAt: now(),
    });
    let r = bindReleaseToLaunch(
      newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface: "ios", version: "1.4.0" }),
      launch,
    );
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark", "live"] as const) {
      r = appendTransition(r, to, "ci", now);
    }
    writeRelease(stateDir, r);

    const flags = new FlagFileClient(stateDir, now);
    await flags.setState(flag, true); // the launch is ON

    const proposals = await runTriage({
      backend, apps: [app], sentryClient: new CriticalSentry(),
      classifier: new AlwaysKillClassifier(), notifier: new FileNotifier(stateDir, now), now,
    });

    // It PROPOSED a flag_kill...
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({ kind: "crash_triage", recommendation: "flag_kill", status: "open" });
    // ...but took NO action: the flag is still ON and the release is still live.
    expect(await flags.getState(flag)).toBe("on");
    expect(readRelease(stateDir, r.release_id)!.state).toBe("live");
  });
});
