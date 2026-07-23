import type { Release } from "../contracts/release.schema.js";
import type { ReleaseState } from "../contracts/state.js";
import { scanReleaseIds } from "./record-store.js";
import type { Backend } from "./ports.js";
import { applyTransition } from "./state-machine.js";

// Re-exported for callers that discover release ids outside a reconcile sweep.
export { scanReleaseIds } from "./record-store.js";

/**
 * The reconciliation loop (M2). The coordinator is a projection (invariant #1): for
 * each release record it asks every applicable *source* what the external world now
 * says, turns deltas into transition proposals, and applies them through the state
 * machine — legal + idempotent. Running it twice over stable external truth produces
 * zero new transitions, which is the M2 guarantee.
 *
 * Real external pollers (App Store Connect review → M3, flag provider → M4, Sentry →
 * M6) implement `ReconcileSource` and register here at their milestone. The engine and
 * its idempotency are complete now and surface-agnostic.
 */

export interface TransitionProposal {
  to: ReleaseState;
  by: string; // actor/source recorded on the transition
  reason?: string;
  /** Projection fields to merge into external_refs (idempotent: stable truth = no change). */
  externalRefs?: Record<string, unknown>;
}

export interface ReconcileContext {
  now: () => string;
  log: (message: string) => void;
}

export interface ReconcileSource {
  readonly name: string;
  /** Cheap predicate so a poller only runs for records it cares about. */
  appliesTo(release: Release): boolean;
  poll(release: Release, ctx: ReconcileContext): Promise<TransitionProposal[]>;
}

export interface AppliedTransition {
  release_id: string;
  to: ReleaseState;
  by: string;
  source: string;
}

export interface SkippedTransition {
  release_id: string;
  to: ReleaseState;
  reason: "duplicate" | "illegal";
  source: string;
}

export interface SourceError {
  release_id: string;
  source: string;
  message: string;
}

export interface ReconcileReport {
  scanned: number;
  applied: AppliedTransition[];
  skipped: SkippedTransition[];
  errors: SourceError[];
}

export interface ReconcileOptions {
  backend: Backend;
  sources: ReconcileSource[];
  now: () => string;
  log?: (message: string) => void;
  /** Override release discovery (tests/injection); defaults to scanning the record store. */
  loadReleaseIds?: () => string[] | Promise<string[]>;
}

export async function reconcile(opts: ReconcileOptions): Promise<ReconcileReport> {
  const log = opts.log ?? (() => {});
  const ctx: ReconcileContext = { now: opts.now, log };
  const ids = await (opts.loadReleaseIds ?? (() => opts.backend.records.scanIds()))();

  const report: ReconcileReport = { scanned: 0, applied: [], skipped: [], errors: [] };

  for (const id of ids) {
    let release = await opts.backend.records.read(id);
    if (!release) continue;
    report.scanned++;
    const before = JSON.stringify(release);

    for (const source of opts.sources) {
      if (!source.appliesTo(release)) continue;

      // A single misbehaving poller (expired creds, ASC 5xx) must not halt the sweep
      // or corrupt the projection — isolate it, record it, move on.
      let proposals: TransitionProposal[];
      try {
        proposals = await source.poll(release, ctx);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        report.errors.push({ release_id: id, source: source.name, message });
        log(`[reconcile] ${id}: source ${source.name} errored — ${message}`);
        continue;
      }

      for (const proposal of proposals) {
        // Merge projection fields first (idempotent merge of stable external truth).
        if (proposal.externalRefs) {
          release = {
            ...release,
            external_refs: { ...release.external_refs, ...proposal.externalRefs },
          };
        }

        const outcome = applyTransition(release, proposal.to, proposal.by, opts.now);
        if (outcome.applied) {
          release = outcome.release;
          report.applied.push({ release_id: id, to: proposal.to, by: proposal.by, source: source.name });
          log(`[reconcile] ${id}: → ${proposal.to} (via ${source.name})`);
        } else {
          report.skipped.push({
            release_id: id,
            to: proposal.to,
            reason: outcome.reason,
            source: source.name,
          });
        }
      }
    }

    // Persist only on an actual change — a clean second pass writes nothing.
    if (JSON.stringify(release) !== before) {
      await opts.backend.records.write(release);
    }
  }

  return report;
}
