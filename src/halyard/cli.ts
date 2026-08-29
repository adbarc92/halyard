#!/usr/bin/env node
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadAppConfig, loadOrgConfig } from "./config/loader.js";
import type { AppConfig } from "./config/app-config.schema.js";
import { discoverAppSlugs } from "./config/discover.js";
import { assertSupportedBackend, makeBackend } from "./config/backend.js";
import { parseFlags, requireFlag } from "./cli-args.js";
import { runRelease, releaseSucceeded } from "./coordinator/release-runner.js";
import { SURFACES, SemverSchema, type Surface } from "./config/primitives.js";
import type { Release } from "./contracts/release.schema.js";
import { ShellCommandRunner } from "./surfaces/command-runner.js";
import { releasePath } from "./coordinator/record-store.js";
import type { Backend } from "./coordinator/ports.js";
import { summarizeRelease } from "./coordinator/status.js";
import { assessReadiness, isReady, type ReadinessReport } from "./coordinator/preflight.js";
import { approveProposal } from "./coordinator/approve.js";
import {
  bindReleaseToLaunch,
  linkRelease,
  newLaunch,
} from "./coordinator/launch-store.js";
import { HttpFlagClient } from "./flags/http-client.js";
import { makeFlagClient } from "./flags/select.js";
import { flagKeyFor } from "./flags/naming.js";
import { autoPromoteWebRelease } from "./coordinator/auto-promote.js";
import { makeNotifier } from "./publicity/select.js";
import type { Notifier } from "./publicity/notify.js";
import { tryResolveSecret } from "./secrets/resolve.js";
import {
  collectRecentCommits,
  TemplateNarrativeDrafter,
  AnthropicNarrativeDrafter,
  type NarrativeDrafter,
} from "./agents/narrative/narrative-drafter.js";
import { runCertWatch } from "./maintenance/cert-watch.js";
import { runDeadlineWatch } from "./maintenance/deadlines.js";
import { runRenovate } from "./maintenance/renovate.js";
import {
  EnvCertProvider,
  EnvDeadlineProvider,
  EnvDependencyProvider,
  DryRunMergeClient,
  GitHubMergeClient,
} from "./maintenance/providers.js";
import type { MergeClient } from "./maintenance/types.js";
import { StripePaymentProvider } from "./payments/stripe-client.js";
import type { PaymentProvider, PaymentStatus } from "./payments/types.js";
import { getEntitlement, enforceMultiApp } from "./licensing/index.js";
import { runFullReconcile, triageAllApps } from "./orchestration/full-reconcile.js";
import { runOnboard } from "./onboard/init.js";

/**
 * Minimal CLI (M1). The reusable workflow calls:
 *   halyard release run --app aurora --surface web --version <v> --commit <sha>
 * No arg-parser dependency — the surface is small and auditable.
 */

