import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveSecret } from "../secrets/resolve.js";
import type { SecretRef } from "../config/secret-ref.js";
import type { ChannelDraft } from "./drafter.js";
import { fetchWithTimeout } from "../net.js";

/**
 * Publisher port — used ONLY for owned channels that passed the auto-publish gate. There
 * is deliberately no publisher for third-party channels: those stage as proposals and a
 * human presses post (invariant #5).
 */
export interface PublishResult {
  url?: string | undefined;
  target: string;
}

export interface Publisher {
  /** `endpointRef` is the channel's http publish endpoint secret reference. */
  publish(channel: string, draft: ChannelDraft, endpointRef: SecretRef): Promise<PublishResult>;
}

/**
 * Git-backed publisher: records the published artifact under `state/publicity/published/`.
 * The default for local runs and tests — "owned auto-publishes" is observable on disk
 * without hitting a live endpoint. Idempotent on a stable id.
 */
export class FilePublisher implements Publisher {
  constructor(private readonly stateDir: string, private readonly now: () => string) {}

  async publish(channel: string, draft: ChannelDraft, _endpointRef: SecretRef): Promise<PublishResult> {
    const id = publishId(draft);
    const path = join(this.stateDir, "publicity", "published", `${id}.json`);
    if (!existsSync(path)) {
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(
        path,
        JSON.stringify({ id, ...draft, published_at: this.now() }, null, 2) + "\n",
        "utf8",
      );
    }
    return { url: `file://published/${id}`, target: "file" };
  }
}

/**
 * Real HTTP publisher for owned endpoints (blog CMS, email send API). Resolves the
 * endpoint from the secret store at call time — the URL is never written to config or
 * logged. Not exercised by the test suite (live network); the logic above is.
 */
export class HttpPublisher implements Publisher {
  async publish(channel: string, draft: ChannelDraft, endpointRef: SecretRef): Promise<PublishResult> {
    const endpoint = resolveSecret(endpointRef);
    const res = await fetchWithTimeout(fetch, endpoint, {
      method: "POST",
      // Idempotency-Key lets the endpoint dedupe a replay (the orchestrator's per-channel
      // ledger is the primary guard; this covers a crash between POST and ledger write).
      headers: { "content-type": "application/json", "idempotency-key": publishId(draft) },
      body: JSON.stringify({ channel, title: draft.title, body: draft.body, surface: draft.surface }),
    });
    if (!res.ok) {
      throw new Error(`publish to ${channel} failed: ${res.status}`);
    }
    const body = (await res.json().catch(() => ({}))) as { url?: string };
    return { url: body.url, target: "http" };
  }
}

function publishId(draft: ChannelDraft): string {
  const surface = draft.surface ?? "all";
  return `pub_${draft.channel}_${surface}_${slug(draft.title)}`;
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 40);
}

export function readPublished(stateDir: string): string[] {
  const dir = join(stateDir, "publicity", "published");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")).id as string);
}
