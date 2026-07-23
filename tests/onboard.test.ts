import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildAppConfig, normalizeSurfaces, secretsForSurfaces, REPLACE_ME } from "../src/halyard/onboard/template.js";
import { runOnboard } from "../src/halyard/onboard/init.js";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { isSecretRef } from "../src/halyard/config/secret-ref.js";
import { dispatch } from "../src/halyard/cli.js";

/** Walk every string in the config and collect those that are SECRET: refs / REPLACE_ME. */
function strings(obj: unknown, acc: string[] = []): string[] {
  if (typeof obj === "string") acc.push(obj);
  else if (Array.isArray(obj)) for (const v of obj) strings(v, acc);
  else if (obj && typeof obj === "object") for (const v of Object.values(obj)) strings(v, acc);
  return acc;
}

describe("onboard template emitter (pure)", () => {
  it("emits ONLY the chosen surfaces", () => {
    const cfg = buildAppConfig({ name: "Borealis", slug: "borealis", surfaces: ["web"] });
    const surfaces = cfg.surfaces as Record<string, unknown>;
    expect(Object.keys(surfaces)).toEqual(["web"]);
    expect(surfaces.ios).toBeUndefined();
    expect(surfaces.android).toBeUndefined();
    expect(surfaces.desktop).toBeUndefined();
  });

  it("the emitted config validates against the real app schema", () => {
    const cfg = buildAppConfig({ name: "Borealis", slug: "borealis", surfaces: ["ios", "android", "web", "desktop"] });
    expect(() => validateAppConfig(cfg)).not.toThrow();
  });

  it("carries NO real credential literals — only SECRET refs and REPLACE_ME markers", () => {
    const cfg = buildAppConfig({ name: "Borealis", slug: "borealis", surfaces: ["ios", "android", "web", "desktop"] });
    // No value-shaped leak: no sk-, ghp_, PEM, base64 blob. Anything that COULD be a secret is a ref.
    for (const s of strings(cfg)) {
      expect(s).not.toMatch(/^sk-/i);
      expect(s).not.toMatch(/^ghp_|^github_pat_/i);
      expect(s).not.toMatch(/^-----BEGIN/);
    }
    // The app-derived secret refs are real SECRET: references.
    const flags = cfg.flags as Record<string, unknown>;
    expect(isSecretRef(flags.api_key_ref)).toBe(true);
    const triage = cfg.triage as Record<string, Record<string, unknown>>;
    expect(isSecretRef(triage.sentry!.project_ref)).toBe(true);
  });

  it("pre-fills operator identifiers (iOS bundle_id/asc_app_id/team_id) with REPLACE_ME", () => {
    const cfg = buildAppConfig({ name: "Borealis", slug: "borealis", surfaces: ["ios"] });
    const ios = (cfg.surfaces as Record<string, Record<string, unknown>>).ios!;
    expect(ios.bundle_id).toBe(REPLACE_ME);
    expect(ios.asc_app_id).toBe(REPLACE_ME);
    expect(ios.team_id).toBe(REPLACE_ME);
    // …but signing identities stay SECRET refs, never REPLACE_ME.
    const signing = ios.signing as Record<string, unknown>;
    expect(isSecretRef(signing.match_repo_ref)).toBe(true);
  });

  it("derives per-app flag/sentry secret names from the slug", () => {
    const cfg = buildAppConfig({ name: "Borealis", slug: "borealis", surfaces: ["web"] });
    expect((cfg.flags as Record<string, unknown>).api_key_ref).toBe("SECRET:BOREALIS_FLAG_PROVIDER_KEY");
    expect((cfg.triage as Record<string, Record<string, unknown>>).sentry!.project_ref).toBe("SECRET:BOREALIS_SENTRY_DSN");
  });

  it("normalizeSurfaces dedupes, orders canonically, and rejects junk", () => {
    expect(normalizeSurfaces(["web", "ios", "web"])).toEqual(["ios", "web"]);
    expect(() => normalizeSurfaces([])).toThrow(/at least one surface/);
    expect(() => normalizeSurfaces(["smartfridge"])).toThrow(/unknown surface/);
  });

  it("secretsForSurfaces lists the right env vars per chosen surface", () => {
    const ios = secretsForSurfaces("borealis", ["ios"]);
    expect(ios).toEqual(expect.arrayContaining(["BOREALIS_FLAG_PROVIDER_KEY", "ASC_KEY_ID", "MATCH_REPO"]));
    expect(ios).not.toContain("CLOUDFLARE_API_TOKEN");
    const web = secretsForSurfaces("borealis", ["web"]);
    expect(web).toEqual(expect.arrayContaining(["CLOUDFLARE_API_TOKEN", "CLOUDFLARE_ACCOUNT_ID"]));
    expect(web).not.toContain("ASC_KEY_ID");
  });
});

