import {
  scanReleaseIds, readRelease, summarizeRelease,
  scanLaunchIds, readLaunch,
  listProposals, approveProposal,
  reconcile, flagPollSource, getEntitlement, enforceMultiApp,
  makeBackend,
  runFullReconcile,
  type Release, type ReleaseStatus, type Launch, type Proposal, type FlagState, type Backend, type FullReconcileReport,
} from "halyard";
import { loadProject, type LoadedProject } from "./project.js";
import { systemClock, type Clock } from "./clock.js";

export interface HealthReport {
  status: "ok" | "degraded" | "error";
  root: string;
  stateDir?: string;
  apps?: string[];
  error?: string;
  /**
   * Non-fatal backend warning: project config loaded (status "degraded") but the persistence
   * backend could not be initialised — e.g. `coordinator.backend: service` with no token in env.
   * Backend-dependent operations (approve, reconcileNow) will fail until the token is supplied.
   * Token values are never included here (invariant #4).
   */
  backendWarning?: string;
}

export interface ConsoleService {
  health(): HealthReport;
  listReleaseStatuses(): ReleaseStatus[];
  getRelease(id: string): Release | null;
  listLaunches(): Launch[];
  getLaunch(id: string): Launch | null;
  listQueue(opts?: { all?: boolean }): { open: Proposal[]; errors: Proposal[] };
  approve(proposalId: string, finalText?: string): Promise<{ proposal: Proposal; canonAppended: boolean }>;
  flip(flagKey: string, on: boolean): Promise<void>;
  listFlags(): Promise<{ key: string; state: FlagState }[]>;
  reconcileNow(): Promise<Awaited<ReturnType<typeof reconcile>>>;
  reconcileFull(): Promise<FullReconcileReport>;
}

class ProjectUnavailableError extends Error {}
class BackendUnavailableError extends Error {}

export function createConsoleService(opts: { root: string; now?: Clock; fetchFn?: typeof fetch }): ConsoleService {
  const now: Clock = opts.now ?? systemClock;
  // Memoize: config is resolved once (synchronous, like the CLI). health() is a validity probe.
  const project = loadProject(opts.root, now);

  function loaded(): LoadedProject {
    if (!project.ok) throw new ProjectUnavailableError(project.error);
    return project;
  }

  // The persistence backend, built once from the loaded project's config. Selects the adapter
  // set that `coordinator.backend` declares: `git` → filesystem adapters, `service` → HTTP
  // adapters. For the service backend, `makeBackend` resolves the API token at construction
  // time and HARD-FAILS if it is unresolvable — that error is caught here and stored as a
  // non-fatal warning (degrade: project loads, token-dependent ops fail with a clear message).
  // Token values are never logged (invariant #4).
  let _backend: Backend | undefined;
  let _backendError: string | undefined;

  function backend(): Backend {
    const p = loaded();
    if (_backendError) throw new BackendUnavailableError(_backendError);
    if (_backend) return _backend;
    try {
      _backend = makeBackend(p.org, { stateDir: p.stateDir, canonDir: p.canonDir, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
      return _backend;
    } catch (err) {
      // makeBackend hard-fails for `backend: service` when the token is unresolvable.
      // Convert to a stored warning so the project loads in a degraded-but-usable state.
      // The raw error message from makeBackend already scrubs the token value (it only names
      // the secret ref, never the resolved value — invariant #4).
      _backendError = err instanceof Error ? err.message : String(err);
      throw new BackendUnavailableError(_backendError);
    }
  }

  return {
    health() {
      if (!project.ok) return { status: "error", root: project.root, error: project.error };
      // Attempt to build the backend on health check so the warning is surfaced early.
      // If it fails we degrade gracefully (status "degraded"), not "error" — config is valid.
      if (!_backend && !_backendError) {
        try { backend(); } catch { /* _backendError is now set; fall through to degraded */ }
      }
      if (_backendError) {
        return {
          status: "degraded",
          root: project.root,
          stateDir: project.stateDir,
          apps: project.apps.map((a) => a.app.slug),
          backendWarning: _backendError,
        };
      }
      return { status: "ok", root: project.root, stateDir: project.stateDir, apps: project.apps.map((a) => a.app.slug) };
    },
    listReleaseStatuses() {
      const p = loaded();
      const nowIso = now();
      return scanReleaseIds(p.stateDir)
        .map((id) => readRelease(p.stateDir, id))
        .filter((r): r is Release => r !== null)
        .map((r) => summarizeRelease(r, nowIso)); // summarizeRelease takes a STRING — invoke the clock
    },
    getRelease(id) {
      return readRelease(loaded().stateDir, id);
    },
    listLaunches() {
      const p = loaded();
      return scanLaunchIds(p.stateDir)
        .map((id) => readLaunch(p.stateDir, id))
        .filter((l): l is Launch => l !== null);
    },
    getLaunch(id) {
      return readLaunch(loaded().stateDir, id);
    },
    listQueue(opts) {
      const p = loaded();
      const all = listProposals(p.stateDir);
      const shown = opts?.all ? all : all.filter((x) => x.status === "open");
      return {
        open: shown,
        errors: all.filter((x) => x.kind === "coordinator_error" && x.status === "open"),
      };
    },
    async approve(proposalId, finalText) {
      return approveProposal({ backend: backend(), proposalId, finalText, now });
    },
    async flip(flagKey, on) {
      const p = loaded();
      await p.flagClient.ensureFlag(flagKey);
      await p.flagClient.setState(flagKey, on);
    },
    async listFlags() {
      const p = loaded();
      const keys = new Set<string>();
      for (const id of scanReleaseIds(p.stateDir)) {
        const r = readRelease(p.stateDir, id);
        if (r?.flag) keys.add(r.flag);
      }
      const out: { key: string; state: FlagState }[] = [];
      for (const key of [...keys].sort()) out.push({ key, state: await p.flagClient.getState(key) });
      return out;
    },
    async reconcileNow() {
      const p = loaded();
      // Acting/coordination command → enforce the same multi-app Pro gate the CLI does.
      enforceMultiApp(p.apps.length, getEntitlement()); // throws when >1 app & unlicensed
      // Transitions only: flag poll, no publicity, no ASC, no network.
      return reconcile({ backend: backend(), sources: [flagPollSource(p.flagClient)], now });
    },
    async reconcileFull() {
      const p = loaded();
      // Full cron-parity cycle. The multi-app Pro gate + config-selected publisher (invariant #5)
      // live inside runFullReconcile, so the console can't fire an offline publisher where a live
      // one is configured.
      return runFullReconcile({ org: p.org, apps: p.apps, backend: backend(), stateDir: p.stateDir, canonDir: p.canonDir, now });
    },
  };
}
