import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import { SecretRefSchema } from "../src/halyard/config/secret-ref.js";
import { resolveSecret, tryResolveSecret } from "../src/halyard/secrets/resolve.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, linkRelease, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FilePublisher } from "../src/halyard/publicity/publishers.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { runTriage } from "../src/halyard/agents/triage/triage-runner.js";
import { RuleTriageClassifier } from "../src/halyard/agents/triage/rule-classifier.js";
import type { SentryClient, SentryStats } from "../src/halyard/agents/triage/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

class SpikeSentry implements SentryClient {
  async getReleaseHealth(): Promise<SentryStats> {
    return { crashFreePct: 92, eventCount: 9000, topIssueTitle: "NPE in SyncEngine" };
  }
}

/** Every file under a directory tree, recursively. */
function walk(dir: string): string[] {
  if (!statSafe(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : [p];
  });
}
function statSafe(p: string): boolean {
  try { return statSync(p).isDirectory(); } catch { return false; }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-secrets-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("invariant #4: a resolved secret value is never serialized to state/", () => {
  it("resolveSecret reads the value from env and throws (naming the var) when unset", () => {
    process.env.HALYARD_TEST_SECRET = "super-secret-value";
    const ref = SecretRefSchema.parse("SECRET:HALYARD_TEST_SECRET");
    expect(resolveSecret(ref)).toBe("super-secret-value");
    delete process.env.HALYARD_TEST_SECRET;
    expect(() => resolveSecret(ref)).toThrow(/HALYARD_TEST_SECRET/);
    expect(tryResolveSecret(ref)).toBeUndefined();
  });

  it("running the full file-based pipeline with secrets in env leaves no secret in any record", async () => {
    // Arm every secret-ish env var with a unique sentinel. If any of these strings ends up
    // in a state record / ledger / proposal / notification, invariant #4 is broken.
    const SENTINEL = "SENTINEL_SECRET_d3adb33f";
    const armed = [
      "ANTHROPIC_API_KEY", "HALYARD_APPROVAL_WEBHOOK", "BLOG_PUBLISH_URL",
      "EMAIL_SEND_URL", "AURORA_FLAG_PROVIDER_KEY", "SENTRY_AUTH_TOKEN",
    ];
    for (const k of armed) process.env[k] = `${SENTINEL}_${k}`;
    try {
      // Seed a live, linked launch.
      const flag = "launch.aurora.offline_sync";
      const launch = newLaunch({
        app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "Aurora on the subway.",
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
      writeLaunch(stateDir, linkRelease(launch, r.release_id));

      // Fan out publicity (owned auto-publish + third-party staged) and run triage — all
      // with file-backed adapters, the path that persists records.
      await firePublicity({
        org, apps: [app], drafter: new TemplateDrafter(),
        publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
        voiceCanon: [], backend, now,
      });
      await runTriage({
        backend, apps: [app], sentryClient: new SpikeSentry(),
        classifier: new RuleTriageClassifier(), notifier: new FileNotifier(stateDir, now), now,
      });

      const files = walk(stateDir);
      expect(files.length).toBeGreaterThan(0); // sanity: we actually wrote records
      for (const f of files) {
        expect(readFileSync(f, "utf8")).not.toContain(SENTINEL);
      }
    } finally {
      for (const k of armed) delete process.env[k];
    }
  });
});