/** Apps to operate on: the explicit --apps list, or every discovered apps/<slug>/app.yml. */
function loadApps(flags: Record<string, string>): AppConfig[] {
  const explicit = (flags.apps ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const slugs = explicit.length > 0 ? explicit : discoverAppSlugs(resolve("apps"));
  return slugs.map((slug) => loadAppConfig(resolve(`apps/${slug}/app.yml`)));
}

/**
 * The multi-app Pro gate, applied by the *acting* commands (reconcile/maintenance/triage)
 * only — read-only diagnostics (status, preflight, payments verify) must still work for a
 * free multi-app shop so the operator can see what's there and why an upgrade is needed.
 */
function gateMultiApp(apps: AppConfig[]): void {
  enforceMultiApp(apps.length, getEntitlement());
}

async function releaseRun(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const appSlug = requireFlag(flags, "app");
  const surface = requireFlag(flags, "surface") as Surface;
  if (!SURFACES.includes(surface)) {
    throw new Error(`--surface must be one of ${SURFACES.join(", ")}`);
  }
  const version = requireFlag(flags, "version");
  const commit = flags.commit ?? "unknown";

  const orgConfigPath = resolve(flags.config ?? "halyard.config.yml");
  const appConfigPath = resolve(flags["app-config"] ?? `apps/${appSlug}/app.yml`);

  const org = loadOrgConfig(orgConfigPath);
  const app = loadAppConfig(appConfigPath);

  // Validate the tag-derived inputs before they touch the filesystem / any command — a
  // malformed version or commit (e.g. from a hand-pushed tag) fails loudly here.
  if (app.version_scheme.semver) SemverSchema.parse(version);
  if (commit !== "unknown" && !/^[0-9a-f]{7,40}$/i.test(commit)) {
    throw new Error(`--commit must be a git sha (7-40 hex chars), got '${commit}'`);
  }

  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const workdir = resolve(flags.workdir ?? ".");
  const backend = makeBackend(org, { stateDir });

  const now = () => new Date().toISOString();
  const release = await runRelease({
    app,
    surface,
    version,
    commit,
    backend,
    workdir,
    runner: new ShellCommandRunner(),
    now,
    log: (m) => console.error(m),
  });

  // Web auto-promote: a standalone web release with promote_gate:false gets a born-ON flag and is
  // projected live on deploy. A no-op for every other case (returns `release` unchanged).
  const finalRelease = await autoPromoteWebRelease({ release, app, surface, stateDir, backend, now });

  console.log(
    JSON.stringify(
      { release_id: finalRelease.release_id, state: finalRelease.state, record: releasePath(stateDir, finalRelease.release_id) },
      null,
      2,
    ),
  );

  // Exit non-zero unless the run reached a deployed-or-beyond state, so CI surfaces both a
  // dead release AND a failed deploy (which leaves the record stuck at `tested`).
  return releaseSucceeded(finalRelease.state) ? 0 : 1;
}

async function reconcileRun(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const canonDir = resolve(org.drafting.voice_canon);
  const backend = makeBackend(org, { stateDir, canonDir });
  const apps = loadApps(flags);
  const now = () => new Date().toISOString();

  const r = await runFullReconcile({ org, apps, backend, stateDir, canonDir, now, log: (m) => console.error(m) });

  console.log(
    JSON.stringify(
      {
        ...r.reconcile,
        graduation_proposals: r.graduationProposals,
        publicity_fanouts: r.publicityFanouts,
        triage_proposals: r.triageProposals,
        rejection_proposals: r.rejectionProposals,
      },
      null,
      2,
    ),
  );

  for (const err of r.reconcile.errors) {
    console.error(`::warning::reconcile source ${err.source} failed for ${err.release_id}: ${err.message}`);
  }
  return r.reconcile.errors.length > 0 ? 1 : 0;
}

/**
 * `halyard triage` — run crash triage immediately, out of band from the reconcile cron.
 * This is the latency-sensitive path (design §5): a Sentry alert → repository_dispatch →
 * this command, so a spike reaches your phone in seconds, not on the next 20-min sweep.
 */
async function triageCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const backend = makeBackend(org, { stateDir });
  const now = () => new Date().toISOString();
  const apps = loadApps(flags);
  gateMultiApp(apps); // acts across apps → Pro for >1

  const notifier: Notifier = makeNotifier(org, stateDir, now);

  const proposals = await triageAllApps({ org, apps, backend, notifier, now, log: (m) => console.error(m) });
  console.log(JSON.stringify({ triage_proposals: proposals.length }, null, 2));
  return 0;
}

function chooseNarrativeDrafter(org: ReturnType<typeof loadOrgConfig>): NarrativeDrafter {
  const apiKey = tryResolveSecret(org.drafting.api_key_ref);
  return apiKey && getEntitlement().has("ai-agents")
    ? new AnthropicNarrativeDrafter(org.drafting.model, apiKey)
    : new TemplateNarrativeDrafter();
}

