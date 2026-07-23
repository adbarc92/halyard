import type { OrgConfig } from "./org-config.schema.js";
import { secretName } from "./secret-ref.js";
import { tryResolveSecret } from "../secrets/resolve.js";
import { makeGitBackend } from "../coordinator/git-backend.js";
import { makeServiceBackend } from "../coordinator/service/index.js";
import type { Backend } from "../coordinator/ports.js";

/**
 * `coordinator.backend` is `git | service`; both are implemented. Kept as a guard so an
 * out-of-enum value (should be impossible post-validation) still fails loudly.
 */
export function assertSupportedBackend(org: OrgConfig): void {
  if (org.coordinator.backend !== "git" && org.coordinator.backend !== "service") {
    throw new Error(`coordinator.backend "${org.coordinator.backend}" is not implemented`);
  }
}

/**
 * The single decision point for persistence: select the adapter set from `coordinator.backend`.
 *   - `git`     → filesystem adapters under `stateDir`/`canonDir`.
 *   - `service` → HTTP adapters against `coordinator.service.api_url`, bearer-authed with the
 *     `api_key_ref` token resolved at runtime. HARD-FAILS if the block/token is missing — a remote
 *     store cannot do anything (even reads) without its token, and there is NO git fallback. `fetchFn`
 *     is an optional test seam.
 */
export function makeBackend(
  org: OrgConfig,
  opts: { stateDir: string; canonDir?: string; fetchFn?: typeof fetch },
): Backend {
  assertSupportedBackend(org);
  if (org.coordinator.backend === "service") {
    const svc = org.coordinator.service;
    if (!svc) throw new Error('coordinator.backend "service" requires a coordinator.service block');
    const token = tryResolveSecret(svc.api_key_ref);
    if (!token) {
      throw new Error(`coordinator.service token ${secretName(svc.api_key_ref)} is not set — the service backend requires it (no git fallback)`);
    }
    return makeServiceBackend({ baseUrl: svc.api_url, token, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
  }
  return makeGitBackend(opts);
}
