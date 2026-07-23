import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

// The real onboarded portfolio is private operator config: it lives in `apps.private/`
// (git-ignored) so the public repo never ships the app catalogue. This suite validates that
// portfolio when it is present locally, and is skipped entirely in a clean/public checkout
// where `apps.private/` does not exist. The shipped example app (`apps/aurora`) is validated
// by the rest of the suite and by config.test.ts.
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const appsDir = resolve(repoRoot, "apps.private");

/** Discover every apps.private/<slug>/app.yml (empty when the private portfolio isn't present). */
function discoverApps(): { slug: string; path: string }[] {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir)
    .map((entry) => ({ slug: entry, dir: resolve(appsDir, entry) }))
    .filter(({ dir }) => statSync(dir).isDirectory())
    .map(({ slug, dir }) => ({ slug, path: resolve(dir, "app.yml") }))
    .filter(({ path }) => {
      try {
        return statSync(path).isFile();
      } catch {
        return false;
      }
    });
}

const apps = discoverApps();

/** Load + validate every discovered app.yml once, keyed by slug. */
const loaded: { slug: string; config: AppConfig }[] = apps.map(({ slug, path }) => ({
  slug,
  config: validateAppConfig(parseYaml(readFileSync(path, "utf8")), path),
}));

const configsBySlug = new Map(loaded.map(({ slug, config }) => [slug, config]));

describe.skipIf(apps.length === 0)("Lane L9: every onboarded app.yml is schema- and registry-valid", () => {
  it("discovers at least the onboarded apps", () => {
    expect(apps.length).toBeGreaterThan(0);
  });

  // validateAppConfig runs the deploy-provider registry check via the schema's superRefine,
  // so a passing parse proves both schema validity AND a registry-valid deploy target/surface.
  for (const { slug, path } of apps) {
    it(`validates apps/${slug}/app.yml`, () => {
      expect(() => validateAppConfig(parseYaml(readFileSync(path, "utf8")), path)).not.toThrow();
    });
  }

  it("has all expected onboarded slugs present", () => {
    const expected = [
      "slot_sense",
      "portfolio",
      "elevation_broker",
      "pawsport",
      "audience",
      "robo_learn",
      "automation_kalshi",
      "tenzy",
      "giftkeeper",
      "hexy",
      "command_center",
      "topplicant",
    ];
    for (const slug of expected) {
      expect(configsBySlug.has(slug), `missing app: ${slug}`).toBe(true);
    }
  });

  it("covers every deploy provider in the matrix", () => {
    const webTargets = new Set<string>();
    const desktopTargets = new Set<string>();
    for (const { config } of loaded) {
      const web = config.surfaces.web;
      if (web) webTargets.add((web.deploy as { target: string }).target);
      const desktop = config.surfaces.desktop;
      if (desktop) desktopTargets.add((desktop.deploy as { target: string }).target);
    }
    for (const target of ["vercel", "fly", "github_pages", "aws", "command"]) {
      expect(webTargets.has(target), `no web app uses ${target}`).toBe(true);
    }
    for (const target of ["itch", "github_releases"]) {
      expect(desktopTargets.has(target), `no desktop app uses ${target}`).toBe(true);
    }
  });

  it("has at least one mobile app on the EAS toolchain", () => {
    const easApp = loaded.some(
      ({ config }) =>
        config.surfaces.ios?.toolchain === "eas" || config.surfaces.android?.toolchain === "eas",
    );
    expect(easApp).toBe(true);
  });

  it("has at least one desktop app with signing enabled", () => {
    const signed = loaded.some(({ config }) => config.surfaces.desktop?.signing?.enabled === true);
    expect(signed).toBe(true);
  });
});
