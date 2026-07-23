import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateOrgConfig, validateAppConfig } from "../src/halyard/config/loader.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";
import { secretName } from "../src/halyard/config/secret-ref.js";
import { assessReadiness } from "../src/halyard/coordinator/preflight.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

const allSet = () => "x"; // every secret resolves
// A deep clone that lets us mutate the (frozen-by-convention) validated config for the cases
// that config-load would otherwise reject before assessReadiness ever sees them.
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

describe("preflight: deploy-provider readiness gate", () => {
  it("adds a required deploy:web item that is configured for a valid registered target", () => {
    // aurora's web deploy uses cloudflare_pages (registered + web-valid).
    const item = assessReadiness(app, org, allSet).items.find((i) => i.integration === "deploy:web");
    expect(item).toBeDefined();
    expect(item!.required).toBe(true);
    expect(item!.configured).toBe(true);
    expect(item!.detail).toMatch(/cloudflare_pages/);
  });

  it("gates readiness when a deploy target is unknown (not ready, configured:false)", () => {
    const bad = clone(app) as AppConfig;
    (bad.surfaces.web!.deploy as { target: string }).target = "definitely_not_a_target";
    const report = assessReadiness(bad, org, allSet);
    const item = report.items.find((i) => i.integration === "deploy:web")!;
    expect(item.configured).toBe(false);
    expect(item.detail).toMatch(/unknown deploy target/);
    expect(report.ready).toBe(false);
  });

  it("gates readiness when a deploy target is valid but for the wrong surface (cross-surface)", () => {
    // github_releases is desktop-only; using it on web must fail validation.
    const bad = clone(app) as AppConfig;
    (bad.surfaces.web!.deploy as { target: string }).target = "github_releases";
    const report = assessReadiness(bad, org, allSet);
    const item = report.items.find((i) => i.integration === "deploy:web")!;
    expect(item.configured).toBe(false);
    expect(item.detail).toMatch(/not valid for the web surface/);
    expect(report.ready).toBe(false);
  });

  it("adds a deploy:desktop item only when the desktop surface is enabled", () => {
    // aurora ships desktop disabled → no deploy:desktop row.
    expect(assessReadiness(app, org, allSet).items.find((i) => i.integration === "deploy:desktop")).toBeUndefined();

    // Enable it (its github_releases target is desktop-valid) → row present + configured.
    const withDesktop = clone(app) as AppConfig;
    withDesktop.surfaces.desktop!.enabled = true;
    const item = assessReadiness(withDesktop, org, allSet).items.find((i) => i.integration === "deploy:desktop");
    expect(item).toBeDefined();
    expect(item!.required).toBe(true);
    expect(item!.configured).toBe(true);
    expect(item!.detail).toMatch(/github_releases/);
  });

  it("drops the deploy:web item when web is disabled", () => {
    const noWeb = clone(app) as AppConfig;
    noWeb.surfaces.web!.enabled = false;
    // keep at least one surface enabled so the config stays coherent (ios is on).
    expect(assessReadiness(noWeb, org, allSet).items.find((i) => i.integration === "deploy:web")).toBeUndefined();
  });

  it("does NOT regress existing readiness logic: a missing required SECRET still blocks launch", () => {
    // Flags is a pre-existing required integration; drop its key and the app must be not-ready
    // even though the deploy:web provider item is perfectly configured.
    const missingFlagKey = (n: string) => (n === secretName(app.flags.api_key_ref) ? undefined : "x");
    const report = assessReadiness(app, org, missingFlagKey);
    expect(report.items.find((i) => i.integration === "flags")!.configured).toBe(false);
    expect(report.items.find((i) => i.integration === "deploy:web")!.configured).toBe(true);
    expect(report.ready).toBe(false);
  });

  it("leaves the pre-existing item set intact (only adds deploy:* rows)", () => {
    const integrations = assessReadiness(app, org, allSet).items.map((i) => i.integration);
    expect(integrations).toEqual(
      expect.arrayContaining([
        "approval-surface", "flags", "monitoring", "drafting",
        "payments", "ios-store", "android-store", "web-deploy", "deploy:web",
      ]),
    );
  });
});
