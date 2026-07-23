// Halyard public surface. Grows per milestone.

// Config (M0)
export * from "./config/loader.js";
export { discoverAppSlugs } from "./config/discover.js";
export { assertSupportedBackend, makeBackend } from "./config/backend.js";
export * from "./config/org-config.schema.js";
export * from "./config/app-config.schema.js";
export * from "./config/secret-ref.js";
export * from "./config/primitives.js";

// Contracts (M0)
export * from "./contracts/state.js";
export * from "./contracts/launch.schema.js";
export * from "./contracts/release.schema.js";

// Surfaces + coordinator (M1)
export * from "./surfaces/index.js";
export * from "./coordinator/gates.js";
export * from "./coordinator/record-store.js";
export * from "./coordinator/release-runner.js";

// Persistence ports + git backend (R3 Phase 0)
export * from "./coordinator/ports.js";
export { makeGitBackend } from "./coordinator/git-backend.js";

// Service backend (R3 Phase 1)
export { makeServiceBackend, ServiceHttpClient, ServiceHttpError } from "./coordinator/service/index.js";
export type { ServiceHttpClientOptions } from "./coordinator/service/index.js";

// Coordinator engine (M2)
export { collectChangelog } from "./coordinator/changelog.js";
export * from "./coordinator/state-machine.js";
export * from "./coordinator/reconcile.js";
export * from "./coordinator/status.js";
export * from "./coordinator/preflight.js";
export { buildReconcileSources } from "./coordinator/sources/index.js";

// iOS + review poll (M3)
export * from "./coordinator/sources/asc-review.js";
export { LiveAscClient } from "./coordinator/sources/asc-client.js";

// Launch/release split + flag lifecycle (M4)
export * from "./contracts/proposal.schema.js";
export * from "./flags/index.js";
export * from "./coordinator/launch-store.js";
export * from "./coordinator/proposals.js";
export * from "./coordinator/graduation.js";
export { flagPollSource } from "./coordinator/sources/flag-poll.js";

// Publicity fan-out + approval surface (M5)
export * from "./publicity/index.js";
export {
  resolveSecret,
  tryResolveSecret,
  setSecretStore,
  envSecretStore,
  type SecretStore,
} from "./secrets/resolve.js";

// Agents: triage + rejection (M6)
export * from "./agents/index.js";

// Maintenance event sources (M7)
export * from "./maintenance/index.js";

// Payment processing (third-party integration, behind a port)
export * from "./payments/index.js";

// Open-core licensing / entitlements
export * from "./licensing/index.js";

// Voice-canon feedback loop (M8)
export { buildDraftPrompts } from "./publicity/draft-prompt.js";
export { appendToCanon, canonEntryPath } from "./publicity/canon-store.js";
export { approveProposal } from "./coordinator/approve.js";

// Full reconcile orchestration (F1)
export { runFullReconcile, triageAllApps, type FullReconcileReport } from "./orchestration/full-reconcile.js";