async function maintenanceCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const backend = makeBackend(org, { stateDir });
  const now = () => new Date().toISOString();
  const apps = loadApps(flags);
  gateMultiApp(apps); // acts across apps → Pro for >1

  const notifier = makeNotifier(org, stateDir, now);
  const log = (m: string) => console.error(m);

  const certs = await runCertWatch({ backend, apps, provider: new EnvCertProvider(), notifier, now, log });
  const deadlines = await runDeadlineWatch({ backend, apps, provider: new EnvDeadlineProvider(), notifier, now, log });

  const autoMergeEntitled = getEntitlement().has("auto-merge");
  if (process.env.HALYARD_LIVE_MERGE && !autoMergeEntitled) {
    console.error("::warning::auto-merge is a Halyard Pro feature; running dry-run");
  }
  const mergeClient: MergeClient = process.env.HALYARD_LIVE_MERGE && autoMergeEntitled
    ? new GitHubMergeClient() // repo is resolved per-app from config, not a global default
    : new DryRunMergeClient(stateDir, now);
  const deps = await runRenovate({
    backend, apps, provider: new EnvDependencyProvider(), mergeClient, notifier, now, log,
  });

  // Fail loud on provider failures, same as reconcile — a broken cert/deadline/deps
  // source turns the scheduled run red instead of passing green while doing nothing.
  // An UNCONFIGURED source is not a failure: these are optional, and an app that simply
  // has no Authenticode cert or no deadlines calendar is skipped, not errored.
  const errors = [...certs.errors, ...deadlines.errors, ...deps.errors];
  const skipped = [...certs.skipped, ...deadlines.skipped, ...deps.skipped];
  for (const err of errors) console.error(`::warning::maintenance: ${err}`);
  for (const skip of skipped) console.error(`::notice::maintenance: skipped — ${skip}`);

  console.log(
    JSON.stringify(
      {
        cert_alerts: certs.created.length,
        deadline_alerts: deadlines.created.length,
        deps_auto_merged: deps.merged.length,
        deps_proposed: deps.proposed.length,
        skipped: skipped.length,
        errors: errors.length,
      },
      null,
      2,
    ),
  );
  return errors.length > 0 ? 1 : 0;
}

/**
 * `halyard status` — the operator's view of why releases are where they are. Lists each
 * release's state, what it's blocked on, and how long it's waited, so a stuck release is
 * visible without hand-reading state/releases/*.json. `--stuck` shows only in-flight ones;
 * `--release <id>` shows one.
 */
async function statusCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const backend = makeBackend(org, { stateDir });
  const now = new Date().toISOString();

  const ids = flags.release ? [flags.release] : await backend.records.scanIds();
  const all = (await Promise.all(ids.map((id) => backend.records.read(id))))
    .filter((r): r is Release => r !== null)
    .map((r) => summarizeRelease(r, now));
  const shown = flags.stuck ? all.filter((s) => s.stuck) : all;

  console.log(JSON.stringify(shown, null, 2));
  return 0;
}

/** The configured payment provider for an app, or null when none is configured / no key is
 *  resolvable. The key is resolved from the app's secret reference, never a literal. */
function choosePaymentProvider(app: AppConfig): PaymentProvider | null {
  const cfg = app.payments;
  if (!cfg) return null;
  const apiKey = tryResolveSecret(cfg.api_key_ref);
  if (!apiKey) return null;
  switch (cfg.provider) {
    case "stripe":
      return new StripePaymentProvider({ apiKey });
    default:
      throw new Error(`unsupported payment provider: ${cfg.provider}`);
  }
}

/** Read-only payment access check, shared by `payments verify` and `preflight`. Returns a
 *  PaymentStatus and never throws — an unconfigured app reports configured:false (not a
 *  failure); a configured-but-unreachable provider reports reachable:false. */
