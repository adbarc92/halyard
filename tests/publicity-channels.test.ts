import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, describe, expect, it, vi } from "vitest";
import { validateOrgConfig } from "../src/halyard/config/loader.js";
import { SecretRefSchema } from "../src/halyard/config/secret-ref.js";
import {
  envSecretStore,
  setSecretStore,
  type SecretStore,
} from "../src/halyard/secrets/resolve.js";
import { HttpPublisher } from "../src/halyard/publicity/publishers.js";
import { SlackWebhookNotifier, DiscordWebhookNotifier } from "../src/halyard/publicity/notifiers.js";
import { fanOutAnnouncement, type FanoutDeps } from "../src/halyard/publicity/fanout.js";
import type { ChannelDraft, Drafter } from "../src/halyard/publicity/drafter.js";
import type { Publisher } from "../src/halyard/publicity/publishers.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Backend } from "../src/halyard/coordinator/ports.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";
import type { Launch } from "../src/halyard/contracts/launch.schema.js";
import type { Announcement } from "../src/halyard/publicity/announce-policy.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));

interface Captured { url: string; method: string; headers: Record<string, string>; body: any }

function stubFetch(ok: boolean, status: number, jsonBody: unknown = {}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return { ok, status, json: async () => jsonBody } as Response;
  });
  return calls;
}

/** An injected secret store (invariant #4): the `SECRET:` ref resolves through here, never
 *  from a raw literal embedded in code. Records every bare name it was asked for. */
function injectStore(values: Record<string, string>): { asked: string[] } {
  const asked: string[] = [];
  const store: SecretStore = {
    get: (name) => {
      asked.push(name);
      return values[name];
    },
  };
  setSecretStore(store);
  return { asked };
}

afterEach(() => {
  vi.unstubAllGlobals();
  setSecretStore(envSecretStore); // restore the default for later tests
});

