import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { HttpPublisher } from "../src/halyard/publicity/publishers.js";
import { WebhookNotifier } from "../src/halyard/publicity/notify.js";
import { SecretRefSchema } from "../src/halyard/config/secret-ref.js";
import type { ChannelDraft } from "../src/halyard/publicity/drafter.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

interface Captured { url: string; method: string; headers: Record<string, string>; body: any }

function stubFetch(ok: boolean, status: number, jsonBody: unknown = {}): Captured[] {
  const calls: Captured[] = [];
  vi.stubGlobal("fetch", async (url: string, init: any) => {
    calls.push({ url: String(url), method: init.method, headers: init.headers, body: JSON.parse(init.body) });
    return { ok, status, json: async () => jsonBody } as Response;
  });
  return calls;
}

afterEach(() => vi.unstubAllGlobals());

describe("HttpPublisher (owned auto-publish over HTTP)", () => {
  const draft: ChannelDraft = { channel: "blog", surface: "ios", title: "Offline sync is live", body: "Aurora..." };
  beforeEach(() => { process.env.BLOG_PUBLISH_URL = "https://cms.example.com/posts"; });
  afterEach(() => { delete process.env.BLOG_PUBLISH_URL; });
  const ref = SecretRefSchema.parse("SECRET:BLOG_PUBLISH_URL");

  it("POSTs the draft to the resolved endpoint with an Idempotency-Key", async () => {
    const calls = stubFetch(true, 200, { url: "https://cms.example.com/posts/42" });
    const result = await new HttpPublisher().publish("blog", draft, ref);
    expect(result).toEqual({ url: "https://cms.example.com/posts/42", target: "http" });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://cms.example.com/posts");
    expect(calls[0]!.method).toBe("POST");
    expect(calls[0]!.headers["idempotency-key"]).toMatch(/^pub_blog_/); // stable dedup key
    expect(calls[0]!.body).toMatchObject({ channel: "blog", title: draft.title, body: draft.body, surface: "ios" });
  });

  it("throws on a non-2xx response (never silently swallows a failed publish)", async () => {
    stubFetch(false, 502);
    await expect(new HttpPublisher().publish("blog", draft, ref)).rejects.toThrow(/502/);
  });
});

describe("WebhookNotifier (mobile approval surface)", () => {
  beforeEach(() => { process.env.HALYARD_APPROVAL_WEBHOOK = "https://push.example.com/hook"; });
  afterEach(() => { delete process.env.HALYARD_APPROVAL_WEBHOOK; });
  const ref = SecretRefSchema.parse("SECRET:HALYARD_APPROVAL_WEBHOOK");
  const proposal: Proposal = {
    proposal_id: "prop_post_l_x_launch", kind: "social_post", app: "aurora", channel: "x",
    title: "Post to x: Offline sync", body: "Aurora works offline now.", status: "open",
    created_at: "2026-06-07T00:00:00.000Z",
  };

  it("POSTs the notification text + proposal id to the resolved webhook", async () => {
    const calls = stubFetch(true, 200);
    await new WebhookNotifier(ref).notify(proposal);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe("https://push.example.com/hook");
    expect(calls[0]!.body.proposal_id).toBe("prop_post_l_x_launch");
    expect(calls[0]!.body.text).toContain("Review & post to x"); // reinforces invariant #5 on your phone
  });

  it("throws on a non-2xx response", async () => {
    stubFetch(false, 500);
    await expect(new WebhookNotifier(ref).notify(proposal)).rejects.toThrow(/notification failed: 500/);
  });
});
