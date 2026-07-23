import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import { buildDraftPrompts } from "../src/halyard/publicity/draft-prompt.js";
import { approveProposal } from "../src/halyard/coordinator/approve.js";
import { readVoiceCanon } from "../src/halyard/publicity/voice-canon.js";
import { proposeOnce } from "../src/halyard/coordinator/proposals.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { firePublicity } from "../src/halyard/publicity/trigger.js";
import { FilePublisher } from "../src/halyard/publicity/publishers.js";
import { FileNotifier } from "../src/halyard/publicity/notify.js";
import { newLaunch, bindReleaseToLaunch, linkRelease, writeLaunch } from "../src/halyard/coordinator/launch-store.js";
import { appendTransition, newRelease, writeRelease } from "../src/halyard/coordinator/record-store.js";
import type { ChannelDraft, DraftRequest, Drafter } from "../src/halyard/publicity/drafter.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let canonDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T14:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m8-"));
  canonDir = mkdtempSync(join(tmpdir(), "halyard-canon-"));
  backend = makeGitBackend({ stateDir, canonDir });
  clock = 0;
});
afterEach(() => {
  rmSync(stateDir, { recursive: true, force: true });
  rmSync(canonDir, { recursive: true, force: true });
});

const launchFixture = newLaunch({
  app: "aurora", feature: "offline_sync", title: "Offline sync", narrativeSeed: "subway",
  announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.offline_sync",
  createdBy: "alex", createdAt: "2025-06-05T00:00:00.000Z",
});

describe("M8: approved posts are injected into the drafting prompt", () => {
  it("buildDraftPrompts emits the canon as exemplars, or a fallback when empty", () => {
    const withCanon = buildDraftPrompts({
      launch: launchFixture, channel: "x", channelClass: "third_party", voiceCanon: ["Aurora ships offline. No spinners."],
    });
    expect(withCanon.system).toContain("APPROVED posts");
    expect(withCanon.system).toContain("Aurora ships offline. No spinners.");

    const empty = buildDraftPrompts({
      launch: launchFixture, channel: "x", channelClass: "third_party", voiceCanon: [],
    });
    expect(empty.system).toContain("No prior approved posts");
  });
});

describe("M8 verify: approving a post feeds the voice canon and the next draft reads it", () => {
  it("closes the loop: approve → canon/voice/ → next launch's drafter receives it", async () => {
    // 1. A staged third-party draft (as M5 would produce).
    const staged: Proposal = {
      proposal_id: "prop_post_lnch_aurora_offline_sync_x_ios",
      kind: "social_post", app: "aurora", launch_id: "lnch_aurora_offline_sync",
      channel: "x", surface: "ios", title: "Post to x: Offline sync", body: "AI draft v1 (generic)",
      status: "open", created_at: now(),
    };
    await proposeOnce(backend.proposals, staged);

    // 2. The human approves with their final, polished copy.
    const finalCopy = "Aurora works on the subway now. Full offline read/write, syncs when you surface.";
    const result = await approveProposal({ backend, proposalId: staged.proposal_id, finalText: finalCopy, now });
    expect(result.canonAppended).toBe(true);
    expect(result.proposal.status).toBe("approved");

    // 3. The approved copy is now in the canon corpus.
    const canon = readVoiceCanon(canonDir);
    expect(canon.some((p) => p.includes("syncs when you surface"))).toBe(true);

    // 4. A NEW launch drafts — and the drafter receives the approved post as input.
    const seenCanon: string[][] = [];
    const spy: Drafter = {
      async draft(req: DraftRequest): Promise<ChannelDraft> {
        seenCanon.push(req.voiceCanon);
        return { channel: req.channel, surface: req.surface, title: "t", body: "b" };
      },
    };

    const launch2 = newLaunch({
      app: "aurora", feature: "dark_mode", title: "Dark mode", narrativeSeed: "easier on the eyes",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.aurora.dark_mode",
      createdBy: "alex", createdAt: now(),
    });
    let r = bindReleaseToLaunch(
      newRelease({ releaseId: "rel_aurora_ios_2.0.0", app: "aurora", surface: "ios", version: "2.0.0" }),
      launch2,
    );
    for (const to of ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark", "live"] as const) {
      r = appendTransition(r, to, "ci", now);
    }
    writeRelease(stateDir, r);
    writeLaunch(stateDir, linkRelease(launch2, r.release_id));

    await firePublicity({
      org, apps: [app],
      drafter: spy,
      publisher: new FilePublisher(stateDir, now),
      notifier: new FileNotifier(stateDir, now),
      voiceCanon: readVoiceCanon(canonDir), // ← the loop: canon flows into the next drafts
      backend, now,
    });

    // Every draft request for the new launch saw the approved post.
    expect(seenCanon.length).toBeGreaterThan(0);
    expect(seenCanon.every((c) => c.some((p) => p.includes("syncs when you surface")))).toBe(true);
  });

  it("appendToCanon is idempotent on the entry id", async () => {
    const staged: Proposal = {
      proposal_id: "prop_post_x", kind: "social_post", app: "aurora",
      channel: "x", title: "t", body: "the post", status: "open", created_at: now(),
    };
    await proposeOnce(backend.proposals, staged);
    expect((await approveProposal({ backend, proposalId: "prop_post_x", now })).canonAppended).toBe(true);
    expect((await approveProposal({ backend, proposalId: "prop_post_x", now })).canonAppended).toBe(false);
    expect(readVoiceCanon(canonDir)).toHaveLength(1);
  });
});
