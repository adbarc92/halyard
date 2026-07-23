import { createConsoleService, type ConsoleService } from "./console-service.js";
import { resolveRoot } from "./project.js";

let cached: ConsoleService | null = null;

/** The process-wide console service, bound to the resolved root. */
export function service(): ConsoleService {
  if (!cached) cached = createConsoleService({ root: resolveRoot() });
  return cached;
}
