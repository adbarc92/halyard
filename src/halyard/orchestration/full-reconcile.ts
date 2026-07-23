// src/halyard/orchestration/full-reconcile.ts
import type { OrgConfig } from "../config/org-config.schema.js";
import type { AppConfig } from "../config/app-config.schema.js";
import { enforceMultiApp, getEntitlement } from "../licensing/index.js";
import { makeFlagClient } from "../flags/select.js";
import { estimateCronIntervalMs, makeCronDuePredicate } from "../coordinator/schedule.js";
import { buildReconcileSources } from "../coordinator/sources/index.js";
import { reconcile, type ReconcileReport } from "../coordinator/reconcile.js";
import type { Backend } from "../coordinator/ports.js";
import { proposeFlagGraduations } from "../coordinator/graduation.js";
import { reconcileProposal } from "../coordinator/proposals.js";
import { makeDrafter, makePublisher, makeNotifier } from "../publicity/select.js";
import { readVoiceCanon } from "../publicity/voice-canon.js";
import { firePublicity } from "../publicity/trigger.js";
import type { Notifier } from "../publicity/notify.js";
import { runTriage } from "../agents/triage/triage-runner.js";
import { LiveSentryClient } from "../agents/triage/sentry-client.js";
import { RuleTriageClassifier } from "../agents/triage/rule-classifier.js";
import { AnthropicTriageClassifier } from "../agents/triage/anthropic-classifier.js";
import type { TriageClassifier } from "../agents/triage/types.js";
import { runRejectionResponses } from "../agents/rejection/rejection-runner.js";
import {
  TemplateRejectionDrafter,
  AnthropicRejectionDrafter,
  type RejectionDrafter,
} from "../agents/rejection/rejection-drafter.js";
import { tryResolveSecret } from "../secrets/resolve.js";

export interface FullReconcileReport {
  reconcile: ReconcileReport;
  graduationProposals: number;
  publicityFanouts: number;
  triageProposals: number;
  rejectionProposals: number;
}

function chooseTriageClassifier(org: OrgConfig): TriageClassifier {
  const apiKey = tryResolveSecret(org.drafting.api_key_ref);
  return apiKey && getEntitlement().has("ai-agents")
    ? new AnthropicTriageClassifier(org.drafting.model, apiKey)
    : new RuleTriageClassifier();
}

/**
 * Run Sentry crash triage across apps — proposes only, never acts (invariant #2). Shared by the
 * full reconcile AND the out-of-band `triage` command, so both wire the Sentry client + classifier
 * identically. (Moved here from cli.ts; `org` retyped to `OrgConfig`.)
 */
export async function triageAllApps(opts: {
  org: OrgConfig;
  apps: AppConfig[];
  backend: Backend;
  notifier: Notifier;
  now: () => string;
  log: (m: string) => void;
}) {
  const classifier: TriageClassifier = chooseTriageClassifier(opts.org);
  const triaged = await Promise.all(
    opts.apps.map((a) =>
      runTriage({
        backend: opts.backend,
        apps: [a],
        sentryClient: new LiveSentryClient(a.triage.sentry.org, tryResolveSecret(a.triage.sentry.project_ref) ?? ""),
        classifier,
        notifier: opts.notifier,
        now: opts.now,
        log: opts.log,
      }),
    ),
  );
  return triaged.flat();
}

function chooseRejectionDrafter(org: OrgConfig): RejectionDrafter {
  const apiKey = tryResolveSecret(org.drafting.api_key_ref);
  return apiKey && getEntitlement().has("ai-agents")
    ? new AnthropicRejectionDrafter(org.drafting.model, apiKey)
    : new TemplateRejectionDrafter();
}

/**
 * The complete reconcile cycle, shared by the CLI `reconcile` and the web console. Composes the
 * existing engine + sources + agents + publicity; the publisher is config-selected (`makePublisher`)
 * so an offline `FilePublisher` never fires where an `HttpPublisher` is configured (invariant #5).
 * Multi-app Pro-gated. Caller owns backend construction (and any fetch seam); never builds one here.
 */
export async function runFullReconcile(opts: {
  org: OrgConfig;
  apps: AppConfig[];
  backend: Backend;
  stateDir: string;
  canonDir: string;
  now: () => string;
  log?: (message: string) => void;
}): Promise<FullReconcileReport> {
  const { org, apps, backend, stateDir, canonDir, now } = opts;
  const log = opts.log ?? (() => {});

  enforceMultiApp(apps.length, getEntitlement()); // throws "… Pro feature …" for >1 app unlicensed

  const flagClient = makeFlagClient(apps, stateDir, now);

  // One clock snapshot drives the sweep instant (deterministic with an injected `now`).
  const sweepInstant = new Date(now());
  const sweepWindowMs = estimateCronIntervalMs(org.coordinator.reconcile_cron, sweepInstant);
  const isReviewPollDue = makeCronDuePredicate(sweepInstant, sweepWindowMs);
  const sources = buildReconcileSources(org, apps, { flagClient, isReviewPollDue });

  const report = await reconcile({ backend, sources, now, log });

  const thresholdDaysByApp = Object.fromEntries(apps.map((a) => [a.app.slug, a.flags.graduate_after_days]));
  const launchFlagPrefixByApp = Object.fromEntries(apps.map((a) => [a.app.slug, a.flags.naming.split("{")[0] ?? a.flags.naming]));
  const graduations = await proposeFlagGraduations({ backend, now, thresholdDaysByApp, launchFlagPrefixByApp, log });

  // Publicity — build the notifier ONCE and reuse it for triage + the coordinator-error loop.
  const drafter = makeDrafter(org);
  const publisher = makePublisher(org, stateDir, now);
  const notifier = makeNotifier(org, stateDir, now);
  const voiceCanon = readVoiceCanon(canonDir);
  const fanout = await firePublicity({ org, apps, drafter, publisher, notifier, voiceCanon, backend, now, log });

  const triaged = await triageAllApps({ org, apps, backend, notifier, now, log });
  const rejectionDrafter = chooseRejectionDrafter(org);
  const rejections = await runRejectionResponses({ backend, drafter: rejectionDrafter, notifier, now, log });

  // Surface a persistently-failing poller to the approval queue, and auto-resolve recovered ones.
  const erroredSources = new Set(report.errors.map((e) => e.source));
  for (const source of erroredSources) {
    const affected = report.errors.filter((e) => e.source === source);
    const id = `prop_coord_${source}`;
    const r = await reconcileProposal(backend.proposals, id, true, () => ({
      proposal_id: id,
      kind: "coordinator_error" as const,
      app: "_coordinator",
      severity: "high" as const,
      title: `reconcile source '${source}' is failing`,
      body:
        `The '${source}' poller errored this pass:\n` +
        affected.map((e) => `- ${e.release_id}: ${e.message}`).join("\n") +
        `\nFix the source (often expired credentials); this alert resolves itself when it recovers.`,
      status: "open" as const,
      created_at: now(),
    }));
    if (r.action === "opened" && r.proposal) await notifier.notify(r.proposal);
  }
  for (const p of await backend.proposals.list()) {
    if (p.kind === "coordinator_error" && p.status === "open") {
      const src = p.proposal_id.slice("prop_coord_".length);
      if (!erroredSources.has(src)) await backend.proposals.write({ ...p, status: "resolved" });
    }
  }

  return {
    reconcile: report,
    graduationProposals: graduations.length,
    publicityFanouts: fanout.length,
    triageProposals: triaged.length,
    rejectionProposals: rejections.length,
  };
}
