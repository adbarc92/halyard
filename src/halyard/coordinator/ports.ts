import type { Release } from "../contracts/release.schema.js";
import type { Launch } from "../contracts/launch.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import type { CanonEntry } from "../publicity/canon-store.js";

/**
 * Persistence ports (R3, Phase 0). Each store family is an async interface so a non-git
 * `service` backend can implement it without a second caller rewrite. The git adapters
 * (`coordinator/git-backend.ts`) are the default; `config/backend.ts` selects the adapter
 * set from `coordinator.backend`.
 *
 * **Ports hold I/O only.** The pure transforms that compute records —
 * `appendTransition`/`newRelease`/`isCurrentState` (record-store), `newLaunch`/`linkRelease`/
 * `bindReleaseToLaunch` (launch-store), `dedupKey` (release schema) — stay free functions and
 * are imported verbatim by every adapter. That is what keeps invariant #3's `(release_id +
 * transition)` dedup key identical across backends: the key is computed by the same pure code
 * regardless of where the bytes land.
 *
 * `FlagClient` (`flags/types.ts`) and `Notifier` (`publicity/notify.ts`) are already ports with
 * git + service adapters and config/app-scoped selection; they are intentionally not in the
 * `Backend` bag (which is org+state-dir-scoped) — they keep their existing wiring.
 */

export interface RecordStore {
  read(releaseId: string): Promise<Release | null>;
  write(release: Release): Promise<void>;
  scanIds(): Promise<string[]>;
}

export interface LaunchStore {
  read(launchId: string): Promise<Launch | null>;
  write(launch: Launch): Promise<void>;
  scanIds(): Promise<string[]>;
}

export interface ProposalStore {
  read(proposalId: string): Promise<Proposal | null>;
  write(proposal: Proposal): Promise<void>;
  list(): Promise<Proposal[]>;
}

export interface LedgerStore {
  readAnnounced(launchId: string): Promise<Set<string>>;
  markAnnounced(launchId: string, scopeKey: string): Promise<void>;
}

export interface CanonStore {
  /** Append an approved post to the voice canon. Idempotent on the entry id; returns whether it was newly written. */
  append(entry: CanonEntry): Promise<boolean>;
}

/** The persistence backend: one bag of state-scoped stores, selected by `coordinator.backend`. */
export interface Backend {
  records: RecordStore;
  launches: LaunchStore;
  proposals: ProposalStore;
  ledger: LedgerStore;
  canon: CanonStore;
}
