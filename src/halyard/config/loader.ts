import { readFileSync } from "node:fs";
import { parse as parseYaml } from "yaml";
import type { z } from "zod";
import { AppConfigSchema, type AppConfig } from "./app-config.schema.js";
import { OrgConfigSchema, type OrgConfig } from "./org-config.schema.js";

/**
 * Config loader + validation (M0). Reads YAML, validates against the Zod schema,
 * and on failure throws a `ConfigError` whose message names the offending path —
 * "invalid config fails loudly with a useful message" (§8/M0 verify).
 */

export class ConfigError extends Error {
  constructor(
    message: string,
    readonly source: string,
    readonly issues: z.ZodIssue[] = [],
  ) {
    super(message);
    this.name = "ConfigError";
  }
}

function formatZodError(source: string, error: z.ZodError): ConfigError {
  const lines = error.issues.map((issue) => {
    const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
    return `  • ${path}: ${issue.message}`;
  });
  const message = `Invalid config in ${source}:\n${lines.join("\n")}`;
  return new ConfigError(message, source, error.issues);
}

function parseYamlOrThrow(text: string, source: string): unknown {
  try {
    return parseYaml(text);
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not parse YAML in ${source}: ${reason}`, source);
  }
}

function readOrThrow(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    throw new ConfigError(`Could not read config file ${path}: ${reason}`, path);
  }
}

/** Validate already-parsed data (useful in tests) against the org schema. */
export function validateOrgConfig(data: unknown, source = "<org config>"): OrgConfig {
  const result = OrgConfigSchema.safeParse(data);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

/** Validate already-parsed data against the per-app schema. */
export function validateAppConfig(data: unknown, source = "<app config>"): AppConfig {
  const result = AppConfigSchema.safeParse(data);
  if (!result.success) throw formatZodError(source, result.error);
  return result.data;
}

export function loadOrgConfig(path: string): OrgConfig {
  const data = parseYamlOrThrow(readOrThrow(path), path);
  return validateOrgConfig(data, path);
}

export function loadAppConfig(path: string): AppConfig {
  const data = parseYamlOrThrow(readOrThrow(path), path);
  return validateAppConfig(data, path);
}
