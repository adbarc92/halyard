/**
 * Tests for src/halyard/publicity/select.ts
 *
 * Mirrors the shape of web/tests/flag-client-select.test.ts (the template):
 * - Uses setSecretStore / envSecretStore to inject faked credentials.
 * - Never asserts on token values.
 * - Verifies each factory falls through to the offline default when any
 *   required piece is absent (url, token, entitlement).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setSecretStore, envSecretStore } from "../src/halyard/secrets/resolve.js";
import { makePublisher, makeNotifier, makeDrafter } from "../src/halyard/publicity/select.js";
import { FilePublisher, HttpPublisher } from "../src/halyard/publicity/publishers.js";
import { FileNotifier, WebhookNotifier } from "../src/halyard/publicity/notify.js";
import { TemplateDrafter } from "../src/halyard/publicity/template-drafter.js";
import { AnthropicDrafter } from "../src/halyard/publicity/anthropic-drafter.js";
import { resetEntitlement, setEntitlement, makeEntitlement } from "../src/halyard/licensing/index.js";
import type { OrgConfig } from "../src/halyard/config/org-config.schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let stateDir = "";
const now = () => "2026-01-01T00:00:00.000Z";

// Build a minimal valid OrgConfig without going through YAML parsing.
// We cast through `unknown` once here so test bodies stay readable.
function makeOrg(
  channels: Record<string, unknown>,
  approvalRef = "SECRET:HALYARD_APPROVAL_WEBHOOK",
  apiKeyRef = "SECRET:ANTHROPIC_API_KEY",
): OrgConfig {
  return {
    version: 1,
    org: { name: "TestOrg" },
    coordinator: {
      backend: "git",
      state_dir: "./state",
      reconcile_cron: "*/20 * * * *",
      dedup: true,
    },
    notifications: {
      approval_channel_ref: approvalRef as OrgConfig["notifications"]["approval_channel_ref"],
    },
    drafting: {
      provider: "anthropic",
      model: "claude-opus-4-8",
      api_key_ref: apiKeyRef as OrgConfig["drafting"]["api_key_ref"],
      voice_canon: "./canon/voice/",
    },
    channels: channels as OrgConfig["channels"],
    defaults: { announce_policy: "per_surface" },
  };
}

/** An org whose channels include one owned http publish channel. */
function orgWithHttpChannel(): OrgConfig {
  return makeOrg({
    blog: {
      class: "owned",
      gate: "auto",
      publish: { type: "http", endpoint_ref: "SECRET:BLOG_PUBLISH_URL" },
    },
  });
}

/** An org with only manual (third-party, human-gated) channels. */
function orgWithManualChannels(): OrgConfig {
  return makeOrg({
    x: { class: "third_party", gate: "human", publish: { type: "manual" } },
    linkedin: { class: "third_party", gate: "human", publish: { type: "manual" } },
  });
}

