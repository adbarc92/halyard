# Full Reconcile in the Web Console (F1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extract a shared `runFullReconcile` helper (the whole cron cycle) that the CLI `reconcile` and the web console both call, and add a console `reconcileFull()` + button so the console can drive the full cycle (not just the flag poll). (Per [the design](../specs/2026-06-11-full-reconcile-design.md).)

**Architecture:** New composition layer `src/halyard/orchestration/full-reconcile.ts` (above coordinator/agents/publicity) owns the cycle: Pro gate, scheduled sources, reconcile, graduation, publicity (config-selected publisher — invariant #5), triage, rejection, coordinator-error proposals. The CLI `reconcileRun` becomes a thin formatter; the console adds `reconcileFull()` + `/api/reconcile-full` + a button and keeps the lightweight `reconcileNow()`.

**Tech Stack:** TypeScript (ESM/NodeNext, strict + `noUncheckedIndexedAccess`), Vitest, SvelteKit (web).

---

## File structure

**Create:**
- `src/halyard/orchestration/full-reconcile.ts` — `runFullReconcile` + `FullReconcileReport` + the moved `chooseTriageClassifier`/`triageAllApps`/`chooseRejectionDrafter`.
- `tests/full-reconcile.test.ts` — helper integration tests.
- `tests/reconcile-cli.test.ts` — CLI stdout-shape guard.
- `web/src/routes/api/reconcile-full/+server.ts` — the full-reconcile route.

**Modify:**
- `src/halyard/index.ts` — export `runFullReconcile` + `FullReconcileReport`.
- `src/halyard/cli.ts` — `reconcileRun` delegates + legacy-JSON remap; delete the three moved helpers; rewire `triageCmd` to import `triageAllApps` from orchestration; remove now-unused imports.
- `web/src/lib/server/console-service.ts` — add `reconcileFull()` + the interface method.
- `web/src/routes/+page.svelte` — a "Full reconcile" button.
- `web/tests/console-service.test.ts` (or a new web test) — `reconcileFull()` coverage.

**Dependency order:** orchestration module + export (T1) → cli refactor + stdout test (T2) → console + route + button (T3) → verify + PR (T4). T2 depends on T1 (imports `runFullReconcile`); T3 depends on T1 (barrel export).

All commands run from repo root. **You are on branch `docs/full-reconcile-design`** (carries design + this plan; commit implementation here so it bundles into one PR). Verify with `git rev-parse --abbrev-ref HEAD`. No attribution lines in commits.

---

### Task 1: The `runFullReconcile` orchestration module

**Files:**
- Create: `src/halyard/orchestration/full-reconcile.ts`
- Modify: `src/halyard/index.ts`
- Test: `tests/full-reconcile.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/full-reconcile.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFullReconcile } from "../src/halyard/orchestration/full-reconcile.js";
import { loadOrgConfig, loadAppConfig } from "../src/halyard/config/loader.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { newRelease, appendTransition } from "../src/halyard/coordinator/record-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = loadOrgConfig(resolve(here, "..", "halyard.config.yml"));
const aurora = loadAppConfig(resolve(here, "..", "apps", "aurora", "app.yml"));

let stateDir: string;
const now = () => "2026-06-11T00:00:00.000Z";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-fullrec-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); delete process.env.HALYARD_LIVE_PUBLISH; delete process.env.HALYARD_LIVE_FLAGS; });

describe("runFullReconcile", () => {
  it("on an empty project returns a zeroed report and does not throw", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    const r = await runFullReconcile({ org, apps: [aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now });
    expect(r.reconcile.scanned).toBe(0);
    expect(r.graduationProposals).toBe(0);
    expect(r.publicityFanouts).toBe(0);
    expect(r.triageProposals).toBe(0);
    expect(r.rejectionProposals).toBe(0);
  });

  it("projects an uploaded web release with its flag ON to live (offline, FilePublisher)", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    // Seed a standalone web release at `uploaded`, bound to a flag that is ON in the file provider.
    let rel = newRelease({ releaseId: "rel_aurora_web_1.0.0", app: "aurora", surface: "web", version: "1.0.0" });
    rel = { ...rel, flag: "launch.aurora.test" };
    for (const to of ["tagged", "built", "tested", "uploaded"] as const) rel = appendTransition(rel, to, "ci", now);
    await backend.records.write(rel);
    await new FlagFileClient(stateDir, now).setState("launch.aurora.test", true);

    const r = await runFullReconcile({ org, apps: [aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now });

    expect((await backend.records.read("rel_aurora_web_1.0.0"))!.state).toBe("live");
    expect(r.reconcile.applied.some((a) => a.to === "live")).toBe(true);
    // counts are numbers (publicity may be 0 — the release is launch-less, so firePublicity sees no launch)
    expect(typeof r.publicityFanouts).toBe("number");
  });

  it("enforces the multi-app Pro gate (throws for >1 app unlicensed)", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    await expect(
      runFullReconcile({ org, apps: [aurora, aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now }),
    ).rejects.toThrow(/Pro feature/i);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/full-reconcile.test.ts`
Expected: FAIL — cannot find module `orchestration/full-reconcile.js`.

- [ ] **Step 3: Write the orchestration module**

```ts
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
```

- [ ] **Step 4: Export from the package root**

In `src/halyard/index.ts`, after the coordinator section (near the `reconcile` export), add:
```ts
// Full reconcile orchestration (F1)
export { runFullReconcile, triageAllApps, type FullReconcileReport } from "./orchestration/full-reconcile.js";
```
(`triageAllApps` is exported because `cli.ts`'s `triageCmd` imports it — Task 2.)

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run tests/full-reconcile.test.ts && npm run typecheck`
Expected: PASS (3 tests); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/halyard/orchestration/full-reconcile.ts src/halyard/index.ts tests/full-reconcile.test.ts
git commit -m "feat(orchestration): runFullReconcile shared cycle helper"
```

---

### Task 2: CLI delegates to the helper

**Files:**
- Modify: `src/halyard/cli.ts`
- Test: `tests/reconcile-cli.test.ts`

- [ ] **Step 1: Write the failing test (stdout-shape guard — net-new)**

```ts
// tests/reconcile-cli.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/halyard/cli.js";

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-reccli-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("reconcile CLI stdout shape", () => {
  it("prints the legacy snake_case report keys", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await dispatch(["reconcile", "--state-dir", stateDir, "--apps", "aurora"]);
    expect(code).toBe(0); // empty project, no source errors

    const out = JSON.parse(lines.join("\n"));
    expect(out).toMatchObject({
      scanned: 0,
      graduation_proposals: 0,
      publicity_fanouts: 0,
      triage_proposals: 0,
      rejection_proposals: 0,
    });
    expect(Array.isArray(out.applied)).toBe(true);
    expect(Array.isArray(out.errors)).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/reconcile-cli.test.ts`
Expected: PASS already, OR FAIL if the current JSON differs — run it to capture the baseline. (If it passes pre-refactor, that's fine: it then locks the shape THROUGH the refactor. The point is it must stay green in Step 5.)

- [ ] **Step 3: Refactor `reconcileRun` to delegate**

In `src/halyard/cli.ts`, replace the entire `reconcileRun` function body (everything between its `{` and its closing `}`) with:
```ts
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
```

- [ ] **Step 4: Delete the moved helpers + rewire `triageCmd` + clean imports**

- Delete `chooseTriageClassifier`, `triageAllApps`, and `chooseRejectionDrafter` from `cli.ts` (they now live in `orchestration/full-reconcile.ts`). **Keep `chooseNarrativeDrafter`** (used by `launch create`).
- `triageCmd` calls `triageAllApps` — add it to the orchestration import: at the top of `cli.ts`, add
  `import { runFullReconcile, triageAllApps } from "./orchestration/full-reconcile.js";`
- Remove imports that are now unused in `cli.ts` (TypeScript with the project's settings will flag them; run `npm run typecheck` and delete each reported unused import). Likely now-unused: `buildReconcileSources`, `estimateCronIntervalMs`, `makeCronDuePredicate`, `reconcile`, `proposeFlagGraduations`, `reconcileProposal`, `firePublicity`, `makeDrafter`/`makePublisher`, `readVoiceCanon`, `runTriage`, `LiveSentryClient`, `RuleTriageClassifier`, `AnthropicTriageClassifier`, `TriageClassifier`, `runRejectionResponses`, `AnthropicRejectionDrafter`, `TemplateRejectionDrafter`, `RejectionDrafter`, `makeFlagClient`, `enforceMultiApp`. **Do NOT remove** anything still used by `releaseRun`, `triageCmd`, `maintenanceCmd`, `launchCmd`, `flipCmd`, etc. — e.g. `makeNotifier` (triage/maintenance still build a notifier), `makeBackend`, `loadApps`, `gateMultiApp` (triage/maintenance still gate), `getEntitlement`/`tryResolveSecret` (chooseNarrativeDrafter), `Notifier`/`Backend`/`AppConfig` types. Let `npm run typecheck` be the guide — remove exactly what it reports as unused, nothing more.

- [ ] **Step 5: Run typecheck + the full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; **all tests green** — `reconcile-cli.test.ts` (stdout shape), the existing `cli-dispatch`/`e2e` tests, and `tests/full-reconcile.test.ts` all pass. The `triage` command path still works (it imports `triageAllApps` from orchestration).

- [ ] **Step 6: Commit**

```bash
git add src/halyard/cli.ts tests/reconcile-cli.test.ts
git commit -m "refactor(cli): reconcile delegates to runFullReconcile; rewire triage command"
```

---

### Task 3: Console `reconcileFull()` + route + button

**Files:**
- Modify: `web/src/lib/server/console-service.ts`
- Create: `web/src/routes/api/reconcile-full/+server.ts`
- Modify: `web/src/routes/+page.svelte`
- Test: `web/tests/console-service.test.ts` (append)

- [ ] **Step 1: Write the failing test** — append to `web/tests/console-service.test.ts`:

```ts
describe("console service reconcileFull", () => {
  it("runs the full cycle and returns a report (flag-on release projects to live)", async () => {
    const { root, stateDir } = seedProject();
    const { newRelease, writeRelease, FlagFileClient } = await import("halyard");
    writeRelease(stateDir, {
      ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }),
      flag: "launch.demo.beta",
    });
    await new FlagFileClient(stateDir, fixedClock()).setState("launch.demo.beta", true);

    const svc = createConsoleService({ root, now: fixedClock() });
    const report = await svc.reconcileFull();

    expect(report.reconcile.applied.some((a: { to: string }) => a.to === "live")).toBe(true);
    expect(typeof report.triageProposals).toBe("number");
  });
});
```
(Use whatever `seedProject` helper the existing web tests use; `fixedClock` already exists in that file. If `seedProject`'s demo app has no `triage` block, prefer `seedProject`'s existing complete fixture — match how `reconcileNow` is tested in the same file.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run build && npm run -w web test -- console-service`
Expected: FAIL — `svc.reconcileFull` is not a function.

- [ ] **Step 3: Add `reconcileFull()` + the interface method**

In `web/src/lib/server/console-service.ts`:
- Add to the imports from `"halyard"`: `runFullReconcile` and the type `FullReconcileReport`.
- Add to the `ConsoleService` interface (after `reconcileNow`):
  ```ts
  reconcileFull(): Promise<FullReconcileReport>;
  ```
- Add the method to the returned object (next to `reconcileNow`):
  ```ts
  async reconcileFull() {
    const p = loaded();
    // Full cron-parity cycle. The multi-app Pro gate + config-selected publisher (invariant #5)
    // live inside runFullReconcile, so the console can't fire an offline publisher where a live
    // one is configured.
    return runFullReconcile({ org: p.org, apps: p.apps, backend: backend(), stateDir: p.stateDir, canonDir: p.canonDir, now });
  },
  ```

- [ ] **Step 4: Add the route**

```ts
// web/src/routes/api/reconcile-full/+server.ts
import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST() {
  try {
    const report = await service().reconcileFull();
    return json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/Pro feature/i.test(message)) throw error(403, message);
    throw error(500, message);
  }
}
```

- [ ] **Step 5: Add the button**

In `web/src/routes/+page.svelte`, add a `reconcileFull` handler mirroring `reconcile` (Step references the existing `reconcile()` at lines 10-22):
```svelte
  async function reconcileFull() {
    busy = true;
    try {
      const res = await fetch(`${base}/api/reconcile-full`, { method: "POST" });
      if (!res.ok) {
        alert(await errorMessage(res, "full reconcile failed"));
        return;
      }
      await invalidateAll();
    } finally {
      busy = false;
    }
  }
```
And add the button next to the existing "Reconcile now" one (in `.page-actions`):
```svelte
      <button class="btn btn-primary btn-sm" onclick={reconcileFull} disabled={busy}>
        {busy ? "Running…" : "Full reconcile"}
      </button>
```

- [ ] **Step 6: Run build + web tests + check**

Run: `npm run build && npm run -w web test && npm run -w web check`
Expected: build clean; web tests pass (incl. the new `reconcileFull` test + the unchanged `reconcileNow` test); svelte-check 0 errors.

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/server/console-service.ts web/src/routes/api/reconcile-full/+server.ts web/src/routes/+page.svelte web/tests/console-service.test.ts
git commit -m "feat(web): console full reconcile (reconcileFull + route + button)"
```

---

### Task 4: Full verification + PR

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npx vitest run && npm run build && npm run -w web test && npm run -w web check`
Expected: typecheck clean; root suite green (incl. `full-reconcile`, `reconcile-cli`); build clean; web tests green; svelte-check 0 errors.

- [ ] **Step 2: Open the PR (bundles design + plan + implementation)**

```bash
git push -u origin docs/full-reconcile-design
gh pr create --base main --title "feat: full reconcile in the web console (F1)" --body "Implements F1 per docs/superpowers/specs/2026-06-11-full-reconcile-design.md (design + plan included). Extracts runFullReconcile into a new orchestration/ layer that the CLI reconcile and console both call; CLI becomes a thin formatter; console adds reconcileFull() + /api/reconcile-full + button, keeps reconcileNow(). Pro gate + config-selected publisher (invariant #5) inside the helper. Hardened through 3 critique rounds."
```

---

## Notes for the implementer
- **The helper never builds a backend** — callers pass a constructed `Backend` (CLI's `makeBackend`, console's memoized `backend()` with its `fetchFn` seam). Do not add `makeBackend` inside `runFullReconcile`.
- **One notifier instance** — build `makeNotifier` once in the helper and thread it to `firePublicity`, `triageAllApps`, and the coordinator-error loop (do not construct a second).
- **Sweep instant** — `new Date(now())` from one `now()` snapshot (not `new Date()`), so an injected clock makes review-poll due-ness deterministic.
- **Pro gate** — inside `runFullReconcile` (`enforceMultiApp` directly, not the private `cli.ts` `gateMultiApp`). `reconcileNow()` keeps its own explicit gate; do not remove it.
- **No engine/source/agent/schema change** — this is composition + a console consumer. If you find yourself editing `coordinator/reconcile.ts`, the sources, the agents, or any schema, stop — you've left the design.
- **Import hygiene in cli.ts** — after deleting the moved helpers, remove exactly the imports typecheck reports as unused; keep everything `releaseRun`/`triageCmd`/`maintenanceCmd`/`launchCmd` still use.
