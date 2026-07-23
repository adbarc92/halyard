import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import {
  ConfigError,
  loadAppConfig,
  loadOrgConfig,
  validateAppConfig,
  validateOrgConfig,
} from "../src/halyard/config/loader.js";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const orgPath = resolve(repoRoot, "halyard.config.yml");
const appPath = resolve(repoRoot, "apps/aurora/app.yml");

describe("M0 verify: valid config round-trips", () => {
  it("loads and validates the sample org config", () => {
    const cfg = loadOrgConfig(orgPath);
    expect(cfg.org.name).toBe("Example");
    expect(cfg.coordinator.backend).toBe("git");
    expect(cfg.channels.blog?.class).toBe("owned");
    // SecretRef fields hold references, not values.
    expect(cfg.notifications.approval_channel_ref).toMatch(/^SECRET:/);
  });

  it("loads and validates the sample app config", () => {
    const cfg = loadAppConfig(appPath);
    expect(cfg.app.slug).toBe("aurora");
    expect(cfg.surfaces.ios?.enabled).toBe(true);
    expect(cfg.surfaces.desktop?.enabled).toBe(false);
  });

  it("round-trips: parsed YAML deep-equals the re-validated object", () => {
    // Validation should not mutate values that are already present (defaults aside).
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    const validated = validateOrgConfig(raw);
    expect(validated.org).toEqual(raw.org);
    expect(validated.channels).toEqual(raw.channels);
  });
});

describe("M0 verify: invalid config fails loudly with a useful message", () => {
  it("rejects a raw secret value where a SECRET: ref is required, naming the path", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.notifications.approval_channel_ref = "https://hooks.example.com/T00/B00/xyz";
    let caught: ConfigError | undefined;
    try {
      validateOrgConfig(raw, "halyard.config.yml");
    } catch (e) {
      caught = e as ConfigError;
    }
    expect(caught).toBeInstanceOf(ConfigError);
    expect(caught!.message).toContain("notifications.approval_channel_ref");
    expect(caught!.message).toContain("secret reference");
  });

  it("rejects an API-key-shaped value in a secret field", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.drafting.api_key_ref = "sk-ant-api03-DEADBEEF";
    expect(() => validateOrgConfig(raw)).toThrowError(/api_key_ref.*looks like an API key/s);
  });

  it("rejects a malformed cron expression, naming the field", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.coordinator.reconcile_cron = "*/20 * *"; // 3 fields, not 5
    expect(() => validateOrgConfig(raw)).toThrowError(/reconcile_cron.*cron/s);
  });

  it("rejects an unknown channel class", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.channels.blog.class = "semi_owned";
    expect(() => validateOrgConfig(raw)).toThrowError(/channels\.blog\.class/);
  });

  it("rejects a third_party channel that tries to auto-publish (invariant #5)", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.channels.x.gate = "auto";
    expect(() => validateOrgConfig(raw)).toThrowError(
      /channels\.x\.gate.*post button must stay a human action/s,
    );
  });

  it("rejects an unknown top-level key (strict schema)", () => {
    const raw = parseYaml(readFileSync(orgPath, "utf8"));
    raw.surprise = true;
    expect(() => validateOrgConfig(raw)).toThrowError(/surprise/);
  });

  it("rejects an app config with no enabled surface", () => {
    const raw = parseYaml(readFileSync(appPath, "utf8"));
    for (const s of Object.values(raw.surfaces) as Array<{ enabled: boolean }>) {
      s.enabled = false;
    }
    expect(() => validateAppConfig(raw)).toThrowError(/at least one surface must be enabled/);
  });
});