async function probePayments(app: AppConfig): Promise<PaymentStatus> {
  const provider = choosePaymentProvider(app);
  if (!provider) {
    return {
      provider: app.payments?.provider ?? "none",
      configured: false,
      reachable: false,
      detail: app.payments ? "no credentials resolved from the secret store" : "no payments configured",
    };
  }
  try {
    return await provider.verifyAccess();
  } catch (err) {
    return {
      provider: app.payments?.provider ?? "stripe",
      configured: true,
      reachable: false,
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * `halyard payments verify` — a production-readiness preflight for payment processing: for
 * each app with a `payments` block, confirm the configured key authenticates (read-only;
 * never moves money). Exits non-zero if a configured provider is unreachable, so it can gate
 * a go-live check. Apps without a payments block are reported, not failed.
 */
async function paymentsCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "verify") {
    console.error("usage: halyard payments verify [--apps <slug,slug>]");
    return 2;
  }
  const flags = parseFlags(rest);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  assertSupportedBackend(org);
  const apps = loadApps(flags);

  let anyFail = false;
  const report = [];
  for (const app of apps) {
    const status = await probePayments(app);
    report.push({ app: app.app.slug, ...status });
    if (status.configured && !status.reachable) anyFail = true;
  }

  console.log(JSON.stringify(report, null, 2));
  return anyFail ? 1 : 0;
}

/**
 * `halyard preflight` — the one-stop production-readiness check. For each app it reports,
 * per third-party integration (approval surface, flags, monitoring, payments, stores, web
 * deploy), whether it is *required*, *configured* (its secrets resolve), and — for the cheap,
 * safe ones (flags, payments) — *reachable* (the key actually authenticates). Exits non-zero
 * if any app isn't ready, so it can gate a go-live. `--probe off` skips the live network
 * checks (config-only, offline).
 */
async function preflightCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  assertSupportedBackend(org);
  const apps = loadApps(flags);
  const probe = flags.probe !== "off";

  let allReady = true;
  const reports: ReadinessReport[] = [];
  for (const app of apps) {
    const report = assessReadiness(app, org, (name) => process.env[name]);

    if (probe) {
      // Payments: read-only verify (GET balance). Only probe what's configured.
      const pay = report.items.find((i) => i.integration === "payments");
      if (pay?.configured) {
        const status = await probePayments(app);
        pay.reachable = status.reachable;
        pay.detail = status.detail ?? pay.detail;
      }
      // Flags: probe the real provider with a sentinel read (404 = absent = reachable).
      const flagItem = report.items.find((i) => i.integration === "flags");
      if (flagItem?.configured && app.flags.api_url) {
        const token = tryResolveSecret(app.flags.api_key_ref);
        if (token) {
          try {
            await new HttpFlagClient({ baseUrl: app.flags.api_url, token }).getState("halyard.preflight.__probe__");
            flagItem.reachable = true;
          } catch (err) {
            flagItem.reachable = false;
            flagItem.detail = err instanceof Error ? err.message : String(err);
          }
        }
      }
    }

    report.ready = isReady(report.items);
    reports.push(report);
    if (!report.ready) allReady = false;
  }

  console.log(JSON.stringify(reports, null, 2));
  return allReady ? 0 : 1;
}

/** `halyard license` — show the resolved entitlement (tier, licensee, Pro features, expiry). */
async function licenseCmd(): Promise<number> {
  const e = getEntitlement();
  console.log(
    JSON.stringify(
      { tier: e.tier, licensee: e.licensee, features: [...e.features], expires_at: e.expiresAt },
      null,
      2,
    ),
  );
  return 0;
}

async function queueCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const backend = makeBackend(org, { stateDir });
  const open = (await backend.proposals.list()).filter((p) => flags.all ? true : p.status === "open");
  console.log(JSON.stringify(open, null, 2));
  return 0;
}

async function approveCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const org = loadOrgConfig(resolve(flags.config ?? "halyard.config.yml"));
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const canonDir = resolve(org.drafting.voice_canon);
  const backend = makeBackend(org, { stateDir, canonDir });
  const id = requireFlag(flags, "proposal");

  // --text captures the final, human-polished copy actually posted (best canon signal).
  const result = await approveProposal({
    backend,
    proposalId: id,
    ...(flags.text ? { finalText: flags.text } : {}),
    now: () => new Date().toISOString(),
  });

  // Approving a third-party post records intent — the post button stays a human action
  // (invariant #5). Halyard never auto-posts to a third-party API.
  if (result.proposal.kind === "social_post") {
    console.error(`${id}: approved — now post it yourself; halyard will not auto-post to third-party APIs`);
    if (result.canonAppended) console.error(`${id}: fed into the voice canon (${canonDir})`);
  } else {
    console.error(`${id}: approved`);
  }
  console.log(JSON.stringify({ proposal_id: id, status: "approved", canon_appended: result.canonAppended }, null, 2));
  return 0;
}

