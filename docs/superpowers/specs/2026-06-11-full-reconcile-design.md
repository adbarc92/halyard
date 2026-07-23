# Design — full reconcile in the web console (F1)

**Authored 2026-06-11.** Design record for F1 of the
[post-R3 roadmap handoff](./2026-06-11-post-r3-roadmap-handoff.md): let the web console drive the
**full** reconcile cycle (not just the flag poll) by extracting a shared `runFullReconcile` helper that
the CLI `reconcile` and the console both call. Unblocked by PR #40 (the config-driven
`makePublisher`/`makeNotifier`/`makeDrafter` factories). Brainstorming output; plan follows separately.

## Decisions (the two forks)

| Question | Decision |
|---|---|
| What does the console's full reconcile run? | **Full parity with the cron** — one shared `runFullReconcile` helper that the CLI `reconcile` AND the console both call: review polls (ASC/Play), flag poll, graduation, publicity fan-out, triage, rejection, and the coordinator-error proposal lifecycle. |
| How does it relate to the flag-poll-only `reconcileNow()`? | **Keep both.** `reconcileNow()` stays the lightweight "apply flag flips" action; a new `reconcileFull()` runs the complete cycle. |

## Why an extraction, not an engine change
The `reconcile` engine, the sources, the agents, and the publicity logic are **untouched**. F1 lifts the
orchestration currently inlined in `cli.ts` `reconcileRun` into a reusable function so the console
composes the exact same pieces as the cron. The one dangerous part — publisher selection (invariant #5)
— was solved by PR #40's `makePublisher(org, …)`; this design routes every caller through it.

### Layering: a new composition module, NOT under `coordinator/` (Round-1 #5)
The helper imports from `agents/` and `publicity/trigger` (firePublicity, runTriage, …). Today
`coordinator/` is the lower layer (engine + sources + stores) and `cli.ts` is the composition root that
reaches up into agents/publicity. To avoid inverting that (making the coordinator a mega-orchestrator
that depends on agents), the helper lives in a **new composition layer `src/halyard/orchestration/full-reconcile.ts`**
— above coordinator/agents/publicity, below the CLI/console entry points. No import cycle: agents/publicity
don't import orchestration back; the CLI and console import down into it.

## Architecture

### The shared helper — `src/halyard/orchestration/full-reconcile.ts`
```ts
export interface FullReconcileReport {
  reconcile: ReconcileReport;          // the raw engine report: { scanned, applied, skipped, errors }
  graduationProposals: number;
  publicityFanouts: number;
  triageProposals: number;
  rejectionProposals: number;
}

export async function runFullReconcile(opts: {
  org: OrgConfig;
  apps: AppConfig[];
  backend: Backend;
  stateDir: string;                    // offline FilePublisher/FileNotifier fallbacks
  canonDir: string;                    // resolved voice-canon dir (caller resolves vs its root)
  now: () => string;
  log?: (message: string) => void;     // default no-op
}): Promise<FullReconcileReport>;
```
Performs, in order, exactly what `reconcileRun` does today:
1. **Pro gate:** `enforceMultiApp(apps.length, getEntitlement())` directly (NOT the private `cli.ts`
   `gateMultiApp` — that helper isn't exported; the helper calls `enforceMultiApp` itself). Throws the
   `"… Pro feature …"` error for >1 app unlicensed.
2. `flagClient = makeFlagClient(apps, stateDir, now)`.
3. **Sweep instant from one clock snapshot (Round-1 #4, Round-2):** `const nowIso = now(); const sweepInstant = new Date(nowIso);` — derive the sweep instant from a single snapshot of the **injected** clock (not a fresh `new Date()`), so tests with a fixed `now` get deterministic review-poll due-ness and the engine + scheduler share one clock source. This is a deliberate consistency improvement, NOT byte-identical to today: today's `new Date()` carried sub-second precision from a *second* wall-clock read; the only divergence is sub-minute/minute-boundary jitter, which is within the scheduler's minute resolution (`isCronDue` zeroes seconds). Then
   `isReviewPollDue = makeCronDuePredicate(sweepInstant, estimateCronIntervalMs(org.coordinator.reconcile_cron, sweepInstant))`,
   `sources = buildReconcileSources(org, apps, { flagClient, isReviewPollDue })`.
4. `const report = await reconcile({ backend, sources, now, log })`.
5. `proposeFlagGraduations({ backend, now, thresholdDaysByApp, launchFlagPrefixByApp, log })`.
6. Publicity — **build the notifier ONCE and thread it everywhere** (Round-1 #9): `drafter = makeDrafter(org)`,
   `publisher = makePublisher(org, stateDir, now)`, `notifier = makeNotifier(org, stateDir, now)`,
   `voiceCanon = readVoiceCanon(canonDir)`, then `firePublicity({ … notifier … })`.
7. Triage + rejection, reusing the **same `notifier`**: `triageAllApps(...)` + `runRejectionResponses(...)`.
8. The coordinator-error proposal lifecycle (open + notify `prop_coord_<source>` on `report.errors`,
   auto-resolve recovered ones), reusing the **same `notifier`**.
9. Return `{ reconcile: report, graduationProposals, publicityFanouts, triageProposals, rejectionProposals }`.

The agent-selection helpers currently in `cli.ts` — `chooseTriageClassifier`, `triageAllApps`,
`chooseRejectionDrafter` — **move into this orchestration module**. Re-wiring this precisely (Round-2):
- `triageAllApps` is shared: it's called by `reconcileRun` **and** the out-of-band `triageCmd`
  (`cli.ts:314`). After the move, **`triageCmd` re-imports `triageAllApps` from `orchestration/`** — it
  must be rewired, not left dangling. (`chooseTriageClassifier` is only used inside `triageAllApps`, so
  it moves with it; `chooseRejectionDrafter`'s only caller is `reconcileRun`, so moving it is clean.)
- **Retype the moved helpers' `org` param (Round-3 #1):** in `cli.ts` they're typed
  `org: ReturnType<typeof loadOrgConfig>`. Moving them verbatim would force a spurious value-import of
  `loadOrgConfig` into the orchestration module just to satisfy that `typeof`. Retype the param to the
  imported `OrgConfig` (structurally identical — `loadOrgConfig` returns `OrgConfig`) and drop the import.
- **`chooseNarrativeDrafter` STAYS in `cli.ts`** — it's a near-identical sibling used by a *different*
  command (`launch create`), not by reconcile. Do NOT move it. (Only the triage/rejection selectors move.)
- **The orchestration module imports from sibling INTERNAL `.js` paths** (`../agents/…`, `../publicity/…`,
  `../coordinator/…`) — exactly as `cli.ts` does today — and NEVER from `../index.js`. That is what keeps
  the barrel's re-export of `runFullReconcile` from creating an `index.ts → orchestration → … → index.ts`
  cycle (the real cycle risk; agents/publicity not importing orchestration is necessary but not sufficient).
- **The helper NEVER constructs a backend** — the caller passes a built `Backend` (the CLI's
  `makeBackend(...)`, the console's memoized `backend()` with its `fetchFn` test seam). Do not add
  `makeBackend` inside the helper.

### What stays in `cli.ts` `reconcileRun` (CLI-only)
Parse flags, load org/apps, build backend, call `runFullReconcile`, then:
- **Emit the exact legacy JSON** (Round-1 #1): the CLI today prints
  `{ ...reconcileReport, graduation_proposals, publicity_fanouts, triage_proposals, rejection_proposals }`
  (snake_case, the raw report spread at top level). The library report is structured/camelCase, so the
  CLI formatter **explicitly maps** it to the legacy shape:
  ```ts
  console.log(JSON.stringify({
    ...r.reconcile,
    graduation_proposals: r.graduationProposals,
    publicity_fanouts: r.publicityFanouts,
    triage_proposals: r.triageProposals,
    rejection_proposals: r.rejectionProposals,
  }, null, 2));
  ```
  This remap is legitimate CLI-specific formatting — observably identical to today. **(Round-3 #2: no
  existing test currently asserts this stdout shape — `cli-dispatch.test.ts` only checks exit codes and
  `e2e.test.ts` calls the engine directly. The new test below adds a real assertion on the four
  snake_case keys, converting a phantom guard into a real one.)**
- Pass `log: (m) => console.error(m)` into `runFullReconcile` so the per-source `[reconcile]` stderr
  lines still appear (the helper's `log` defaults to no-op; the console passes none).
- Emit the GitHub `::warning::` annotations from `r.reconcile.errors` (each `SourceError` carries
  `source`, `release_id`, `message`) — separate from `log`.
- Exit code `r.reconcile.errors.length > 0 ? 1 : 0`.
- **Benign ordering note:** today the JSON prints *before* the coordinator-error proposal loop runs; in
  the extracted design the helper runs that loop, then the CLI prints. The JSON content is identical
  (the loop doesn't touch report counts); nothing asserts stdout-vs-proposal-write ordering. Documented
  so it's a conscious, harmless change.

### The console consumer — `web/src/lib/server/console-service.ts`
- **Add `reconcileFull(): Promise<FullReconcileReport>` to the `ConsoleService` interface** — importing
  `FullReconcileReport` as a **named type** from `"halyard"` (the barrel re-exports it). Note this differs
  from `reconcileNow`'s inferred `Promise<Awaited<ReturnType<typeof reconcile>>>` idiom — a named-type
  import is correct here since the report is an exported library type. Implementation: `const p = loaded();` then
  `runFullReconcile({ org: p.org, apps: p.apps, backend: backend(), stateDir: p.stateDir, canonDir: p.canonDir, now })`.
  (`LoadedProject` exposes all four — `org`, `apps`, `stateDir`, `canonDir` — confirmed. `backend()` is
  the existing memoized `makeBackend`-based helper from PR #41; the Pro gate is inside `runFullReconcile`,
  so `reconcileNow`'s explicit `enforceMultiApp` is mirrored — no separate gate needed in `reconcileFull`.)
- **Keep `reconcileNow()` exactly as today** (flag-poll-only).
- **New route `web/src/routes/api/reconcile-full/+server.ts`** (POST) calling `service().reconcileFull()`.
  It **mirrors the existing `/api/reconcile` route's error mapping** (Round-1 #3, #11): a thrown Pro-gate
  error (`/Pro feature/i`) → `error(403, …)`; a degraded-backend error (`BackendUnavailableError`, e.g. a
  service backend with no token) → the same handling the existing route gives (it inherits today's
  behavior; not a regression). A "Full reconcile" button beside the existing quick one; the existing
  reconcile button stays wired to `/api/reconcile`.

### Invariants — preserved
1. **Projection.** Engine unchanged; the helper composes existing sources/steps.
2. **Deterministic gates.** Unchanged.
3. **Dedup.** Unchanged.
4. **Secrets.** All clients via the `make*` factories — tokens resolved at runtime, never logged.
5. **Owned-vs-third-party publicity.** Publisher is `makePublisher(org, …)` for every caller (offline
   `FilePublisher` never fires where an http channel is configured; schema bars `third_party + auto`).

## Behavior & risk notes
- **Two distinct failure paths — don't conflate them (Round-2):**
  - **(a) Per-source cred failures → graceful 200 + report.** A live ASC/Play/Sentry client that fails on
    absent creds throws *inside* `source.poll`, which `reconcile` wraps per-source in try/catch and records
    as a `SourceError` — the sweep finishes, the failure surfaces as a `coordinator_error` proposal, and
    `reconcileFull` returns a report with `errors` populated (route returns 200; CLI exits 1). Review-poll
    sources also `appliesTo`-gate to in-flight iOS/Android releases, so a console project with none never
    calls ASC/Play at all.
  - **(b) Un-buildable backend → 500, same as today.** A `service` backend with no token makes the
    console's `backend()` throw `BackendUnavailableError` *before* reconcile runs. The existing
    `/api/reconcile` route maps everything except `/Pro feature/i` to **500**, so the new route does too —
    a tokenless service-backend console gets a 500 on the full-reconcile button. This is **intended and not
    a regression** (the backend genuinely can't be constructed; `BackendUnavailableError` is a private
    unexported class, so the route discriminates by the Pro-feature message only and 500s the rest). The
    operator fixes the token. Documented so the 200-vs-500 distinction is conscious.
- **`HALYARD_LIVE_PUBLISH` env override is a console-specific live-publish footgun (Round-1 #7).**
  `makePublisher` returns the live `HttpPublisher` whenever that env var is set, *regardless of channel
  config* — bypassing the invariant-#5 config reasoning. The console is a long-lived, operator-facing
  process that may inherit a deploy env. **Deployment guidance:** do NOT set `HALYARD_LIVE_PUBLISH` in the
  console server's environment; rely on config-driven http channels (the proper mechanism). Documented as
  an explicit operational risk; scrubbing the env in-code is out of scope (the override is intentional CLI
  back-compat).
- **Full reconcile fires the same real integrations the cron does** — the operator's deliberate, gated
  action (the console already flips flags and approves proposals). `reconcileNow()` stays the cheap path.

## Testing
- **Helper integration test** (`tests/full-reconcile.test.ts`, git backend + temp dir, no `HALYARD_LIVE_*`,
  injected fixed `now`): seed a launch + a `shipped_dark`/`uploaded` release with its flag ON, run
  `runFullReconcile`, assert the release reaches `live`, a publicity fan-out occurred, and the report
  counts are right. Assert invariant #5 **behaviorally** — with no http channel configured, the publish
  landed in the **file** publisher's output (no network), not via `instanceof`. Assert the Pro gate
  throws for >1 app unlicensed (entitlement stubbed).
- **CLI parity + a NEW stdout-shape guard (Round-3 #2):** existing reconcile + e2e tests stay green
  (`reconcileRun` delegates). Add a real assertion — drive `reconcileRun` (via `dispatch`) over a seeded
  project, capture stdout, parse the JSON, and assert it has `scanned`/`applied`/`skipped`/`errors` plus
  the four snake_case keys `graduation_proposals`/`publicity_fanouts`/`triage_proposals`/`rejection_proposals`
  with correct values. This is net-new coverage the remap depends on (no test asserts it today).
- **Console tests** (`web/tests/…`): `reconcileFull()` runs the cycle against a seeded project and returns
  the report; `reconcileNow()` unchanged; `/api/reconcile-full` returns the report JSON and maps a
  Pro-gate error to 403.
- Full root suite + `npm run build && npm run -w web test && npm run -w web check` green.

## Scope / non-goals
- **In:** `orchestration/full-reconcile.ts` (`runFullReconcile` + `FullReconcileReport` + the moved
  agent-selection helpers); the `cli.ts` `reconcileRun` refactor to delegate + the legacy-JSON formatter;
  `console-service.ts` `reconcileFull()`; `/api/reconcile-full` route + a button; the package export of
  `runFullReconcile`/`FullReconcileReport` from `index.ts`; tests.
- **Out:** any change to the `reconcile` engine, sources, agents, graduation, or publicity logic; new
  external integrations; changing `reconcileNow()`; a dry-run/preview mode; per-stage selection (full
  parity = all stages); concurrency control between a console reconcile and the cron (single-writer
  assumption holds as today; git backend has no locking — unchanged); scrubbing `HALYARD_LIVE_PUBLISH`.

## Design Critique Log

### Critique Round 1
An independent reviewer confirmed the core extraction and the safety-critical publisher routing are
sound (graceful missing-creds path, single-notifier sharing, `LoadedProject` exposes the needed fields),
and found issues that were resolved:
- **SEVERE — report key-shape mismatch.** The CLI prints snake_case keys with the raw report spread at
  top level; a camelCase library report would change the JSON. → `FullReconcileReport` is the structured
  library type; the CLI formatter **explicitly maps** it to the exact legacy snake_case JSON (documented).
- **SEVERE — `gateMultiApp` is private to `cli.ts`** and not callable from the helper; the new route had
  no Pro→403 mapping. → Helper calls `enforceMultiApp(...)` directly; the `/api/reconcile-full` route
  mirrors the existing route's 403 (and degraded-backend) error mapping.
- **SEVERE — non-injectable sweep instant** (`new Date()`) broke test determinism. → Derive
  `sweepInstant = new Date(now())` so the injected clock controls review-poll due-ness.
- **MODERATE — layering:** putting the orchestrator under `coordinator/` would invert layering (coordinator
  depending on agents/publicity). → Moved to a new composition layer `src/halyard/orchestration/`.
- **MODERATE — `HALYARD_LIVE_PUBLISH` env override** can flip the console to live-publish regardless of
  config. → Added explicit deployment guidance (don't set it in the console env) and an operational-risk
  note; in-code scrubbing left out of scope.
- **MINOR/SOUND — barrel export, single notifier, ordering, missing-creds, degraded backend** → export
  `runFullReconcile`/`FullReconcileReport`; build the notifier once and thread it; documented the benign
  print-vs-proposal ordering; documented the graceful missing-creds path; noted the new route inherits the
  existing degraded-backend behavior.

### Critique Round 2
A fresh reviewer confirmed the core extraction, layering, legacy-JSON remap completeness, the
`Date`-typed schedule signatures, the `Clock`/`now` compatibility, and the localized button addition are
all sound, and found under-specifications + two over-confident claims; resolved:
- **SEVERE — the `new Date(now())` "no observable diff" claim was wrong.** Two clock reads straddling a
  minute boundary can differ at minute granularity. → Reframed: snapshot `now()` ONCE
  (`const nowIso = now(); const sweepInstant = new Date(nowIso)`), derive the instant from the injected
  clock as a deliberate consistency improvement, and acknowledge sub-minute jitter (within the scheduler's
  minute resolution) rather than claiming identity.
- **SEVERE — moving `triageAllApps` under-specified the `triageCmd` re-wiring.** `triageAllApps` is shared
  by `reconcileRun` AND `triageCmd`. → Stated explicitly that `triageCmd` re-imports it from
  `orchestration/`; that `chooseRejectionDrafter` (sole caller `reconcileRun`) moves cleanly; and that the
  look-alike `chooseNarrativeDrafter` STAYS in `cli.ts` (do not move it).
- **MODERATE — conflated two degraded-backend paths.** → Split: (a) per-source cred failures → graceful
  200 + report.errors; (b) un-buildable service backend (no token) → 500, same as today (intended, not a
  regression; `BackendUnavailableError` is private so the route 500s the non-Pro case).
- **MODERATE — interface + barrel-cycle reasoning.** → `ConsoleService` adds `reconcileFull` importing
  `FullReconcileReport` as a named type; the orchestration module imports sibling internal `.js` paths,
  NEVER `../index.js`, so the barrel re-export creates no cycle (the real cycle risk Round 1 under-addressed).
- **MINOR — helper must never build a backend.** → Added the explicit invariant (caller owns backend
  construction + the `fetchFn` test seam).

### Critique Round 3
A final reviewer verified every load-bearing claim against the code and judged the design **ready**, with
two required edits + minor sharpenings; all applied:
- **MODERATE — moved-helper `org` type compile risk.** The `cli.ts` helpers type `org` as
  `ReturnType<typeof loadOrgConfig>`; moved verbatim that forces a spurious `loadOrgConfig` value-import.
  → Instruction added: retype the param to the imported `OrgConfig` (structurally identical) and drop the import.
- **MINOR (over-claim) — "tests assert the snake_case keys" was false.** No test covers `reconcileRun`'s
  stdout (cli-dispatch checks exit codes; e2e calls the engine directly). → Corrected the claim and added a
  **net-new stdout-shape assertion** (parse `reconcileRun`'s JSON, assert the engine fields + the four
  snake_case counts) — the remap's only real regression guard.
- **Sharpenings:** the CLI must pass `log: console.error` into the helper (its `log` defaults to no-op) so
  per-source `[reconcile]` stderr lines persist; the caller resolves `canonDir` once and passes the same
  value to `makeBackend` and the helper.
- **Confirmed sound (no change):** the byte-faithful snake_case remap (key set + order), Pro-gate placement
  (no double/missing gate), the `.length` count semantics, the `nowIso` snapshot (matches today's per-event
  `now` threading), the barrel/orchestration re-export with internal-only imports (no cycle), and the
  console interface mixing inferred + named return types. No scope creep, no missed caller, no broken test.
