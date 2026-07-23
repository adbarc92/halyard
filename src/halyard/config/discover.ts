import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Discover app slugs from the `apps/` tree — any `apps/<slug>/app.yml`. Used when the
 * CLI is invoked without `--apps`, so the scheduled loops scan every configured app
 * instead of silently scanning none (a `--app` typo previously reconciled nothing and
 * still exited 0).
 */
export function discoverAppSlugs(appsDir: string): string[] {
  if (!existsSync(appsDir)) return [];
  return readdirSync(appsDir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && existsSync(join(appsDir, d.name, "app.yml")))
    .map((d) => d.name)
    .sort();
}
