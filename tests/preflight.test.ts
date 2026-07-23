import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import { secretName } from "../src/halyard/config/secret-ref.js";
import { assessReadiness } from "../src/halyard/coordinator/preflight.js";
import { dispatch } from "../src/halyard/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

const allSet = () => "x"; // every secret resolves

describe("assessReadiness (pure)", () => {
  it("is ready when every required integration is configured", () => {
    const r = assessReadiness(app, org, allSet);
    expect(r.ready).toBe(true);
    const integrations = r.items.map((i) => i.integration);
    // aurora enables ios + android + web and declares payments → all rows present.
    expect(integrations).toEqual(
      expect.arrayContaining(["approval-surface", "flags", "monitoring", "drafting", "payments", "ios-store", "android-store", "web-deploy"]),
    );
  });

  it("is NOT ready when a required secret is missing", () => {
    const missingFlagKey = (n: string) => (n === secretName(app.flags.api_key_ref) ? undefined : "x");
    const r = assessReadiness(app, org, missingFlagKey);
    expect(r.ready).toBe(false);
    expect(r.items.find((i) => i.integration === "flags")!.configured).toBe(false);
  });

  it("stays ready when only an OPTIONAL integration (drafting) is missing", () => {
    const noDrafting = (n: string) => (n === secretName(org.drafting.api_key_ref) ? undefined : "x");
    const r = assessReadiness(app, org, noDrafting);
    expect(r.ready).toBe(true);
    const drafting = r.items.find((i) => i.integration === "drafting")!;
    expect(drafting.required).toBe(false);
    expect(drafting.configured).toBe(false);
  });

  it("flags need api_url too, not just the key", () => {
    const noUrl = validateAppConfig({ ...JSON.parse(JSON.stringify(rawApp())), flags: { ...rawApp().flags, api_url: undefined } });
    const flagsItem = assessReadiness(noUrl, org, allSet).items.find((i) => i.integration === "flags")!;
    expect(flagsItem.configured).toBe(false);
    expect(flagsItem.detail).toMatch(/api_url/);
  });

  it("omits surface rows that aren't enabled", () => {
    const webOnly = JSON.parse(JSON.stringify(rawApp()));
    webOnly.surfaces.ios.enabled = false;
    webOnly.surfaces.android.enabled = false;
    const integrations = assessReadiness(validateAppConfig(webOnly), org, allSet).items.map((i) => i.integration);
    expect(integrations).not.toContain("ios-store");
    expect(integrations).not.toContain("android-store");
    expect(integrations).toContain("web-deploy");
  });

  it("ios-store checks the real ASC trio + match repo, not the decorative asc_api_key_ref", () => {
    // Everything resolves EXCEPT a secret literally named ASC_API_KEY — ios-store must still
    // be configured (nothing reads ASC_API_KEY; the trio + match repo are what's consumed).
    const noPhantom = (n: string) => (n === "ASC_API_KEY" ? undefined : "x");
    expect(assessReadiness(app, org, noPhantom).items.find((i) => i.integration === "ios-store")!.configured).toBe(true);
    // Missing one of the real trio → not configured.
    const noKeyId = (n: string) => (n === "ASC_KEY_ID" ? undefined : "x");
    expect(assessReadiness(app, org, noKeyId).items.find((i) => i.integration === "ios-store")!.configured).toBe(false);
  });
});

function rawApp(): Record<string, any> {
  return parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8"));
}

describe("halyard preflight (CLI, config-only)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => { logSpy = vi.spyOn(console, "log").mockImplementation(() => {}); });
  afterEach(() => { logSpy.mockRestore(); });

  it("exits 1 when required integrations are unconfigured (no secrets in env)", async () => {
    expect(await dispatch(["preflight", "--apps", "aurora", "--probe", "off"])).toBe(1);
  });
});