async function launchCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const flags = parseFlags(rest);
  const orgConfigPath = resolve(flags.config ?? "halyard.config.yml");
  const org = loadOrgConfig(orgConfigPath);
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);
  const backend = makeBackend(org, { stateDir });
  const now = () => new Date().toISOString();

  if (sub === "create") {
    const appSlug = requireFlag(flags, "app");
    const feature = requireFlag(flags, "feature");
    const title = requireFlag(flags, "title");
    const app = loadAppConfig(resolve(flags["app-config"] ?? `apps/${appSlug}/app.yml`));
    const flag = flagKeyFor(app.flags.naming, app.app.slug, feature);

    // The narrative seed is the highest-value human input. If not given, an agent drafts
    // a first version from recent changes for the human to edit (design §3).
    let narrativeSeed = flags.narrative;
    if (!narrativeSeed) {
      const changes = await collectRecentCommits(new ShellCommandRunner(), resolve(flags.workdir ?? "."));
      narrativeSeed = await chooseNarrativeDrafter(org).draft({ app: app.app.slug, feature, title, changes });
      console.error(`[launch] drafted narrative seed from ${changes.length} recent commit(s) — review and edit it`);
    }

    const launch = newLaunch({
      app: app.app.slug,
      feature,
      title,
      narrativeSeed,
      announcePolicy:
        (flags.announce as never) ?? app.launch_defaults.announce_policy,
      tier: (flags.tier as never) ?? "standard",
      flag,
      createdBy: flags.by ?? "cli",
      createdAt: now(),
    });
    await backend.launches.write(launch);

    // The launch flag is born OFF in the provider.
    await makeFlagClient([app], stateDir, now).ensureFlag(flag);

    console.log(JSON.stringify({ launch_id: launch.launch_id, flag, flag_state: "off" }, null, 2));
    return 0;
  }

  if (sub === "link") {
    const launchId = requireFlag(flags, "launch");
    const releaseId = requireFlag(flags, "release");
    const launch = await backend.launches.read(launchId);
    if (!launch) throw new Error(`no such launch: ${launchId}`);
    const release = await backend.records.read(releaseId);
    if (!release) throw new Error(`no such release: ${releaseId}`);

    await backend.launches.write(linkRelease(launch, releaseId));
    await backend.records.write(bindReleaseToLaunch(release, launch));

    console.log(JSON.stringify({ launch_id: launchId, release_id: releaseId, flag: launch.flag }, null, 2));
    return 0;
  }

  console.error("usage: halyard launch create|link ...");
  return 2;
}

async function flipCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);
  const orgConfigPath = resolve(flags.config ?? "halyard.config.yml");
  const org = loadOrgConfig(orgConfigPath);
  assertSupportedBackend(org);
  const stateDir = resolve(flags["state-dir"] ?? org.coordinator.state_dir);

  const flag = requireFlag(flags, "flag");
  const state = requireFlag(flags, "state"); // on | off
  if (state !== "on" && state !== "off") throw new Error('--state must be "on" or "off"');

  // --app selects the live provider's config (base URL + token ref); without it the flip
  // targets the git-backed file client (the local default).
  const appsForFlip = flags.app
    ? [loadAppConfig(resolve(flags["app-config"] ?? `apps/${flags.app}/app.yml`))]
    : [];

  // The human gate. Flipping the flag is the launch moment; the next reconcile projects
  // it to `live` (or `rolled_back`). The system never flips a flag on its own.
  await makeFlagClient(appsForFlip, stateDir, () => new Date().toISOString()).setState(flag, state === "on");
  console.error(`flipped ${flag} ${state.toUpperCase()} — reconcile will project the transition`);
  console.log(JSON.stringify({ flag, state }, null, 2));
  return 0;
}

/**
 * Read one line from stdin with a prompt, for the interactive `app init` path. Resolves to ""
 * on EOF. Kept tiny and local — `app init` is also fully flag-drivable (so tests never need a
 * TTY); this is only the convenience prompt when a flag was omitted at an interactive terminal.
 */
