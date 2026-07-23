import { describe, expect, it } from "vitest";
import { OrgConfigSchema } from "../src/halyard/config/org-config.schema.js";

const base = {
  version: 1,
  org: { name: "Acme" },
  notifications: { approval_channel_ref: "SECRET:APPROVAL" },
  drafting: { provider: "anthropic", model: "claude-x", api_key_ref: "SECRET:ANTHROPIC", voice_canon: "canon" },
  channels: {},
  defaults: { announce_policy: "per_surface" },
};
const git = (extra = {}) => ({ ...base, coordinator: { backend: "git", state_dir: "state", reconcile_cron: "*/20 * * * *", ...extra } });
const service = (extra = {}) => ({ ...base, coordinator: { backend: "service", state_dir: "state", reconcile_cron: "*/20 * * * *", ...extra } });

describe("coordinator.service schema", () => {
  it("accepts a service backend with a service block", () => {
    expect(() => OrgConfigSchema.parse(service({ service: { api_url: "https://h.example.com/api", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" } }))).not.toThrow();
  });
  it("rejects backend: service WITHOUT a service block", () => {
    expect(() => OrgConfigSchema.parse(service())).toThrow(/service config is required/);
  });
  it("rejects backend: git WITH a service block", () => {
    expect(() => OrgConfigSchema.parse(git({ service: { api_url: "https://h.example.com/api", api_key_ref: "SECRET:X" } }))).toThrow(/not allowed/);
  });
  it("still accepts a plain git backend", () => {
    expect(() => OrgConfigSchema.parse(git())).not.toThrow();
  });
});
