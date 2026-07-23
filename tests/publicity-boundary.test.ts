import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import { bindReleaseToLaunch, linkRelease, newLaunch, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { channelAction } from "../src/halyard/publicity/channels.js";
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import type { ChannelDraft } from "../src/halyard/publicity/drafter.js";
import type { Publisher, PublishResult } from "../src/halyard/publicity/publishers.js";
import type { SecretRef } from "../src/halyard/config/secret-ref.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

/** A publisher that records every channel it is asked to publish — and asserts later that
 *  none of them was third-party. */
class SpyPublisher implements Publisher {
  readonly published: string[] = [];
  async publish(channel: string, _d: ChannelDraft, _r: SecretRef): Promise<PublishResult> {
    this.published.push(channel);
    return { url: `http://published/${channel}`, target: "http" };
  }
}

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2026-06-07T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-boundary-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("invariant #5: the publisher is never invoked for a third-party channel", () => {
  it("channelAction stages every third-party channel and only auto-publishes owned http", () => {
    for (const [name, channel] of Object.entries(org.channels)) {
      const action = channelAction(channel, "launch"); // launch tier so tier gates don't skip
      if (channel.class === "third_party") {
        expect(action.kind, `${name} is third_party`).not.toBe("auto_publish");
      }
      if (action.kind === "auto_publish") {
        expect(channel.class, `${name} auto-publishes`).toBe("owned");
      }
    }
  });

  it("firePublicity never calls the Publisher for a third-party channel; third-party stages instead", async () => {
    const flag = "launch.aurora.offline_sync";
    const launch = newLaunch({
      app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
      announcePolicy: "first_surface", tier: "launch", flag, createdBy: "alex", createdAt: now(),
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

    const publisher = new SpyPublisher();
    await firePublicity({
      org, apps: [app], drafter: new TemplateDrafter(),
      publisher, notifier: new FileNotifier(stateDir, now), voiceCanon: [], backend, now,
    });

    // Every channel the publisher was asked to publish must be an OWNED channel.
    for (const channel of publisher.published) {
      expect(org.channels[channel]?.class, `${channel} was published`).toBe("owned");
    }
    // Third-party channels (x, linkedin) were staged as proposals, never published.
    const staged = listProposals(stateDir).filter((p) => p.kind === "social_post").map((p) => p.channel);
    for (const tp of staged) {
      expect(publisher.published).not.toContain(tp);
      expect(org.channels[tp!]?.class).toBe("third_party");
    }
    expect(staged.length).toBeGreaterThan(0); // sanity: third-party channels were exercised
  });
});
