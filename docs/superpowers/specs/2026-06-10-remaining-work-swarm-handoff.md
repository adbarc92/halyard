# Handoff — remaining work (post feature-complete)

**Authored 2026-06-09 for the 2026-06-10 session.** Supersedes the now-executed
[`2026-06-09-deferred-leaf-lanes-handoff.md`](./2026-06-09-deferred-leaf-lanes-handoff.md)
(desktop + Android prod Play poll — shipped as PRs #29/#30/#31) and the executed
[`2026-06-08-web-console.md`](../plans/2026-06-08-web-console.md) plan (web console — PR #28).

## The honest state of the tree (read this first)

Halyard is **feature-complete.** M0–M8 of the design build-order are all implemented in real
code — not stubs:

- **M0–M5** spine: config/contracts, web/iOS/Android/desktop surfaces, git-backed coordinator +
  reconcile + state machine, flags + launch/release split, publicity fan-out.
- **M6** agents: `src/halyard/agents/triage/*` (anthropic-classifier, rule-classifier,
  sentry-client, triage-runner), `agents/rejection/*`, `agents/narrative/*`.
- **M7** maintenance: `src/halyard/maintenance/*` (cert-watch, deadlines, renovate, providers).
- **M8** voice canon: `src/halyard/publicity/{canon-store,voice-canon,draft-prompt,*-drafter}.ts`.
- **Web console** (`web/` workspace, PR #28), **desktop surface** (PR #30), **Android
  production Play review poll** (PR #31).

A whole-tree audit (two parallel read agents + direct grep) found only **four** genuinely
unbuilt things, three of which resist parallelization:

| Remaining item | Evidence it's unbuilt | Shape |
|---|---|---|
| **Service backend** (`backend: service`) | `src/halyard/config/backend.ts` hard-throws; only `git` wired | **Spine-wide / serial.** Collides with every persistence caller. |
| **Web auto-promote** (`promote_gate: false`) | `promote_gate` is in `app-config.schema.ts:118` but **read nowhere** | **Spine / needs design.** Making web go `live` without a flag flip contradicts invariant #3 and `ReleaseSchema`'s "`live` requires a non-null flag." Not mechanical wiring. |
| **Full reconcile orchestration in the web console** | `web/.../console-service.ts:98-104` `reconcileNow()` is flag-poll-only | **Dependent.** Needs a shared `reconcileRun` extraction in the library first (spine prep), then a thin web consumer. |
| **Per-surface poll cron** (`review_poll_cron`) | in `app-config.schema.ts:68` but **read nowhere**; reconcile uses only org cron | **Leaf.** Isolated to reconcile scheduling. |
| **Live flag provider in the web console** | `web/.../project.ts:44` hardcodes `FlagFileClient` | **Leaf (web).** Select `HttpFlagClient` when the app config declares `flags.api_url`. |
| **Sub-path embedding of the web console** | `web/svelte.config.js` has no `paths.base` | **Leaf (web).** Mount under `/halyard/*` for dashboard embedding. |

**Consequence for parallelism:** the cleanly-swarmable surface is genuinely thin — **two**
non-overlapping leaf lanes (one in `src/halyard`, one in `web/`). The highest-value item
(service backend) is explicitly *not* swarmable as-is; it gets its own interface-first session
(see the forward roadmap). This handoff does **not** manufacture false-independent lanes — that's
the failure mode the swarm method exists to prevent.

---

## Tomorrow's dispatch-ready batch (run these two in parallel)

Both lanes are independent by construction — Lane 1 lives entirely in `src/halyard/`, Lane 2
entirely in the `web/` npm workspace. **Zero write-overlap.** Any merge order.

### Rules of the road (apply to BOTH lanes)

1. **Stay in your lane.** Write only the files your lane *owns*. Need a change elsewhere? Record
   it as a contract request in your final report — do not make it.
2. **Worktree per lane**, branch `feat/<lane>`. Never commit to `main`; open a PR.
3. **Preserve the five invariants.** (1) Coordinator is a projection, never an authority.
   (2) Gates are deterministic booleans — no model decides ship/promote/flip/post. (3) Every
   transition carries a `(release_id + transition)` dedup key. (4) Config holds `SECRET:NAME`
   references, never values — resolved at runtime, never logged. (5) Owned-vs-third-party is the
   publicity safety boundary.
4. **No scope widening.** Build only your lane's items. Report anything else you find.
5. **Verify before claiming done.** Run the lane's Verify command and paste real output.
6. No `Co-Authored-By` lines, no "Generated with…" attribution in commits/PRs.

---

### Lane 1 — Per-surface review-poll cron   ·   ready

- **Scope:** Honor each surface's `review_poll_cron` so a review poll (ASC for iOS, Play for
  production Android) only runs when that surface's schedule is due, instead of every source
  firing on every org-level sweep. Today `app-config.schema.ts:68`'s `review_poll_cron` is parsed
  and ignored; the org-level `coordinator.reconcile_cron` drives the whole sweep.
- **Owns (exclusive write):**
  - `src/halyard/coordinator/sources/index.ts` (gate per-surface poll sources by due-ness when
    assembling them — or pass a "due predicate" in)
  - a new small pure helper, e.g. `src/halyard/coordinator/schedule.ts` (new — "is this cron due
    at time T given last-run?") + its registration
  - `src/halyard/cli.ts` (the `reconcile` command path that builds sources — wire the clock/last-
    run through; **touch only the reconcile dispatch, nothing else in this large file**)
  - `tests/poll-schedule.test.ts` (new)
- **Reads (no write):** `src/halyard/coordinator/reconcile.ts` (the engine + `ReconcileSource`
  contract — do not change its signature), `sources/asc-review.ts` / `sources/play-review.ts`
  (the sources being scheduled), `sources/flag-poll.ts` (the flag poll is **not** surface-cron-
  gated — it must keep running every sweep; only the *review* polls are scheduled),
  `app-config.schema.ts` (the `review_poll_cron` field + `CronSchema`), `.github/workflows/
  reconcile.yml` (how the sweep is invoked).
- **Shared contract:** none in this batch. `sources/index.ts` is yours alone here.
- **Build notes:**
  - Keep the "is cron due" decision a **pure, deterministic function** (mirror the codebase's
    client-vs-mapping split) — input: a cron string + a reference time (+ optionally a last-run
    marker) → boolean. The reconcile engine stays surface-agnostic; the scheduling decision lives
    at source-assembly time, not inside `reconcile()`.
  - The flag poll and any non-review source must be **unaffected** — only ASC/Play review polls
    are gated. A surface with no `review_poll_cron` (web/desktop) registers no review poll anyway.
  - **Invariant #1 stays intact:** skipping a poll this sweep is a no-op, never a transition. A
    skipped poll on a stable record changes nothing (idempotency preserved).
  - Decide where "last run" comes from. Simplest correct option: derive due-ness purely from the
    wall-clock vs the cron's cadence within the sweep window (no new persisted state). If you find
    you need a persisted last-run timestamp, that's a **contract request** against the state dir —
    record it, don't invent a new on-disk format unilaterally.
- **Done when:** with a fixture app whose iOS `review_poll_cron` is (say) `*/30 * * * *`, a sweep
  at a non-due minute registers/runs no ASC poll for it, a sweep at a due minute does; the flag
  poll runs in both; everything is driven by a pure due-function under test with a fake clock.
- **Verify:** `npx vitest run tests/poll-schedule.test.ts && npm run typecheck`
- **Open questions:** whether due-ness should be windowed (sweep runs every 20m, surface cron is
  30m → which sweeps count as "due"?) — pick the simplest defensible rule (a poll is due if its
  cadence has elapsed since the sweep-window start) and document it; whether to thread a persisted
  last-run (prefer not — see build notes).

---

### Lane 2 — Web console: live flag provider + sub-path embedding   ·   ready

> Two web-console follow-ups co-located in one lane because they share the `web/` route/layout
> domain and would collide if split across agents. One agent, both features.

- **Scope:**
  - **(a) Live flag provider in the UI.** The console's `flip`/`listFlags` currently always use
    the git-backed `FlagFileClient` (`web/src/lib/server/project.ts:44`). Select the library's
    `HttpFlagClient` instead **when the app config declares `flags.api_url`** (the same selection
    the CLI/reconcile workflow already makes), so the console flips a real remote-config provider,
    not just the local file. Credentials come from env (`flags.api_key_ref` → runtime), never
    logged — invariant #4.
  - **(b) Sub-path embedding.** Let the console mount under a URL sub-path (e.g. `/halyard/*`) for
    embedding in a larger dashboard, via SvelteKit `paths.base`, driven by an env var
    (`HALYARD_BASE_PATH`), defaulting to root (`""`) so the standalone case is unchanged.
- **Owns (exclusive write):**
  - `web/src/lib/server/project.ts` (flag-client **selection** — widen `LoadedProject.flagClient`
    to the `FlagClient` interface; construct Http vs File by config)
  - `web/src/lib/server/console-service.ts` (only if `flip`/`listFlags` need an `ensureFlag`/
    method tweak for the Http client; keep `reconcileNow` exactly as-is — full orchestration is
    out of scope, see roadmap)
  - `web/svelte.config.js` (add `kit.paths.base`)
  - `web/src/app.html`, `web/src/routes/+layout.svelte` (use `base` from `$app/paths` for the
    nav/asset links so they survive a sub-path mount)
  - any `web/src/routes/**/+page.svelte` whose **internal `href`s are hardcoded absolute**
    (prefix with `base`) — this is yours because no other tomorrow-lane touches `web/`
  - `web/test/…` new tests (mirror the existing web test setup)
- **Reads (no write):** `src/halyard/flags/index.ts` + `flags/http-client.ts` + `flags/types.ts`
  (the `FlagClient` interface, `HttpFlagClient`, and any `makeFlagClient`/selection helper the CLI
  uses — **mirror that selection; do not fork it**), `web/src/routes/flags/*` and
  `web/src/routes/api/flip/+server.ts` (callers of the flag client),
  [`2026-06-08-web-console-design.md`](./2026-06-08-web-console-design.md) §"Config resolution,
  errors, security" (live-provider follow-up) and §"App-plugin contract mapping" (sub-path).
- **Shared contract:** none outside `web/`. The `FlagClient` selection logic should **reuse** the
  library's existing factory if one exists; if the CLI inlines the Http-vs-File choice and you'd
  have to copy it, record a contract request to extract a shared `makeFlagClient(app, stateDir)`
  in `src/halyard/flags/` rather than duplicating it.
- **Build notes:**
  - Keep the console's **offline/credential-free default** intact: with no `flags.api_url`, it
    must still load and work exactly as today (FileClient). The Http path activates only when
    configured. A misconfigured/unreachable provider must degrade gracefully (the project already
    has a degraded-load pattern in `project.ts`) — never crash the console, never log the key.
  - `paths.base` is **build-time** in SvelteKit. Read `HALYARD_BASE_PATH` in `svelte.config.js`;
    document that embedding requires a rebuild (note it in `web/README.md` — that file is yours).
  - Don't touch `reconcileNow()` semantics, the queue/approve flow, or the launches/releases read
    screens beyond link-prefixing for sub-path support.
- **Done when:** (a) with an app config carrying `flags.api_url`, the console's flip/list go
  through `HttpFlagClient` (proven with a fake/injected client in a test), and with no `api_url`
  it still uses `FlagFileClient`; (b) built with `HALYARD_BASE_PATH=/halyard`, the console serves
  and links correctly under that prefix, and with it unset it serves at root unchanged.
- **Verify:** `npm run -w web build && npm run -w web test` (or the web workspace's configured
  test script) **and** `npm run typecheck`. Paste real output.
- **Open questions:** whether a shared `makeFlagClient` factory already exists in the library
  (reuse it) or must be requested; whether any route pages hardcode absolute `href`s (audit and
  prefix, or confirm the layout centralizes nav); exact env-var name (`HALYARD_BASE_PATH`
  suggested — confirm nothing else claims it).

---

## Integration

1. Both lanes are workspace-disjoint (`src/halyard/` vs `web/`) — merge in any order, no
   contract-owner sequencing needed.
2. Apply any contract requests the lanes filed (e.g. a shared `makeFlagClient` extraction, or a
   persisted last-run format) against the owned library files — orchestrator's job, not the lane's.
3. Reconcile: from `main` with both merged, run `npm run typecheck && npx vitest run` and the web
   workspace build/test. Expect green with two net-new test files.

---

## Forward roadmap (after tomorrow — sequenced, not part of the parallel batch)

These are ordered. The first two are **serial spine work** (a swarm would collide with itself);
the third is the big item decomposed into its own mini-swarm; the last is net-new scope to open
only once the above is exhausted.

### R1 — Web auto-promote (`promote_gate: false`) · needs a design spike first
Not mechanical wiring. Letting a web release reach `live` on deploy *without* a flag flip
contradicts invariant #3 (the flag flip **is** the launch moment) and `ReleaseSchema`'s rule that
`live`/`rolled_back` require a non-null flag. Decide the model first (does auto-promote mean a
distinct "promoted" terminal that publicity treats like `live`? or an auto-created always-on
flag?), *then* implement across `release-runner.ts` / `state-machine.ts` / `flag-poll.ts`. Run a
`grill-me`/`brainstorming` pass before any code. Serial — it edits the same spine files a backend
change would.

### R2 — Full reconcile orchestration in the web console · prep-commit then a leaf
`reconcileNow()` is intentionally flag-poll-only today. To let the console drive the *full* cycle
(ASC/Play polls, publicity fan-out, graduation) safely, first **extract a shared `reconcileRun`**
in the library that selects the correct publisher/clients from config (a serial prep-commit in
`src/halyard/coordinator/`), then a thin `web/` lane consumes it. The publicity-publisher
selection is the dangerous part — an offline `FilePublisher` must never fire where an
`HttpPublisher` is configured (invariant #5). Mirrors the prep-commit→leaf pattern this repo
already used for the flag-poll lanes.

### R3 — Service backend (`backend: service`) · interface-first MINI-SWARM
The one large item, and the way to parallelize it is to **define the contract first, then fan
out.** Sequence:
1. **Prep (serial, solo):** extract persistence **ports** behind the current git implementation —
   `RecordStore`, `LaunchStore`, `ProposalStore`, (optionally `FlagStore`, `Ledger`, `Canon`) —
   with the existing git-backed code as the default adapter and every caller (`reconcile.ts`,
   `release-runner.ts`, `graduation.ts`, `triage-runner.ts`, `rejection-runner.ts`, `approve.ts`,
   `status.ts`, `cli.ts`) routed through the port. No behavior change; all 245 tests stay green.
   This is the shared contract every sub-lane hangs off — single owner, lands first.
2. **Fan out (parallel sub-lanes, one per store):** implement the `service` adapter for each port
   behind it — `ServiceRecordStore`, `ServiceLaunchStore`, `ServiceProposalStore`, … — each owning
   its own adapter file + tests, plus a backend-selector that reads `coordinator.backend` and
   swaps `assertSupportedBackend` for a real factory. Sub-lanes don't overlap because each owns
   one adapter. Idempotency/dedup guarantees (invariant #3) must hold under the service's
   consistency model — each sub-lane proves it for its store.
3. **Reconcile:** run the whole suite against both backends.
This turns the "serial bottleneck" into a structured swarm **once the port contract exists** —
the contract is the thing that makes the independence real.

### R4 — Widen with net-new enhancement lanes (open last, net-new scope)
Only after R1–R3. This is **beyond the documented roadmap** — net-new features to brainstorm and
size when the genuine backlog is drained. Candidate independent lanes (each isolated by the
existing port/adapter seams, so they parallelize cleanly): additional **publicity channels**
(Slack/PagerDuty/Mastodon adapters behind the channel registry), additional **flag providers** /
**monitoring vendors** (Crashlytics/Bugsnag/Datadog behind the `SentryClient` port), additional
**notifier** transports, **security/test hardening** sweeps, **observability** (structured logs/
metrics around reconcile), and **DX** (a richer `halyard status`, dashboards). Treat R4 as a
`brainstorming` input, not a fixed list — it's the place the swarm can be made arbitrarily wide,
but only with explicitly chosen new scope.

---

## Deprecated by this handoff
- [`2026-06-09-deferred-leaf-lanes-handoff.md`](./2026-06-09-deferred-leaf-lanes-handoff.md) —
  executed (PRs #29/#30/#31). Marked deprecated.
- [`2026-06-08-web-console.md`](../plans/2026-06-08-web-console.md) — executed (PR #28). Marked
  deprecated.
- The two **design** docs (`2026-06-09-deferred-leaf-lanes-design.md`,
  `2026-06-08-web-console-design.md`) are **retained** as design records — they document
  decisions, not pending work.
