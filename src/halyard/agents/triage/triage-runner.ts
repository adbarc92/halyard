import type { AppConfig } from "../../config/app-config.schema.js";
import type { Proposal } from "../../contracts/proposal.schema.js";
import type { Backend } from "../../coordinator/ports.js";
import type { Notifier } from "../../publicity/notify.js";
import type { CrashSignal, SentryClient, TriageClassifier } from "./types.js";

/**
 * Triage runner (M6). For every live release, the deterministic gate checks crash-free %
 * against the app's threshold; only on a genuine spike does it invoke the classifier
 * (the agent) and write a `crash_triage` *proposal*. It never flips a flag or touches the
 * release — the spike yields a classified proposal, not an action (the M6 guarantee).
 *
 * Per-release errors (Sentry down, missing creds) are isolated so one bad poll can't
 * halt triage.
 */
export interface TriageDeps {
  backend: Backend;
  apps: AppConfig[];
  sentryClient: SentryClient;
  classifier: TriageClassifier;
  notifier: Notifier;
  now: () => string;
  log?: (message: string) => void;
}

export async function runTriage(deps: TriageDeps): Promise<Proposal[]> {
  const log = deps.log ?? (() => {});
  const created: Proposal[] = [];

  for (const releaseId of await deps.backend.records.scanIds()) {
    const release = await deps.backend.records.read(releaseId);
    if (!release || release.state !== "live") continue;

    const app = deps.apps.find((a) => a.app.slug === release.app);
    if (!app) continue;
    const thresholdPct = app.triage.severity_thresholds.crash_free_users_pct;

    try {
      const stats = await deps.sentryClient.getReleaseHealth(
        release.app,
        release.surface,
        release.version,
      );

      // Deterministic spike gate.
      const holds = stats.crashFreePct < thresholdPct;
      // Scope the proposal to the current live cycle: after a rollback + re-flip
      // (`live#2`) a fresh spike must not be suppressed by a prior cycle's
      // approved/dismissed proposal.
      const liveCycle = release.transitions.filter((t) => t.to === "live").length;
      const proposalId = `prop_triage_${release.release_id}_${liveCycle}`;
      const existing = await deps.backend.proposals.read(proposalId);

      if (!holds) {
        // Crash-free recovered: auto-resolve an open alert (humans' decisions untouched).
        if (existing && existing.status === "open") {
          await deps.backend.proposals.write({ ...existing, status: "resolved" });
          log(`[triage] ${release.release_id}: crash-free recovered → resolved`);
        }
        continue;
      }

      // Spike ongoing. Only classify (the agent call) when we'd actually (re)open — i.e.
      // no proposal yet, or the prior one was system-resolved (a recurrence).
      if (existing && existing.status !== "resolved") continue;

      const signal: CrashSignal = {
        app: release.app,
        surface: release.surface,
        version: release.version,
        flag: release.flag,
        thresholdPct,
        stats,
      };
      const classification = await deps.classifier.classify(signal);

      const proposal: Proposal = {
        proposal_id: proposalId,
        kind: "crash_triage",
        app: release.app,
        release_id: release.release_id,
        launch_id: release.launch_id,
        ...(release.flag ? { flag: release.flag } : {}),
        severity: classification.severity,
        recommendation: classification.recommendation,
        title: `[${classification.severity}] crash spike in ${release.release_id} → ${classification.recommendation}`,
        body:
          `${classification.rationale}\n` +
          `Recommended action: ${classification.recommendation}. ` +
          (classification.recommendation === "flag_kill" && release.flag
            ? `Approve, then kill the flag: halyard flip --flag ${release.flag} --state off. `
            : "") +
          `This is a proposal — no action has been taken. Human approval required.`,
        status: "open",
        created_at: deps.now(),
      };

      await deps.backend.proposals.write(proposal);
      await deps.notifier.notify(proposal);
      created.push(proposal);
      log(`[triage] ${release.release_id}: ${classification.severity}/${classification.recommendation} (proposed)`);
    } catch (err) {
      log(`[triage] ${release.release_id}: skipped — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  return created;
}