/** An org with no channels at all. */
function orgEmpty(): OrgConfig {
  return makeOrg({});
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

afterEach(() => {
  setSecretStore(envSecretStore);
  resetEntitlement();
  delete process.env.HALYARD_LIVE_PUBLISH;
  if (stateDir) {
    rmSync(stateDir, { recursive: true, force: true });
    stateDir = "";
  }
});

// ---------------------------------------------------------------------------
// makePublisher
// ---------------------------------------------------------------------------

describe("makePublisher", () => {
  it("returns FilePublisher when no channels are configured", () => {
    setSecretStore({ get: () => undefined });
    const p = makePublisher(orgEmpty(), "/tmp/state", now);
    expect(p).toBeInstanceOf(FilePublisher);
  });

  it("returns FilePublisher when all channels are manual (no http targets)", () => {
    setSecretStore({ get: () => undefined });
    const p = makePublisher(orgWithManualChannels(), "/tmp/state", now);
    expect(p).toBeInstanceOf(FilePublisher);
  });

  it("returns FilePublisher when an http channel exists but the endpoint token does not resolve", () => {
    setSecretStore({ get: () => undefined }); // token absent → fall through
    const p = makePublisher(orgWithHttpChannel(), "/tmp/state", now);
    expect(p).toBeInstanceOf(FilePublisher);
  });

  it("returns HttpPublisher when an enabled http channel has a resolvable endpoint_ref", () => {
    stateDir = mkdtempSync(join(tmpdir(), "halyard-pub-sel-"));
    setSecretStore({ get: (n) => (n === "BLOG_PUBLISH_URL" ? "https://cms.example.com/publish" : undefined) });
    const p = makePublisher(orgWithHttpChannel(), stateDir, now);
    expect(p).toBeInstanceOf(HttpPublisher);
  });

  it("HALYARD_LIVE_PUBLISH=1 forces HttpPublisher regardless of channel config (back-compat override)", () => {
    stateDir = mkdtempSync(join(tmpdir(), "halyard-pub-sel-"));
    process.env.HALYARD_LIVE_PUBLISH = "1";
    setSecretStore({ get: () => undefined }); // no tokens needed — env override wins
    const p = makePublisher(orgEmpty(), stateDir, now);
    expect(p).toBeInstanceOf(HttpPublisher);
  });

  it("returns HttpPublisher when org has multiple channels and at least one http resolves", () => {
    stateDir = mkdtempSync(join(tmpdir(), "halyard-pub-sel-"));
    const org = makeOrg({
      x: { class: "third_party", gate: "human", publish: { type: "manual" } },
      blog: { class: "owned", gate: "auto", publish: { type: "http", endpoint_ref: "SECRET:BLOG_PUBLISH_URL" } },
      newsletter: { class: "owned", gate: "auto", publish: { type: "http", endpoint_ref: "SECRET:EMAIL_SEND_URL" } },
    });
    // Only the first http token resolves; that is enough.
    setSecretStore({ get: (n) => (n === "BLOG_PUBLISH_URL" ? "https://cms.example.com" : undefined) });
    const p = makePublisher(org, stateDir, now);
    expect(p).toBeInstanceOf(HttpPublisher);
  });
});

// ---------------------------------------------------------------------------
// makeNotifier
// ---------------------------------------------------------------------------

describe("makeNotifier", () => {
  beforeEach(() => {
    stateDir = mkdtempSync(join(tmpdir(), "halyard-notif-sel-"));
  });

  it("returns FileNotifier when the approval_channel_ref token does not resolve", () => {
    setSecretStore({ get: () => undefined });
    const n = makeNotifier(orgEmpty(), stateDir, now);
    expect(n).toBeInstanceOf(FileNotifier);
  });

  it("returns WebhookNotifier when the approval_channel_ref token resolves", () => {
    setSecretStore({ get: (n) => (n === "HALYARD_APPROVAL_WEBHOOK" ? "https://hook.example.com" : undefined) });
    const notifier = makeNotifier(orgEmpty(), stateDir, now);
    expect(notifier).toBeInstanceOf(WebhookNotifier);
  });
});

// ---------------------------------------------------------------------------
// makeDrafter
// ---------------------------------------------------------------------------

describe("makeDrafter", () => {
  it("returns TemplateDrafter when the api_key_ref token does not resolve", () => {
    setSecretStore({ get: () => undefined });
    const d = makeDrafter(orgEmpty());
    expect(d).toBeInstanceOf(TemplateDrafter);
  });

  it("returns TemplateDrafter when the api key resolves but ai-agents entitlement is absent (free tier)", () => {
    setSecretStore({ get: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) });
    setEntitlement(makeEntitlement({ tier: "free", licensee: null, features: [], expiresAt: null }));
    const d = makeDrafter(orgEmpty());
    expect(d).toBeInstanceOf(TemplateDrafter);
  });

  it("returns AnthropicDrafter when the api key resolves AND ai-agents is entitled", () => {
    setSecretStore({ get: (n) => (n === "ANTHROPIC_API_KEY" ? "sk-test" : undefined) });
    setEntitlement(makeEntitlement({ tier: "pro", licensee: "test", features: ["ai-agents"], expiresAt: null }));
    const d = makeDrafter(orgEmpty());
    expect(d).toBeInstanceOf(AnthropicDrafter);
  });
});

// ---------------------------------------------------------------------------
// Barrel re-export (verifies the library export is wired)
// ---------------------------------------------------------------------------

describe("barrel re-export", () => {
  it("makePublisher / makeNotifier / makeDrafter are re-exported from halyard", async () => {
    const mod = await import("../src/halyard/index.js");
    const barrel = mod as Record<string, unknown>;
    expect(typeof barrel["makePublisher"]).toBe("function");
    expect(typeof barrel["makeNotifier"]).toBe("function");
    expect(typeof barrel["makeDrafter"]).toBe("function");
  });
});