function promptLine(question: string): Promise<string> {
  return new Promise((resolvePrompt) => {
    process.stdout.write(question);
    const onData = (chunk: Buffer) => {
      process.stdin.off("data", onData);
      process.stdin.pause();
      resolvePrompt(chunk.toString("utf8").replace(/\r?\n$/, "").trim());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

/**
 * `halyard app init` (alias `onboard`) — scaffold `apps/<slug>/app.yml` for a first-time
 * operator. Fully flag-drivable (`--name`, `--slug`, `--surfaces ios,web`, `--force`); any
 * omitted field is prompted for at an interactive terminal. Emits ONLY the chosen surfaces,
 * each with `SECRET:NAME` refs + `REPLACE_ME` markers — never a real secret (invariant #4).
 * On finish it prints the secrets to set and runs `halyard preflight --probe off` so the
 * operator immediately sees the config-only readiness worklist.
 */
async function appInitCmd(argv: string[]): Promise<number> {
  const flags = parseFlags(argv);

  const name = flags.name ?? (await promptLine("App name (e.g. Aurora): "));
  const slug = flags.slug ?? (await promptLine("Slug (lowercase, e.g. aurora): "));
  const surfacesRaw =
    flags.surfaces ??
    (await promptLine(`Surfaces to enable, comma-separated (${SURFACES.join("/")}): `));
  const surfaces = surfacesRaw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean) as Surface[];

  const appsDir = resolve(flags["apps-dir"] ?? "apps");
  const result = runOnboard({ name, slug, surfaces, appsDir, force: flags.force === "true" });

  console.log(
    JSON.stringify(
      { app: result.slug, surfaces: result.surfaces, path: result.path, secrets: result.secrets },
      null,
      2,
    ),
  );
  console.error(`\nScaffolded ${result.path} (surfaces: ${result.surfaces.join(", ")}).`);
  console.error(`Next: replace every REPLACE_ME with a real identifier, then set these secrets in your store:`);
  for (const s of result.secrets) console.error(`  - ${s}`);
  console.error(`(set the flag provider's flags.api_url too once you have one)`);

  // Show the config-only readiness worklist immediately. preflight resolves apps from the
  // default `apps/` dir, so only auto-run it when we scaffolded there (no custom --apps-dir).
  // preflight exits non-zero until the secrets above are present — that's expected on a fresh
  // scaffold, so its code is informational here and NOT propagated as this command's exit code
  // (the scaffold itself succeeded).
  if (!flags["apps-dir"]) {
    console.error(`\nReadiness so far (halyard preflight --probe off):`);
    await preflightCmd(["--apps", result.slug, "--probe", "off"]);
  } else {
    console.error(`\nRun \`halyard preflight --probe off\` to see the config-only readiness worklist.`);
  }
  return 0;
}

async function appCmd(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "init") return appInitCmd(rest);
  console.error("usage: halyard app init [--name <name>] [--slug <slug>] [--surfaces ios,android,web,desktop] [--force]");
  return 2;
}

/**
 * Dispatch a CLI invocation and return its exit code. Exported (and side-effect-free on
 * import — see the entrypoint guard below) so it can be driven directly in tests and by an
 * embedding host. `args` is argv without the node/script prefix (i.e. process.argv.slice(2)).
 */
export async function dispatch(args: string[]): Promise<number> {
  const [command, sub, ...rest] = args;
  if (command === "release" && sub === "run") {
    return releaseRun(rest);
  }
  if (command === "reconcile") {
    return reconcileRun(sub ? [sub, ...rest] : rest);
  }
  if (command === "launch") {
    return launchCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "flip") {
    return flipCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "maintenance") {
    return maintenanceCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "triage") {
    return triageCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "status") {
    return statusCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "payments") {
    return paymentsCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "preflight") {
    return preflightCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "license") {
    return licenseCmd();
  }
  if (command === "queue") {
    return queueCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "approve") {
    return approveCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "app") {
    return appCmd(sub ? [sub, ...rest] : rest);
  }
  if (command === "onboard") {
    // Alias for `app init` — the same scaffolder under a single verb.
    return appInitCmd(sub ? [sub, ...rest] : rest);
  }
  console.error(
    "usage:\n" +
      "  halyard release run --app <slug> --surface <surface> --version <v> [--commit <sha>]\n" +
      "  halyard reconcile [--apps <slug,slug>]\n" +
      "  halyard launch create --app <slug> --feature <f> --title <t> [--narrative <n>] [--tier launch] [--announce ...]\n" +
      "  halyard launch link --launch <id> --release <id>\n" +
      "  halyard flip --flag <key> --state on|off [--app <slug>]\n" +
      "  halyard maintenance [--apps <slug,slug>]\n" +
      "  halyard triage [--apps <slug,slug>]\n" +
      "  halyard status [--stuck] [--release <id>]\n" +
      "  halyard payments verify [--apps <slug,slug>]\n" +
      "  halyard preflight [--apps <slug,slug>] [--probe off]\n" +
      "  halyard license\n" +
      "  halyard queue [--all]\n" +
      "  halyard approve --proposal <id>\n" +
      "  halyard app init [--name <name>] [--slug <slug>] [--surfaces ios,android,web,desktop] [--force]",
  );
  return 2;
}

// Run only when invoked as the entrypoint (`tsx cli.ts ...` or the built `halyard` bin),
// never on import — so the module can be loaded by tests or an embedding host without
// executing a command or calling process.exit.
const invokedDirectly = process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (invokedDirectly) {
  dispatch(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(1);
    });
}
