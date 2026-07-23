import type { Release } from "../contracts/release.schema.js";
import type { Launch } from "../contracts/launch.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { appendToCanon, type CanonEntry } from "../publicity/canon-store.js";
import { readAnnounced, markAnnounced } from "../publicity/ledger.js";
import { readRelease, writeRelease, scanReleaseIds } from "./record-store.js";
import { readLaunch, writeLaunch, scanLaunchIds } from "./launch-store.js";
import { readProposal, writeProposal, listProposals } from "./proposals.js";
import type { Backend, RecordStore, LaunchStore, ProposalStore, LedgerStore, CanonStore } from "./ports.js";

/**
 * Git-backed adapters: thin async wrappers over the existing synchronous, filesystem-backed
 * store functions. Re-housing the current behavior behind the ports — no logic moves here, so
 * the existing suite proves the wrap is behavior-preserving. Schema validation stays inside the
 * wrapped functions (`*Schema.parse` on read and write).
 */

class GitRecordStore implements RecordStore {
  constructor(private readonly stateDir: string) {}
  async read(releaseId: string): Promise<Release | null> {
    return readRelease(this.stateDir, releaseId);
  }
  async write(release: Release): Promise<void> {
    writeRelease(this.stateDir, release);
  }
  async scanIds(): Promise<string[]> {
    return scanReleaseIds(this.stateDir);
  }
}

class GitLaunchStore implements LaunchStore {
  constructor(private readonly stateDir: string) {}
  async read(launchId: string): Promise<Launch | null> {
    return readLaunch(this.stateDir, launchId);
  }
  async write(launch: Launch): Promise<void> {
    writeLaunch(this.stateDir, launch);
  }
  async scanIds(): Promise<string[]> {
    return scanLaunchIds(this.stateDir);
  }
}

class GitProposalStore implements ProposalStore {
  constructor(private readonly stateDir: string) {}
  async read(proposalId: string): Promise<Proposal | null> {
    return readProposal(this.stateDir, proposalId);
  }
  async write(proposal: Proposal): Promise<void> {
    writeProposal(this.stateDir, proposal);
  }
  async list(): Promise<Proposal[]> {
    return listProposals(this.stateDir);
  }
}

class GitLedgerStore implements LedgerStore {
  constructor(private readonly stateDir: string) {}
  async readAnnounced(launchId: string): Promise<Set<string>> {
    return readAnnounced(this.stateDir, launchId);
  }
  async markAnnounced(launchId: string, scopeKey: string): Promise<void> {
    markAnnounced(this.stateDir, launchId, scopeKey);
  }
}

class GitCanonStore implements CanonStore {
  constructor(private readonly canonDir: string | undefined) {}
  async append(entry: CanonEntry): Promise<boolean> {
    if (this.canonDir === undefined) {
      throw new Error("canon store unavailable: makeGitBackend was constructed without a canonDir");
    }
    return appendToCanon(this.canonDir, entry);
  }
}

/**
 * Construct the git backend directly from filesystem locations. `canonDir` is optional because
 * most callers never touch the canon (it lives outside the state dir, at
 * `org.drafting.voice_canon`); a caller that does (`approve`) supplies it.
 */
export function makeGitBackend(opts: { stateDir: string; canonDir?: string }): Backend {
  return {
    records: new GitRecordStore(opts.stateDir),
    launches: new GitLaunchStore(opts.stateDir),
    proposals: new GitProposalStore(opts.stateDir),
    ledger: new GitLedgerStore(opts.stateDir),
    canon: new GitCanonStore(opts.canonDir),
  };
}