describe("L10: owned-channel publisher POSTs to the resolved endpoint (never a raw credential)", () => {
  const draft: ChannelDraft = { channel: "blog", surface: "ios", title: "Offline sync is live", body: "Aurora..." };

  it("resolves the SECRET: endpoint via the injected store and POSTs the draft there", async () => {
    const { asked } = injectStore({ BLOG_PUBLISH_URL: "https://cms.example.com/posts" });
    const calls = stubFetch(true, 200, { url: "https://cms.example.com/posts/42" });

    const endpointRef = SecretRefSchema.parse("SECRET:BLOG_PUBLISH_URL");
    const result = await new HttpPublisher().publish("blog", draft, endpointRef);

    // The URL came from the store keyed by the bare name — the config held only the ref.
    expect(asked).toContain("BLOG_PUBLISH_URL");
    expect(result).toEqual({ url: "https://cms.example.com/posts/42", target: "http" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://cms.example.com/posts");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^pub_blog_/);
    expect(calls[0]!.body).toMatchObject({ channel: "blog", title: draft.title, body: draft.body, surface: "ios" });
    // The ref we handed the publisher is a reference, not a value (nothing raw embedded).
    expect(endpointRef).toBe("SECRET:BLOG_PUBLISH_URL");
  });
});

const stagedProposal: Proposal = {
  proposal_id: "prop_post_lnch_test_x_launch",
  kind: "social_post",
  app: "aurora",
  launch_id: "lnch_test",
  channel: "x",
  title: "Post to x: Offline sync is live",
  body: "Aurora works offline now.",
  status: "open",
  created_at: "2026-07-08T00:00:00.000Z",
};

describe("L10: Slack + Discord approval-queue notifier presets (owned notification surface)", () => {
  it("Slack notifier POSTs a { text } payload to the resolved webhook", async () => {
    injectStore({ SLACK_APPROVAL_WEBHOOK: "https://hooks.slack.com/services/T/B/xxx" });
    const calls = stubFetch(true, 200);

    await new SlackWebhookNotifier(SecretRefSchema.parse("SECRET:SLACK_APPROVAL_WEBHOOK")).notify(stagedProposal);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://hooks.slack.com/services/T/B/xxx");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.body).toHaveProperty("text");
    expect(calls[0]!.body).not.toHaveProperty("content"); // Slack shape, not Discord
    expect(calls[0]!.body.text).toContain("Review & post to x"); // reinforces "a human posts" (invariant #5)
    expect(calls[0]!.body.text).toContain(stagedProposal.proposal_id);
  });

  it("Discord notifier POSTs a { content } payload to the resolved webhook", async () => {
    injectStore({ DISCORD_APPROVAL_WEBHOOK: "https://discord.com/api/webhooks/1/abc" });
    const calls = stubFetch(true, 200);

    await new DiscordWebhookNotifier(SecretRefSchema.parse("SECRET:DISCORD_APPROVAL_WEBHOOK")).notify(stagedProposal);

    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://discord.com/api/webhooks/1/abc");
    expect(calls[0]!.body).toHaveProperty("content"); // Discord uses `content`, not `text`
    expect(calls[0]!.body).not.toHaveProperty("text");
    expect(calls[0]!.body.content).toContain("Review & post to x");
  });

  it("throws on a non-2xx webhook response (a failed nudge is never swallowed)", async () => {
    injectStore({ SLACK_APPROVAL_WEBHOOK: "https://hooks.slack.com/services/T/B/xxx" });
    stubFetch(false, 500);
    await expect(
      new SlackWebhookNotifier(SecretRefSchema.parse("SECRET:SLACK_APPROVAL_WEBHOOK")).notify(stagedProposal),
    ).rejects.toThrow(/slack approval notification failed: 500/);
  });
});

describe("L10 / invariant #5: a third-party channel is draft-staged, never auto-posted", () => {
  const launch: Launch = {
    launch_id: "lnch_test",
    app: "aurora",
    title: "Offline sync",
    narrative_seed: "It works on the subway now.",
    announce_policy: "per_surface",
    tier: "standard",
    releases: [],
    created_by: "operator",
    created_at: "2026-07-08T00:00:00.000Z",
  };
  const announcement: Announcement = { scope: "launch", reason: "test" };

  const drafter: Drafter = {
    async draft(req) {
      return { channel: req.channel, title: "Offline sync is live", body: "Aurora works offline now." };
    },
  };

  it("fanning out to 'x' stages a proposal + notifies, and NEVER calls the publisher", async () => {
    // A publisher that fails loudly if the boundary is ever crossed for a third-party channel.
    const publisher: Publisher = {
      async publish(channel) {
        throw new Error(`invariant #5 violated: attempted HTTP publish to third-party channel "${channel}"`);
      },
    };

    // In-memory proposal store + ledger; a Slack-style notifier records what it was asked to deliver.
    const written = new Map<string, Proposal>();
    const notified: Proposal[] = [];
    const notifier: Notifier = { async notify(p) { notified.push(p); } };
    const marked = new Set<string>();

    const backend = {
      proposals: {
        read: async (id: string) => written.get(id) ?? null,
        write: async (p: Proposal) => { written.set(p.proposal_id, p); },
        list: async () => [...written.values()],
      },
      ledger: {
        readAnnounced: async () => new Set<string>(),
        markAnnounced: async (_launchId: string, key: string) => { marked.add(key); },
      },
    } as unknown as Backend;

    const deps: FanoutDeps = {
      org,
      enabledChannels: ["x"], // third-party
      drafter,
      publisher,
      notifier,
      voiceCanon: [],
      backend,
      now: () => "2026-07-08T00:00:00.000Z",
      alreadyAnnounced: new Set<string>(),
    };

    const result = await fanOutAnnouncement(announcement, launch, deps);

    const outcome = result.outcomes.find((o) => o.channel === "x")!;
    expect(outcome.action).toBe("staged"); // draft-staged, not published
    expect(outcome.proposal_id).toBeDefined();
    // A proposal landed in the queue and the human was nudged — but nothing was posted.
    expect(written.size).toBe(1);
    expect(notified).toHaveLength(1);
    expect(notified[0]!.channel).toBe("x");
    expect(notified[0]!.kind).toBe("social_post"); // stays a human-post suggestion
    // The publisher throwing was the tripwire; reaching here means it was never invoked.
  });
});
