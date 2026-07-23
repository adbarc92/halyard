import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOrgConfig } from "../src/halyard/config/loader.js";
import { newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { fanOutAnnouncement } from "../src/halyard/publicity/fanout.js";
import type { Announcement } from "../src/halyard/publicity/announce-policy.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { readAnnounced } from "../src/halyard/publicity/ledger.js";
import type { ChannelDraft } from "../src/halyard/publicity/drafter.js";
import type { Publisher, PublishResult } from "../src/halyard/publicity/publishers.js";
import type { SecretRef } from "../src/halyard/config/secret-ref.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));

/** Counts publish calls per channel so we can prove owned channels publish at most once. */
class RecordingPublisher implements Publisher {
  readonly calls: string[] = [];
  async publish(channel: string, _draft: ChannelDraft, _ref: SecretRef): Promise<PublishResult> {
    this.calls.push(channel);
    return { url: `http://published/${channel}`, target: "http" };
  }
}

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-06T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-pubres-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("publicity fan-out resilience (per-channel ledger)", () => {
  const launch = () =>
    newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
      announcePolicy: "first_surface", tier: "standard", flag: "launch.aurora.offline_sync",
      createdBy: "alex", createdAt: now(),
    });
  const announcement: Announcement = { scope: "launch", reason: "test" };

  it("a transient skip (channel missing from the registry) keeps the scope incomplete, then recovers without re-publishing", async () => {
    const l = launch();
    const publisher = new RecordingPublisher();
    const alreadyAnnounced = new Set<string>();
    const deps = {
      org, drafter: new TemplateDrafter(), publisher,
      notifier: new FileNotifier(stateDir, now), voiceCanon: [] as string[],
      backend, now, alreadyAnnounced,
    };

    // Pass 1: blog is owned (auto-publish); "ghost" isn't in the org registry → retryable skip.
    const first = await fanOutAnnouncement(announcement, l, { ...deps, enabledChannels: ["blog", "ghost"] });
    expect(first.complete).toBe(false); // retryable skip present → scope must NOT be marked done
    expect(publisher.calls).toEqual(["blog"]);
    expect(first.outcomes.find((o) => o.channel === "ghost")).toMatchObject({ action: "skipped", retryable: true });
    // blog's per-channel key is persisted even though the scope isn't complete.
    expect(readAnnounced(stateDir, l.launch_id).has("launch::blog")).toBe(true);
    expect(readAnnounced(stateDir, l.launch_id).has("launch")).toBe(false);

    // Pass 2: registry fixed (ghost removed). blog must NOT publish again; now complete.
    const second = await fanOutAnnouncement(announcement, l, { ...deps, enabledChannels: ["blog"] });
    expect(second.complete).toBe(true);
    expect(publisher.calls).toEqual(["blog"]); // still once — no double-post on replay
    expect(second.outcomes.find((o) => o.channel === "blog")).toMatchObject({ action: "skipped", detail: "already announced" });
  });

  it("a publisher failure on one owned channel is isolated: siblings still publish, the failed channel stays a retryable skip and recovers next pass", async () => {
    const l = launch();
    // Throws on `blog` the first time only; `waitlist_email` always succeeds.
    class FlakyPublisher implements Publisher {
      readonly calls: string[] = [];
      private failsLeft: number;
      constructor(private readonly failChannel: string, failTimes: number) {
        this.failsLeft = failTimes;
      }
      async publish(channel: string, _draft: ChannelDraft, _ref: SecretRef): Promise<PublishResult> {
        if (channel === this.failChannel && this.failsLeft > 0) {
          this.failsLeft--;
          throw new Error("endpoint 503");
        }
        this.calls.push(channel);
        return { url: `http://published/${channel}`, target: "http" };
      }
    }
    const publisher = new FlakyPublisher("blog", 1);
    const alreadyAnnounced = new Set<string>();
    const deps = {
      org, drafter: new TemplateDrafter(), publisher,
      notifier: new FileNotifier(stateDir, now), voiceCanon: [] as string[],
      backend, now, alreadyAnnounced,
    };

    // Pass 1: blog's publish throws → caught as a retryable skip; the loop continues and
    // waitlist_email still publishes (one bad channel must not abort the fan-out / cycle).
    const first = await fanOutAnnouncement(announcement, l, { ...deps, enabledChannels: ["blog", "waitlist_email"] });
    expect(publisher.calls).toEqual(["waitlist_email"]);
    expect(first.outcomes.find((o) => o.channel === "blog")).toMatchObject({ action: "skipped", retryable: true });
    expect(first.complete).toBe(false); // a failed channel keeps the scope pending → retried
    // The failed channel is NOT marked announced; the successful sibling IS.
    expect(readAnnounced(stateDir, l.launch_id).has("launch::blog")).toBe(false);
    expect(readAnnounced(stateDir, l.launch_id).has("launch::waitlist_email")).toBe(true);

    // Pass 2: endpoint recovered → blog publishes now; waitlist_email does NOT re-publish.
    const second = await fanOutAnnouncement(announcement, l, { ...deps, enabledChannels: ["blog", "waitlist_email"] });
    expect(publisher.calls).toEqual(["waitlist_email", "blog"]);
    expect(second.complete).toBe(true);
  });

  it("replaying a completed fan-out never re-publishes an owned channel", async () => {
    const l = launch();
    const publisher = new RecordingPublisher();
    const alreadyAnnounced = new Set<string>();
    const deps = {
      org, enabledChannels: ["blog"], drafter: new TemplateDrafter(), publisher,
      notifier: new FileNotifier(stateDir, now), voiceCanon: [] as string[],
      backend, now, alreadyAnnounced,
    };

    await fanOutAnnouncement(announcement, l, deps);
    await fanOutAnnouncement(announcement, l, deps);
    expect(publisher.calls).toEqual(["blog"]); // exactly once across two passes
  });
});
