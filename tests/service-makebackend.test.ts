import { describe, expect, it, afterEach } from "vitest";
import { makeBackend } from "../src/halyard/config/backend.js";
import { setSecretStore, envSecretStore } from "../src/halyard/secrets/resolve.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";
import type { OrgConfig } from "../src/halyard/config/org-config.schema.js";

afterEach(() => setSecretStore(envSecretStore));

function orgService(): OrgConfig {
  return {
    version: 1, org: { name: "Acme" },
    coordinator: { backend: "service", state_dir: "state", reconcile_cron: "*/20 * * * *", dedup: true,
      service: { api_url: "https://svc", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" } },
    notifications: { approval_channel_ref: "SECRET:APPROVAL" },
    drafting: { provider: "anthropic", model: "m", api_key_ref: "SECRET:ANTHROPIC", voice_canon: "canon" },
    channels: {}, defaults: { announce_policy: "per_surface" },
  } as OrgConfig;
}

describe("makeBackend — service branch", () => {
  it("constructs a service backend when the token resolves", async () => {
    setSecretStore({ get: (n) => (n === "HALYARD_SERVICE_TOKEN" ? "tok" : undefined) });
    const { fetchFn } = makeFakeServiceFetch();
    const backend = makeBackend(orgService(), { stateDir: "ignored", fetchFn });
    // Reaches the fake service (no throw, empty scan).
    expect(await backend.records.scanIds()).toEqual([]);
  });

  it("hard-fails when the service token is unresolvable (no git fallback)", () => {
    setSecretStore({ get: () => undefined });
    expect(() => makeBackend(orgService(), { stateDir: "ignored" })).toThrow(/HALYARD_SERVICE_TOKEN/);
  });
});
