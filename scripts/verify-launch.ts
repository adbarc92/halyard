/**
 * Dry-run launch-verification harness — a pre-launch rehearsal.
 *
 * Walks the full spine against in-memory fakes in a throwaway state dir, exactly as a real
 * launch would flow (tag → build/test → upload → review → shipped_dark → flag flip → live →
 * publicity → crash triage), and asserts the load-bearing guarantees hold:
 *   - the path to `live` is hands-off (CI + polls) until the human flag flip,
 *   - owned channels auto-publish but third-party channels only STAGE (invariant #5),
 *   - a crash spike PROPOSES, it never acts (invariant #2).
 *
 * It touches no real provider and writes nothing outside a temp dir, so it's safe to run any
 * time. Use it to sanity-check wiring shape before a real launch. Exit 0 = all green.
 *
 *   npm run verify:launch            # run and clean up
 *   npm run verify:launch -- --keep  # keep the temp state dir for inspection
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import {
  validateOrgConfig,
  validateAppConfig,
  runRelease,
  reconcile,
  readRelease,
  writeRelease,
  newLaunch,
  writeLaunch,
  linkRelease,
  bindReleaseToLaunch,
  listProposals,
  ascReviewSource,
  flagPollSource,
  FlagFileClient,
  firePublicity,
  TemplateDrafter,
  FilePublisher,
  readPublished,
  FileNotifier,
  runTriage,
  RuleTriageClassifier,
  makeGitBackend,
  type AscClient,
  type ReviewStatus,
  type SentryClient,
  type SentryStats,
} from "../src/halyard/index.js";
import { FakeCommandRunner } from "../tests/helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");
const org = validateOrgConfig(parseYaml(readFileSync(join(root, "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(join(root, "apps/aurora/app.yml"), "utf8")));

let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

const approvedAsc: AscClient = { async getReviewStatus(): Promise<ReviewStatus> { return "approved"; } };
class SpikeSentry implements SentryClient {
  async getReleaseHealth(): Promise<SentryStats> {
    return { crashFreePct: 92, eventCount: 9000, topIssueTitle: "NPE in SyncEngine" };
  }
}

// --- tiny check harness ---------------------------------------------------
let passed = 0;
let failed = 0;
function check(label: string, ok: boolean, detail = ""): void {
  if (ok) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ""}`); }
}

async function main(): Promise<void> {
  const keep = process.argv.includes("--keep");
  const stateDir = mkdtempSync(join(tmpdir(), "halyard-verify-"));
  const backend = makeGitBackend({ stateDir });
  console.log(`Halyard launch-verification (dry run)\n  state: ${stateDir}\n`);

  try {
    const flag = "launch.aurora.offline_sync";

    console.log("1. CI: build → test → upload to TestFlight");
    const ciRunner = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=4242\n" },
    ]);
    let release = await runRelease({
      app, surface: "ios", version: "1.4.0", commit: "abc1234",
      backend, workdir: "/tmp/aurora", runner: ciRunner, now,
    });
    check("release reaches `uploaded`", release.state === "uploaded", `got ${release.state}`);

    console.log("\n2. Human creates the launch (flag born OFF) and links the release");
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "Aurora works on the subway.",
      announcePolicy: "per_surface", tier: "standard", flag, createdBy: "verify", createdAt: now(),
    });
    const flagClient = new FlagFileClient(stateDir, now);
    await flagClient.ensureFlag(flag);
    release = bindReleaseToLaunch(release, launch);
    writeRelease(stateDir, release);
    writeLaunch(stateDir, linkRelease(launch, release.release_id));
    check("flag is born OFF", (await flagClient.getState(flag)) === "off");

    const sources = [ascReviewSource(approvedAsc), flagPollSource(flagClient)];

    console.log("\n3. Reconcile: ASC review approved → `shipped_dark` (parks, flag still OFF)");
    await reconcile({ backend, sources, now });
    check("release parks at `shipped_dark`", readRelease(stateDir, release.release_id)!.state === "shipped_dark");
    check("flag still OFF (no auto-flip)", (await flagClient.getState(flag)) === "off");

    console.log("\n4. The human flips the flag ON (the launch moment)");
    await flagClient.setState(flag, true);
    await reconcile({ backend, sources, now });
    const live = readRelease(stateDir, release.release_id)!;
    check("release reaches `live`", live.state === "live", `got ${live.state}`);
    const actors = [...new Set(live.transitions.map((t) => t.by))].sort();
    check(
      "everything up to `live` was hands-off (CI + polls only)",
      JSON.stringify(actors) === JSON.stringify(["asc-review-poll", "ci", "flag-poll"]),
      actors.join(", "),
    );

    console.log("\n5. Publicity fires on `live`");
    const fanout = await firePublicity({
      org, apps: [app], drafter: new TemplateDrafter(),
      publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
      voiceCanon: [], backend, now,
    });
    check("an announcement fanned out", fanout.length === 1);
    check("owned channel auto-published", readPublished(stateDir).some((id) => id.startsWith("pub_blog_")));
    const staged = listProposals(stateDir).filter((p) => p.kind === "social_post").map((p) => p.channel).sort();
    check(
      "third-party channels only STAGED (invariant #5)",
      JSON.stringify(staged) === JSON.stringify(["linkedin", "x"]),
      staged.join(", "),
    );

    console.log("\n6. A crash spike yields a proposal — and takes NO action (invariant #2)");
    const triaged = await runTriage({
      backend, apps: [app], sentryClient: new SpikeSentry(),
      classifier: new RuleTriageClassifier(), notifier: new FileNotifier(stateDir, now), now,
    });
    check("a crash_triage proposal was opened", triaged.length === 1 && triaged[0]?.kind === "crash_triage");
    check("release is still `live` (no auto-rollback)", readRelease(stateDir, release.release_id)!.state === "live");
    check("flag is still ON (no auto-kill)", (await flagClient.getState(flag)) === "on");

    console.log(`\n${failed === 0 ? "✅ ALL GREEN" : "❌ FAILURES"} — ${passed} passed, ${failed} failed`);
    if (keep) console.log(`(kept state dir: ${stateDir})`);
  } finally {
    if (!process.argv.includes("--keep")) rmSync(stateDir, { recursive: true, force: true });
  }

  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((err) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exit(1);
});
