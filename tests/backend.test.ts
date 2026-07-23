import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateOrgConfig } from "../src/halyard/config/loader.js";
import { assertSupportedBackend } from "../src/halyard/config/backend.js";

const here = dirname(fileURLToPath(import.meta.url));
const orgRaw = parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8"));

describe("§D: backend honesty — only the git backend is implemented", () => {
  it("accepts the git backend", () => {
    expect(() => assertSupportedBackend(validateOrgConfig(orgRaw))).not.toThrow();
  });

  it("requires a service block when the service backend is selected", () => {
    expect(() => validateOrgConfig({ ...orgRaw, coordinator: { ...orgRaw.coordinator, backend: "service" } })).toThrow(/service config is required/);
  });
});
