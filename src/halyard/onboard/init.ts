import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import { validateAppConfig } from "../config/loader.js";
import { SlugSchema, type Surface } from "../config/primitives.js";
import { buildAppConfig, normalizeSurfaces, secretsForSurfaces } from "./template.js";

/**
 * `halyard app init` (a.k.a. `onboard`) — scaffold `apps/<slug>/app.yml` for a first-time
 * operator so they land a valid config without hand-copying `apps/aurora/app.yml` and pruning
 * surfaces. Prompts for app name + slug + which surfaces to enable, emits ONLY those surfaces
 * (each pre-filled with the right `SECRET:NAME` refs + `REPLACE_ME` markers), and refuses to
 * clobber an existing file without `--force`.
 *
 * The emitter is pure (template.ts); this module is the IO + validation seam. It NEVER prompts
 * for or writes a real secret value (invariant #4): the file holds references only.
 */

export interface OnboardOptions {
  name: string;
  slug: string;
  surfaces: Surface[];
  /** Root containing the per-app directories — `resolve("apps")` in production. */
  appsDir: string;
  /** Overwrite an existing apps/<slug>/app.yml. Off by default (non-clobbering). */
  force?: boolean;
}

export interface OnboardResult {
  /** Absolute path of the written file. */
  path: string;
  slug: string;
  surfaces: Surface[];
  /** Env var / secret NAMES the operator must set for the chosen surfaces (never values). */
  secrets: string[];
}

/** Build + validate + write apps/<slug>/app.yml. Returns the path and the secrets worklist. */
export function runOnboard(opts: OnboardOptions): OnboardResult {
  const slug = opts.slug.trim();
  // Validate the slug up front so a bad one fails here, not deep in schema validation.
  const slugCheck = SlugSchema.safeParse(slug);
  if (!slugCheck.success) {
    throw new Error(`invalid --slug '${slug}': ${slugCheck.error.issues[0]?.message ?? "must be a lowercase slug"}`);
  }
  const name = opts.name.trim();
  if (!name) throw new Error("missing app name (--name)");

  const surfaces = normalizeSurfaces(opts.surfaces);
  const path = resolve(opts.appsDir, slug, "app.yml");

  if (existsSync(path) && !opts.force) {
    throw new Error(`${path} already exists — refusing to overwrite without --force`);
  }

  // Build, then run it through the real validator so we can NEVER emit a file the loader
  // would reject (the schema is the contract). A REPLACE_ME marker in a non-secret field is
  // accepted by design; a SECRET ref in a secret field is required and present.
  const config = buildAppConfig({ name, slug, surfaces });
  validateAppConfig(config, path);

  const yaml =
    `# Scaffolded by \`halyard app init\` — replace every REPLACE_ME with a real identifier.\n` +
    `# Every credential is a SECRET:NAME reference; set the named secrets in your store (see below).\n` +
    stringifyYaml(config);

  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, yaml, "utf8");

  return { path, slug, surfaces, secrets: secretsForSurfaces(slug, surfaces) };
}
