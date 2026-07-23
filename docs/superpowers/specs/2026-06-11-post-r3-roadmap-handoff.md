# Handoff — next changes after R3 (service backend)

**Authored after PR #38.** Continues the roadmap in
[`2026-06-10-remaining-work-swarm-handoff.md`](./2026-06-10-remaining-work-swarm-handoff.md). **R3 (service
backend) is done** — Phase 0 ports (PR #37) + Phase 1 adapters (PR #38), git-parity, concurrency control
deferred (see [`2026-06-10-service-backend-design.md`](./2026-06-10-service-backend-design.md)). This handoff
re-audits the tree and decomposes what's genuinely next.

## The honest state of the tree (post-R3 audit)

A fresh two-agent audit (spine + web) confirms the backlog is small and mostly **serial**. Genuinely
remaining, unbuilt work:

| Item | Evidence | Shape |
|---|---|---|
| **Config-driven publicity wiring** (R2 prep) | publisher is chosen by `HALYARD_LIVE_PUBLISH` env in `cli.ts` reconcile dispatch, not config; an offline `FilePublisher` firing where an `HttpPublisher` is configured is the invariant-#5 hazard | **Spine prep** (`src/halyard`). Mirrors the `makeFlagClient` extraction. Serial-solo. |
| **Web console reads remote state** (R3 follow-up) | `web/.../console-service.ts:51` hardwires `makeGitBackend`; a `backend: service` project's console silently shows stale **local git** state | **Leaf (web).** Independent of the spine. |
| **Full reconcile in the web console** (R2) | `web/.../console-service.ts:107-113` `reconcileNow()` is flag-poll-only by design | **Dependent.** Needs the config-driven wiring prep first, then a thin web consumer. |
| **Web auto-promote** (R1, `promote_gate`) | `app-config.schema.ts:119` parsed, **read nowhere**; auto-`live`-without-flag conflicts with `ReleaseSchema`'s `live`/`rolled_back` ⇒ non-null flag rule | **Spine / needs a design spike.** Serial. |
| **Multi-writer concurrency control** (R3 deferred) | service adapters are last-writer-wins (by design); true concurrency needs optimistic locking | **Blocked.** Needs a port revision **and** the hub server to test against. |
| **The hub server itself** | greenfield (DB, deploy, auth) | **Out of repo / separate project.** |

Non-gaps confirmed (do NOT "fix" these): `coordinator.dedup` and `channels.overrides` are **inert by
design** (validated, intentionally unconsumed); `state_dir` is git-only-and-ignored-for-service by design.

**Consequence for parallelism:** the immediately-swarmable surface is **two** workspace-disjoint lanes
(one in `src/halyard`, one in `web/` — the same clean split that worked for the 2026-06-10 batch). The
higher-value items after that (R2 consumer, R1 auto-promote) are **serial** and one needs design first.
**R4 net-new** (new vendors/channels) is a genuine parallel swarm but is net-new scope, gated behind
small factory/config preps — open it only when chosen. This handoff does not manufacture false-independent
lanes.

---

## Next dispatch-ready batch (run these two in parallel)

Both lanes are independent by construction — Lane 1 lives entirely in `src/halyard/`, Lane 2 entirely in
`web/`. **Zero write-overlap. Any merge order.**

### Rules of the road (apply to BOTH lanes)

1. **Stay in your lane.** Write only files your lane *owns*. Need a change elsewhere? Record a contract
   request in your final report — don't make it.
2. **Worktree/branch per lane**, branch `feat/<lane>`. Never commit to `main`; open a PR.
3. **Preserve the five invariants.** (1) Coordinator is a projection. (2) Gates are deterministic booleans.
   (3) Every transition carries a `(release_id + transition)` dedup key. (4) Config holds `SECRET:NAME`
   refs, resolved at runtime, never logged. (5) Owned-vs-third-party is the publicity safety boundary.
4. **No scope widening.** Build only your lane's items; report anything else.
5. **Verify before claiming done.** Run the lane's Verify and paste real output (`npm run build` before web tests).
6. No `Co-Authored-By` / "Generated with" lines in commits/PRs.

---

### Lane 1 — Config-driven publicity wiring (R2 prep)   ·   ready

- **Scope:** Replace the `HALYARD_LIVE_PUBLISH`-env publisher choice with a config-driven
  `makePublisher(org)` (mirroring `flags/select.ts`'s `makeFlagClient`): return `HttpPublisher` when the
  org's channels declare resolvable `http` publish targets, else the offline `FilePublisher`. This closes
  the invariant-#5 hazard (an offline publisher firing where a live one is configured) **and** is the
  shared prep the R2 console consumer (forward roadmap) hangs off. Optionally co-locate `makeNotifier(org)`
  /`makeDrafter(org)` if their selection is likewise inlined in `cli.ts` — keep the extraction faithful
  (no behavior change for the CLI path).
- **Owns (exclusive write):**
  - a new `src/halyard/publicity/select.ts` (the `makePublisher`/`makeNotifier`/`makeDrafter` factory[s])
  - `src/halyard/cli.ts` (the **reconcile dispatch only** — replace the inlined publisher/notifier/drafter
    selection with the factory calls; touch nothing else in this large file)
  - `src/halyard/index.ts` (export the new factory[s])
  - `tests/publicity-select.test.ts` (new)
- **Reads (no write):** `src/halyard/publicity/publishers.ts` (`Publisher`, `FilePublisher`,
  `HttpPublisher`), `src/halyard/publicity/notify.ts` (`Notifier`, `FileNotifier`, `WebhookNotifier`),
  `src/halyard/flags/select.ts` (the **template** — mirror its shape, env-gate + config + token-resolve,
  degrade gracefully; do not refork it), `src/halyard/config/org-config.schema.ts` (the `channels` +
  `notifications` + `drafting` config the factory reads — do **not** change the schema unless you find you
  must, in which case it's a contract request).
- **Shared contract:** none in this batch (`cli.ts` is yours alone here; Lane 2 is web-only).
- **Done when:** with an org whose channels declare `http` publish targets + resolvable endpoints,
  `makePublisher(org)` returns an `HttpPublisher`; with none (or offline), a `FilePublisher`; proven with an
  injected/faked secret store in a test. The CLI reconcile path behaves identically to today (the full
  suite stays green — this is a behavior-preserving extraction for the CLI; the *new* capability is that the
  selection is now config-driven and reusable).
- **Verify:** `npx vitest run tests/publicity-select.test.ts && npm run typecheck && npx vitest run`
- **Open questions:** exact selection rule (recommend: `HttpPublisher` iff some enabled channel has
  `publish.type === "http"` with a resolvable `endpoint_ref`, mirroring how `makeFlagClient` keys off
  `flags.api_url` + token; `HALYARD_LIVE_PUBLISH` may remain as a force-offline test override — decide and
  document); whether to also extract notifier/drafter now (yes if cleanly inlined, else leave + note).

---

### Lane 2 — Web console: service-backend awareness (R3 follow-up)   ·   ready

- **Scope:** Make the console honor `coordinator.backend: service`. Today `console-service.ts`'s `backend()`
  hardwires `makeGitBackend`, so a service-backed project's console silently reads **stale local git** state.
  Switch it to the library's `makeBackend(org, …)` so it reads the configured backend (git **or** service).
  Preserve `loadProject`'s **never-throws / degraded-result** contract: `makeBackend` hard-fails without a
  service token, so catch that into a degraded result (the console loads, shows the degradation reason) —
  never crash, never log the token (invariant #4). This is the web-console integration the R3 design
  explicitly deferred and flagged.
- **Owns (exclusive write):**
  - `web/src/lib/server/console-service.ts` (the `backend()` helper — `makeGitBackend` → `makeBackend`)
  - `web/src/lib/server/project.ts` (only if the degraded-load needs to surface a backend-init failure —
    keep the never-throws contract; widen the degraded result if needed)
  - `web/test/…` new tests (mirror the existing web test setup; cover git-backed unchanged + service-backed
    selection + graceful degrade on missing token)
  - `web/README.md` (note: a service-backed console needs the service token in env)
- **Reads (no write):** `src/halyard/config/backend.ts` (`makeBackend` — its signature, opts, and the
  hard-fail behavior), `src/halyard/coordinator/service/*` (what the service backend does — do not change
  it), the R3 design doc §"Web console" note.
- **Shared contract:** none outside `web/`.
- **Build notes:** keep the git-backed default path byte-for-byte today (a `backend: git` project's console
  is unchanged). The service path activates only when `coordinator.backend: service`. A missing/unresolvable
  token must degrade gracefully (the project already has a degraded-load pattern), never crash, never log
  the key. Web consumes the **built `dist/`** — `npm run build` before `npm run -w web test`.
- **Done when:** a `backend: git` project's console works exactly as today; a `backend: service` project's
  console routes reads through the service backend (proven with an injected fake — reuse the
  `tests/helpers/fake-service.ts` pattern from PR #38 if importable, or a stub); a service project with no
  token loads in a degraded state rather than throwing.
- **Verify:** `npm run build && npm run -w web test && npm run -w web check && npm run typecheck`
- **Open questions:** does `makeBackend` need a `fetchFn`/seam to inject the fake in a web test (it accepts
  an optional `fetchFn` — confirm), or does the console test stub at a different layer; what the degraded UI
  should say for a token-less service project (a clear "service backend unreachable: token not set" is
  enough).

---

## Integration (this batch)

1. Workspace-disjoint (`src/halyard/` vs `web/`) — merge in any order.
2. Apply any contract requests (e.g. if Lane 1 needed an org-schema field for publisher selection) against
   the owned files — orchestrator's job.
3. Reconcile: from `main` with both merged, `npm run typecheck && npx vitest run` (expect the full suite +
   Lane 1's new test green) and `npm run build && npm run -w web test && npm run -w web check`.

---

## Forward roadmap (sequenced — not part of the parallel batch)

### F1 — Full reconcile in the web console (R2 consumer) · leaf, after Lane 1
Once Lane 1's `makePublisher`/`makeNotifier`/`makeDrafter` factories exist, add a console `reconcileFull()`
that drives the whole cycle (review polls via `buildReconcileSources`, `firePublicity`,
`proposeFlagGraduations`, `runTriage`, `runRejectionResponses`) using the **config-selected** publisher —
so it can never fire an offline publisher where a live one is configured (invariant #5). Thin `web/` lane;
blocked only on Lane 1. Gate it behind the same multi-app Pro check `reconcileNow` already uses.

### F2 — Web auto-promote (`promote_gate`) · design spike first, then serial spine
Not mechanical. Letting a web release reach `live` on deploy **without** a flag flip contradicts invariant
#3 (the flag flip *is* the launch moment) and `ReleaseSchema`'s `live`/`rolled_back` ⇒ non-null-flag rule.
Decide the model first (auto-create an always-on flag? a distinct "promoted" terminal publicity treats like
`live`? relax the schema only when `promote_gate: false`?), via a `brainstorming`/`grill-me` pass + the
3-round design-critique gate (as R3's design got), **then** implement across `release-runner.ts` /
`state-machine.ts` / `contracts/release.schema.ts` / `sources/flag-poll.ts`. Serial — it edits the same
spine F1's reconcile path and any backend change would.

### F3 — Multi-writer concurrency control (R3 deferred) · blocked on the hub server
Optimistic locking (read returns a version/ETag, write `If-Match`, caller retries on `409`). Changes the
Phase-0 **ports** (so it's its own port-revision phase) and needs a real server to test against. Blocked
until F4 exists. Until then the documented single-writer-per-project model holds (as with git).

### F4 — The hosted hub server · separate project (out of this repo)
The greenfield service that implements the [R3 HTTP contract](./2026-06-10-service-backend-design.md): DB,
auth, deploy, the whole-record-store-as-sent + ledger set-union semantics, and (for F3) the concurrency
control. Multi-week; its own spec → plan → build. Not a lane here.

### F5 — Console auth: deferred hardening (YAGNI until multi-operator) · backlog
The base console auth boundary is being built now (one shared `HALYARD_CONSOLE_TOKEN`; browser
login + opaque session cookie, `Authorization: Bearer` for proxy/machine, loopback-only when no
token, fail-closed bind — see [`2026-06-15-web-console-auth-design.md`](./2026-06-15-web-console-auth-design.md)).
The following were **deliberately scoped out** (YAGNI for the single-operator model); open only if
the console grows to genuine multi-operator / hosted use. Each is additive behind the existing
`hooks.server.ts` boundary — none requires reworking it.

- **Multi-user accounts** — per-user identities instead of one shared operator secret.
- **Roles / RBAC** — e.g. a read-only viewer vs an operator who can flip flags / approve posts.
- **Password / token rotation UI** — today rotation = restart with a new env token (no in-app flow).
- **Rate-limiting / lockout** — brute-force protection / throttling on the `/login` action.
- **OAuth / SSO** — delegate auth to the hub's IdP or an external provider (natural once F4 exists).

These pair naturally with **F4** (the hosted hub server, which brings real identity/SSO) and **F3**
(multi-writer concurrency, which only matters with multiple concurrent operators).

---

## R4 — Net-new enhancement swarm (open ONLY when net-new scope is chosen)

Beyond the documented backlog. Each new vendor/channel is an isolated adapter file behind an existing port,
so these parallelize cleanly — but two preconditions make the independence real:

- **Prep A (factory extraction, single owner, lands first):** `SentryClient` (`agents/triage/`) and
  `PaymentProvider` (`payments/`) are wired **hardcoded** (`LiveSentryClient`, `StripePaymentProvider`) — no
  selector. Extract a `make{Monitor,Payment}Client(config)` factory (mirroring `flags/select.ts`) so a new
  vendor is a registry entry, not a caller edit. (`FlagClient` and `Publisher`/`Notifier` already have
  factory-ish selection; only monitor + payments need this.)
- **Prep B (config-owner lane):** new channel/provider *types* touch `org-config.schema.ts` /
  `app-config.schema.ts` (e.g. a Slack `publish.type`, a `monitoring.provider` enum). One lane owns the
  schema; the per-vendor lanes file contract requests for their enum/field. This is the hot shared file —
  single ownership protects it.

Then the parallel per-vendor lanes (one adapter file + tests each, zero overlap): **publicity channels**
(Slack/Discord/Mastodon `Publisher`), **monitoring vendors** (Crashlytics/Bugsnag/Datadog `SentryClient`),
**notifier transports** (Slack/Teams `Notifier`), **flag providers** (LaunchDarkly/Split `FlagClient`),
**payment providers** (Square/Adyen `PaymentProvider`). Treat R4 as a `brainstorming` input — pick the
vendors that matter, run Prep A+B first, then fan out. It is the place the swarm can be made arbitrarily
wide, but only with explicitly chosen scope.

---

## Deprecated/superseded by this handoff
- The §R3 sections of [`2026-06-10-remaining-work-swarm-handoff.md`](./2026-06-10-remaining-work-swarm-handoff.md)
  and the entire [`2026-06-10-service-backend-swarm-handoff.md`](./2026-06-10-service-backend-swarm-handoff.md)
  are **executed** (PRs #37/#38). The R1/R2/R4 items there are carried forward and refined here.
