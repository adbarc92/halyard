import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", ".."); // web/tests/helpers -> repo root

/** Create a temp Halyard project root with a valid org config + one app ("demo"). */
export function seedProject(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "halyard-web-"));
  cpSync(join(REPO, "halyard.config.yml"), join(root, "halyard.config.yml"));
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  cpSync(join(REPO, "scripts", "demo-app.yml"), join(root, "apps", "demo", "app.yml"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

/** A temp root with NO config — for the degraded-state path. */
export function seedEmptyRoot(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), "halyard-web-empty-")) };
}

/** Add another app dir under an existing project root (reuses the demo app config). */
export function addDemoApp(root: string, slug: string): void {
  mkdirSync(join(root, "apps", slug), { recursive: true });
  cpSync(join(REPO, "scripts", "demo-app.yml"), join(root, "apps", slug, "app.yml"));
}

/** Service-backend secret-ref name used by `seedProjectWithServiceBackend`. */
export const SERVICE_TOKEN_SECRET = "HALYARD_SERVICE_TOKEN";

/**
 * A temp project root configured for `coordinator.backend: service`.
 * The config is otherwise identical to the standard project, so all existing app fixtures work.
 * The `coordinator.service.api_key_ref` is `SECRET:HALYARD_SERVICE_TOKEN` — supply a value
 * via `setSecretStore` in your test to satisfy `makeBackend`'s token check.
 */
export function seedProjectWithServiceBackend(apiUrl: string): {
  root: string;
  stateDir: string;
  tokenSecretName: string;
} {
  const root = mkdtempSync(join(tmpdir(), "halyard-web-svc-"));
  const baseConfig = readFileSync(join(REPO, "halyard.config.yml"), "utf8");
  // Swap `backend: git` → `backend: service` and add the service block (indented 2-space, YAML).
  const withService = baseConfig
    .replace(/^  backend: git.*$/m, "  backend: service")
    .replace(/^  state_dir:.*$/m,
      `  state_dir: ./state\n  service:\n    api_url: ${apiUrl}\n    api_key_ref: SECRET:${SERVICE_TOKEN_SECRET}`);
  writeFileSync(join(root, "halyard.config.yml"), withService, "utf8");
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  cpSync(join(REPO, "scripts", "demo-app.yml"), join(root, "apps", "demo", "app.yml"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, tokenSecretName: SERVICE_TOKEN_SECRET };
}

/**
 * A temp project root whose single app declares `flags.api_url` (live flag provider configured).
 * Built from the demo app config with an `api_url` line injected under `flags:`, so the
 * Http-vs-File selection in project.ts can be exercised. Returns the secret-ref NAME the app's
 * `api_key_ref` points at, so a test can stock the secret store with a token.
 */
export function seedProjectWithFlagApi(apiUrl: string): {
  root: string;
  stateDir: string;
  tokenSecretName: string;
} {
  const root = mkdtempSync(join(tmpdir(), "halyard-web-api-"));
  cpSync(join(REPO, "halyard.config.yml"), join(root, "halyard.config.yml"));
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  const demoApp = readFileSync(join(REPO, "scripts", "demo-app.yml"), "utf8");
  // Inject `api_url` immediately under the `flags:` mapping key (sibling of provider/api_key_ref).
  const withApi = demoApp.replace(/^flags:\n/m, `flags:\n  api_url: ${apiUrl}\n`);
  writeFileSync(join(root, "apps", "demo", "app.yml"), withApi, "utf8");
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir, tokenSecretName: "DEMO_FLAG_PROVIDER_KEY" };
}