describe("runOnboard (write + guards)", () => {
  let appsDir: string;
  beforeEach(() => { appsDir = mkdtempSync(join(tmpdir(), "halyard-onboard-")); });
  afterEach(() => { rmSync(appsDir, { recursive: true, force: true }); });

  it("writes apps/<slug>/app.yml that loads back through validateAppConfig", () => {
    const r = runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["ios", "web"], appsDir });
    expect(r.path).toBe(resolve(appsDir, "borealis", "app.yml"));
    const written = parseYaml(readFileSync(r.path, "utf8"));
    expect(() => validateAppConfig(written)).not.toThrow();
    expect(Object.keys((written as Record<string, Record<string, unknown>>).surfaces!)).toEqual(["ios", "web"]);
  });

  it("refuses to overwrite an existing file without --force", () => {
    runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["web"], appsDir });
    expect(() => runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["web"], appsDir })).toThrow(/refusing to overwrite/);
  });

  it("overwrites with --force", () => {
    runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["web"], appsDir });
    expect(() => runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["ios"], appsDir, force: true })).not.toThrow();
    const written = parseYaml(readFileSync(resolve(appsDir, "borealis", "app.yml"), "utf8"));
    expect(Object.keys((written as Record<string, Record<string, unknown>>).surfaces!)).toEqual(["ios"]);
  });

  it("rejects a non-slug slug loudly", () => {
    expect(() => runOnboard({ name: "Borealis", slug: "Bad-Slug", surfaces: ["web"], appsDir })).toThrow(/invalid --slug/);
  });

  it("the written file contains NO real-credential literals (only SECRET: refs + REPLACE_ME)", () => {
    const r = runOnboard({ name: "Borealis", slug: "borealis", surfaces: ["ios", "android", "web", "desktop"], appsDir });
    const raw = readFileSync(r.path, "utf8");
    expect(raw).not.toMatch(/sk-[A-Za-z0-9]/);
    expect(raw).not.toMatch(/ghp_|github_pat_/);
    expect(raw).not.toMatch(/-----BEGIN/);
    // Sanity: it DOES contain the references + markers.
    expect(raw).toContain("SECRET:BOREALIS_FLAG_PROVIDER_KEY");
    expect(raw).toContain("REPLACE_ME");
  });
});

describe("halyard app init / onboard (CLI)", () => {
  let appsDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    appsDir = mkdtempSync(join(tmpdir(), "halyard-onboardcli-"));
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { rmSync(appsDir, { recursive: true, force: true }); logSpy.mockRestore(); errSpy.mockRestore(); });

  it("scaffolds via flags (no TTY) and exits 0", async () => {
    const code = await dispatch(["app", "init", "--name", "Borealis", "--slug", "borealis", "--surfaces", "web", "--apps-dir", appsDir]);
    expect(code).toBe(0);
    expect(existsSync(resolve(appsDir, "borealis", "app.yml"))).toBe(true);
  });

  it("the `onboard` alias works the same way", async () => {
    const code = await dispatch(["onboard", "--name", "Aurora2", "--slug", "aurora2", "--surfaces", "ios,web", "--apps-dir", appsDir]);
    expect(code).toBe(0);
    const written = parseYaml(readFileSync(resolve(appsDir, "aurora2", "app.yml"), "utf8"));
    expect(Object.keys((written as Record<string, Record<string, unknown>>).surfaces!)).toEqual(["ios", "web"]);
  });

  it("prints the secrets worklist for the chosen surfaces", async () => {
    const lines: string[] = [];
    logSpy.mockImplementation((m?: unknown) => { lines.push(String(m)); });
    await dispatch(["app", "init", "--name", "Borealis", "--slug", "borealis", "--surfaces", "ios", "--apps-dir", appsDir]);
    const out = JSON.parse(lines.join("\n"));
    expect(out.secrets).toEqual(expect.arrayContaining(["ASC_KEY_ID", "BOREALIS_FLAG_PROVIDER_KEY"]));
  });

  it("an unknown `app` subcommand prints usage and returns 2", async () => {
    expect(await dispatch(["app", "wat"])).toBe(2);
  });

  it("the scaffolded config is accepted by `halyard preflight --probe off` once its secrets are set", async () => {
    await dispatch(["app", "init", "--name", "Borealis", "--slug", "borealis", "--surfaces", "web", "--apps-dir", appsDir]);
    // preflight resolves apps from resolve("apps"), so run it against a project root whose
    // apps/ IS our temp dir. Set the required secrets so a *valid* config reports ready (exit 0).
    const projectRoot = mkdtempSync(join(tmpdir(), "halyard-proj-"));
    mkdirSync(join(projectRoot, "apps", "borealis"), { recursive: true });
    writeFileSync(
      join(projectRoot, "apps", "borealis", "app.yml"),
      readFileSync(resolve(appsDir, "borealis", "app.yml"), "utf8"),
      "utf8",
    );
    // Point flags at a real-looking provider so the flags row is "configured" config-side.
    const text = readFileSync(join(projectRoot, "apps", "borealis", "app.yml"), "utf8")
      .replace("api_key_ref:", "api_url: https://flags.example.com\n  api_key_ref:");
    writeFileSync(join(projectRoot, "apps", "borealis", "app.yml"), text, "utf8");

    const prevCwd = process.cwd();
    const prevEnv = { ...process.env };
    try {
      process.chdir(projectRoot);
      // Copy the org config into the temp project root so loadOrgConfig finds it.
      writeFileSync(join(projectRoot, "halyard.config.yml"), readFileSync(resolve(prevCwd, "halyard.config.yml"), "utf8"), "utf8");
      // Provide every required secret in env (config-only readiness, --probe off).
      process.env.HALYARD_APPROVAL_WEBHOOK = "x";
      process.env.ANTHROPIC_API_KEY = "x";
      process.env.SENTRY_AUTH_TOKEN = "x";
      process.env.BOREALIS_FLAG_PROVIDER_KEY = "x";
      process.env.BOREALIS_SENTRY_DSN = "x";
      process.env.CLOUDFLARE_API_TOKEN = "x";
      process.env.CLOUDFLARE_ACCOUNT_ID = "x";
      const code = await dispatch(["preflight", "--apps", "borealis", "--probe", "off"]);
      expect(code).toBe(0);
    } finally {
      process.chdir(prevCwd);
      process.env = prevEnv;
      rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
