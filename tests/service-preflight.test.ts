import { describe, expect, it } from "vitest";
import { assessReadiness } from "../src/halyard/coordinator/preflight.js";
import { loadOrgConfig, loadAppConfig } from "../src/halyard/config/loader.js";
import type { SecretRef } from "../src/halyard/config/secret-ref.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = loadAppConfig(resolve(here, "..", "apps", "aurora", "app.yml"));
const baseOrg = loadOrgConfig(resolve(here, "..", "halyard.config.yml"));

function serviceOrg() {
  return {
    ...baseOrg,
    coordinator: { ...baseOrg.coordinator, backend: "service" as const,
      service: { api_url: "https://svc", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" as SecretRef } },
  };
}
const resolves = (names: string[]) => (n: string) => (names.includes(n) ? "x" : undefined);

describe("preflight: coordinator-service", () => {
  it("adds a required coordinator-service item that is unconfigured when the token is absent", () => {
    const report = assessReadiness(app, serviceOrg(), resolves([]));
    const item = report.items.find((i) => i.integration === "coordinator-service");
    expect(item).toBeDefined();
    expect(item!.required).toBe(true);
    expect(item!.configured).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("is configured when the token resolves", () => {
    const report = assessReadiness(app, serviceOrg(), resolves(["HALYARD_SERVICE_TOKEN"]));
    expect(report.items.find((i) => i.integration === "coordinator-service")!.configured).toBe(true);
  });

  it("git backend has no coordinator-service item", () => {
    const report = assessReadiness(app, baseOrg, resolves([]));
    expect(report.items.find((i) => i.integration === "coordinator-service")).toBeUndefined();
  });
});
