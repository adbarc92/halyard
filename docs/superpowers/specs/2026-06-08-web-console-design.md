# Halyard Web Console — Design

> Status: approved design (brainstorming output). Date: 2026-06-08.
> Next step: implementation plan (writing-plans).

## Summary

Halyard is headless today — a Node/TS ESM library + CLI over git-backed JSON state, with no
UI and no web server. This adds a **standalone SvelteKit web console** (the "head") that
imports the `halyard` library directly and surfaces its operator workflow as a UI.

The console is a first-class operator tool on its own. Because it is a normal web app served
at a URL, it also satisfies the Command Center **app-plugin contract** (web app at a URL, a
start command, a health endpoint, a clean stop, owns its viewport) for free — but it is
**designed standalone**, not tailored to Command Center.

## Goals

- A web UI for Halyard's human-gated operator workflow: release status, approval queue +
  approve, flag flip, read-only launches/releases browse, and surfacing `coordinator_error`
  notifications.
- Runs **credential-free** in dev (offline defaults: git flags, file notifier, template
  drafter).
- Usable standalone: run it inside a Halyard project, like the CLI.
- Satisfies the five app-plugin properties so it can be embedded later without rework.

## Non-goals (v1)

- Running `release run` (build → test → deploy) from the UI — pulls in shell execution and the
  riskiest write path. Deferred.
- Multi-project switching / in-app project picker. The console operates on one project (CWD).
- Git-committing state. The console writes working-tree JSON only; commit stays with the
  operator/CI.
- Dismiss action on proposals (only approve in v1; dismiss is a noted follow-up).
- Any path that bypasses Halyard's deterministic gates (no model decides ship/flip/post; the
  UI only proposes/approves/flips).
- Firing publicity from the head (owned auto-publish + third-party staging + voice canon stays
  the CLI/cron's job, which selects the correct publisher — see Reconcile scope). The head only
  *displays* the resulting proposals/announcements and approves third-party posts.

## Chosen approach vs. alternatives

**Library-backed SvelteKit (adapter-node).** One Node process serves UI + JSON API + `/health`
with one start command — a near-exact match for the plugin contract, type-safe, no stdout
parsing.

Rejected:
- **CLI-spawn + stdout parsing** — clumsy, loses types, fragile to output changes.
- **Separate React SPA + standalone API server** — two build steps, a hand-rolled static
  server, a second framework that doesn't match the Svelte 5 ecosystem of the eventual host.

## Architecture & packaging

npm workspaces. Root stays the published `halyard` library (unchanged); a new `web/` workspace
holds the console and depends on `halyard` via workspace symlink.

```
halyard/                      # root = published `halyard` library (NOT modified)
  package.json                # + "workspaces": ["web"], + web:dev / web:build / web:start scripts
  src/halyard/…               # library — head is purely additive, no library changes
  web/                        # NEW npm workspace: @halyard/web (private)
    package.json              # deps: "halyard": "*", svelte, @sveltejs/kit, @sveltejs/adapter-node, vite
    svelte.config.js          # adapter-node
    src/
      lib/server/console-service.ts   # the testable core (see "Console service")
      routes/                          # pages + /api endpoints + /health
    tests/                             # vitest, mirrors Halyard's test setup
```

- **Workspace symlink** means imports are `from "halyard"` and `zod` is deduped to one instance
  (avoids the dual-instance type-mismatch gotcha).
- **No library changes.** Everything needed is already exported from `"halyard"` (verified
  against `src/halyard/index.ts`): `loadOrgConfig`, `loadAppConfig`, `discoverAppSlugs`,
  `scanReleaseIds`, `readRelease`, `summarizeRelease`, `scanLaunchIds`, `readLaunch`,
  `listProposals`, `approveProposal`, `FlagFileClient`, `reconcile`, `buildReconcileSources`,
  plus the Zod schemas and inferred types.
- **Build dependency & ordering:** `web` imports the library's built `dist/` (the symlinked
  `halyard` package's `main` is `./dist/index.js`). Root `prepare` builds `dist/` on install,
  but workspace lifecycle ordering is not guaranteed, so `web`'s `predev` / `prebuild` runs
  `npm run build -w halyard` explicitly. The plan must verify a clean `npm ci` at root produces
  `dist/` before `web` is startable.
- **Vite SSR externalization (build-correctness, must not be skipped):** `halyard` is a
  Node-only ESM lib that imports `node:fs` / `node:crypto`, calls `fetch`, and pulls in
  `@anthropic-ai/sdk`. Vite's SSR bundler must NOT try to bundle it. `vite.config.ts` /
  `svelte.config.js` will mark `halyard` (and `@anthropic-ai/sdk`) as `ssr.external` (and
  exclude from `optimizeDeps`), and the plan verifies a production `adapter-node` build
  resolves `halyard/dist` at runtime.

### Data flow

```
Browser → SvelteKit (load / +server.ts) → console-service → halyard library → git-backed JSON (stateDir)
```

Reads validate through the schemas (`readRelease` etc.); writes go through the library's
validated writers (`approveProposal`, `FlagFileClient.setState`). The console writes
working-tree JSON only — it does not git-commit.

## Console service (the testable core)

A single plain-TS module, `web/src/lib/server/console-service.ts`, isolating all Halyard
access behind a typed interface. This is the unit driven by TDD, independent of SvelteKit.
It resolves the project once at startup and exposes:

| Function | Backed by | Notes |
|---|---|---|
| `loadProject()` | `loadOrgConfig(join(root,"halyard.config.yml"))` + `discoverAppSlugs(join(root,"apps"))` + `loadAppConfig(join(root,"apps",slug,"app.yml"))` | One resolved `root` (CWD, or `HALYARD_CONFIG_ROOT`) feeds **both** org and apps (no CWD/override split). Produces `org`, `apps`, `stateDir = resolve(root, org.coordinator.state_dir)`, `canonDir = resolve(root, org.drafting.voice_canon)`, and `flagClient = new FlagFileClient(stateDir, now)`. **Guarded:** the loaders throw a typed `ConfigError` on missing file / bad YAML / schema-invalid input — `loadProject` catches it into a degraded state (drives `/health` 503), it does not crash. Note: `discoverAppSlugs` returns `[]` (not a throw) for a missing `apps/`, so a valid org config with zero apps loads **healthy** (200, `apps: []`). |
| `listReleaseStatuses()` | `scanReleaseIds` → `readRelease` → `summarizeRelease(rel, now())` | The status-board projection (`ReleaseStatus[]`). Note: `summarizeRelease` takes `now` as a **string**, not a function — pass `now()` (invoke the clock), or `age_hours` is silently `NaN`. |
| `getRelease(id)` | `readRelease` | Full record incl. transition history. |
| `listLaunches()` / `getLaunch(id)` | `scanLaunchIds` / `readLaunch` | Read-only browse. |
| `listQueue({all?})` | `listProposals` + **service-side filter** | `listProposals(stateDir)` returns **all** proposals regardless of status — the library has no status filter. The service does it: `listProposals(stateDir).filter(p => all ? true : p.status === "open")`, and partitions out `kind === "coordinator_error"` for the board banner. One well-tested queue-projection function; a test asserts an `approved` proposal is excluded by default. |
| `approve(id, finalText?)` | `approveProposal({stateDir, canonDir, proposalId, finalText?, now})` | Human gate. Never auto-posts (invariant #5). |
| `flip(flagKey, on)` | `FlagFileClient.ensureFlag` + `.setState` | The launch/rollback human gate. |
| `reconcileNow()` | `reconcile({stateDir, sources: [flagPollSource(flagClient)], now})` | **Transitions only**, flag-poll source — projects a flipped flag to `live`/`rolled_back` with **zero network calls** (no ASC poll → credential-free dev never reaches Apple) and no publicity side effects. This is exactly the action the user scoped ("Reconcile now → flag poll"). Enforces the same multi-app Pro gate the CLI does (see "Reconcile scope"). |
| `health()` | — | `{status, root, stateDir, apps}`; unhealthy when config can't load. |

The service never bypasses Halyard's deterministic gates: it proposes/approves/flips and reads
— it cannot ship or post.

### Reconcile scope (what the head's "Reconcile now" does and does not do)

`reconcileNow()` is **transitions-only**: the engine `reconcile()` over a single flag-poll
source. The CLI's `reconcileRun` does much more *around* that call — publicity fan-out,
graduation, triage, the `coordinator_error` lifecycle — and the head deliberately does **none**
of it, for concrete safety reasons surfaced in design critique:

- **No `firePublicity` from the head.** `firePublicity` is not a pure "stage into the queue"
  step: an `owned` channel with `gate: auto` **auto-publishes immediately** (it does not stage),
  and the publisher is config-dependent — firing it with the offline `FilePublisher` in a
  project configured for a real `HttpPublisher` would silently write to local state instead of
  the real endpoint, making the operator believe an announcement went out when it didn't. It is
  also announce-policy-dependent (`all_surfaces` won't announce on a single flip). So publicity
  — including owned auto-publish and third-party staging — stays the job of `halyard reconcile`
  (CLI/cron), which selects the correct publisher and reads the real voice canon. The head
  **displays** the resulting `social_post` proposals and published announcements (read-only), and
  the operator **approves** third-party posts in the queue (the human gate, which IS in scope).
- **No ASC review polling** (would require Apple creds + network calls; omitted so
  credential-free dev is truly offline), **no Sentry triage / rejection drafts** (Pro,
  agent-gated), **no graduation proposals**, **no live flag/publish providers**.
- **Multi-app Pro gate enforced.** `reconcile` is an *acting/coordination* command, which
  Halyard's open-core model gates on > 1 app (the CLI does this in `reconcileRun`; the library
  `reconcile()` itself does not). To preserve parity and not become a licensing-bypass, the
  console checks entitlement (`getEntitlement` / `enforceMultiApp`) in the acting path: with > 1
  app and no Pro license, "Reconcile now" degrades to a clear "Pro required for multi-app
  coordination" state. `enforceMultiApp(appCount, entitlement)` **throws** (it does not return a
  flag), so the service catches it and maps it to a `403`/degraded response — it must not escape
  as an unhandled `500`. **Reads** (status board, queue, browse) and the **single-subject human
  gates** (approve one proposal, flip one flag) are free diagnostics/actions, ungated — matching
  the CLI.

This keeps the head **library-change-free** (only already-exported functions) and avoids every
side-effect hazard above. The cost: after a flip + Reconcile now, the release shows `live` in
the board, but its announcement isn't drafted until the next `halyard reconcile` (CLI/cron) —
documented in the UI. Extracting a shared, publisher-correct `reconcileRun` cycle into the
library so the head could drive the *full* orchestration is a noted follow-up, not v1.

## HTTP surface

- **Reads:** page `load` functions (server-side, type-safe) for initial render, mirrored by
  `/api/*` GET endpoints for client-side refresh.
- **Writes:** `/api/*` POST endpoints (`approve`, `flip`, `reconcile`) returning JSON; the UI
  re-fetches after a successful action.
- **`/health`:** a `+server.ts` returning `200 {status:"ok", root, stateDir, apps}`, or `503`
  when no project is loaded.
- **Server-only boundary (enforced, not just implied by path):** the console service and **all**
  `halyard` imports live under `$lib/server` and are consumed only by `+server.ts` and
  `+page.server.ts` `load`s — never by a universal `load` or a `.svelte` component. SvelteKit
  throws a build error if a client-reachable module imports `$lib/server`, which is the actual
  guarantee (the `ssr.external` config governs the SSR bundle, not the client bundle — a
  different concern). The plan adds a check that `halyard` never resolves into the client
  manifest.
- **CSRF:** SvelteKit's `csrf.checkOrigin` stays **on**. The console's own pages POST
  same-origin, so it works standalone; a webview host satisfies this by loading the console at
  its own origin (`http://localhost:<PORT>`) — exactly "point a webview at the URL" — not by
  proxying it under a different origin. Documented as a host requirement.

### App-plugin contract mapping

1. **Web app at a URL** — `http://localhost:<PORT>` (SvelteKit). ✓
2. **Start command** — `npm run web:start` → `node web/build` (dev: `npm run web:dev`).
   Non-interactive. ✓
3. **Health check** — `GET /health` → 200 when a valid project is present, 503 when config is
   missing/invalid (config-validity probe, not a warm-up window — see health semantics below). ✓
4. **Clean stop** — a single Node process; SIGTERM/SIGINT exits. Offline reconcile spawns no
   children → no orphans. ✓
5. **Owns its viewport** — routes from `/`, given the full content rect. ✓ (A host mounting it
   under a sub-path like `/halyard/*` would need SvelteKit's build-time `paths.base`; v1 targets
   the full-rect/root case, which is the contract's stated model.)

Port via `PORT` env (default `3000`, adapter-node convention). **adapter-node binds `0.0.0.0`
by default**, so the start scripts must set `HOST=127.0.0.1` to bind localhost only — Halyard
has no internal auth boundary and these endpoints mutate state / flip launch flags, so the
console must not be reachable from the LAN. The `web:start` / `web:dev` scripts set `HOST`
explicitly, and a test asserts the effective bind is loopback.

> **Health semantics:** `loadProject()` resolves synchronously at startup, so `/health` is a
> **config-validity probe**, not a transient readiness window — it returns `200` immediately
> when a valid project is present, or `503` (steadily) when config is missing/invalid. A host
> polling it sees green on the first poll once the process is up, or red until config is fixed;
> there is no loading → healthy transition to wait through.

## Screens (UX; final layout via frontend-design)

1. **Status board** (`/`) — releases as a table/cards: app · surface · version · state badge ·
   `waiting_on` · age · flag + flag_state · review_status · stuck marker. A banner surfaces open
   `coordinator_error` proposals. **Reconcile now** + **Refresh** actions.
2. **Approval queue** (`/queue`) — open proposals grouped by kind (`social_post`,
   `crash_triage`, `coordinator_error`, …) with title / body / app / severity / channel.
   **Approve** action, with an editable final-text box for `social_post`.
3. **Flags** (`/flags`) — known launch flags with current state; **flip on/off** toggle (the
   human gate), with a confirm step.
4. **Browse** (read-only) — `/releases` + `/releases/[id]` (full transition history), `/launches`
   + `/launches/[id]`.

## Config resolution, errors, security

- **Project root:** CWD by default (the CLI resolves config relative to `process.cwd()`, so
  this matches its mental model). `HALYARD_CONFIG_ROOT` is **new console-only behavior** — not
  an existing Halyard env var; the console reads it and joins it to `halyard.config.yml` /
  `apps/<slug>/app.yml` itself, passing **absolute** paths to `loadOrgConfig`/`loadAppConfig`
  (the loaders accept paths only). `stateDir` derived from `org.coordinator.state_dir`.
- **No project found:** `/health` reports `503` (steady, per health semantics above); pages
  render a clear "no Halyard project at `<root>`" state rather than crashing.
- **Action errors:** 4xx/5xx JSON with a message; UI shows an inline error / toast.
- **Flag flip uses the local git-backed `FlagFileClient`** (offline). If an operator has a live
  flag provider configured (`HALYARD_LIVE_FLAGS` + `flags.api_url`), the head's flip writes the
  local file, not the live flag — they should flip via the CLI in that case. Honoring the live
  provider in the head is a noted follow-up.
- **Concurrent writers:** the head writes working-tree JSON with no locking, same as the
  engine. Running it alongside the `reconcile.yml` cron / a CLI run writing the same `stateDir`
  can conflict (the digest flags this). v1 assumes a **single operator**; documented as a known
  limitation.
- **Security:** localhost bind (see above); trusted first-party; no secrets required (offline
  defaults). Free-tier degrades gracefully (template drafts, git flags). The one acting path
  ("Reconcile now") enforces the multi-app Pro gate to match the CLI (see Reconcile scope);
  reads and single-subject human gates are free.

## Testing

- **TDD the console service** against temp project dirs (seed an org config + app config +
  state, the same pattern as Halyard's own tests and `scripts/demo.ts`). Cover each
  reader/action including approve / flip / reconcile round-trips and the degraded no-project
  path.
- **Lighter endpoint tests** for `/health` (200 valid / 503 no-project) and the POST actions
  (invoke handlers directly), plus a test asserting the server binds loopback (`127.0.0.1`).
- **Existing Halyard tests stay green** (the library is untouched).
- **Verification before done:** build + start the head, show `/health` returning 200 and a
  served board, per the handoff's definition of done.

## Definition of done

- A URL serving the operator UI, with a documented start command, a `/health` endpoint, and a
  clean stop.
- Covers: status board, approval queue + approve, flag flip, read-only launches/releases
  browse, and surfaced `coordinator_error` notifications.
- Runs credential-free in dev against the CWD project's `stateDir`.
- README / INTEGRATION updated with: how to start it, the port, the health endpoint, the config
  root, and the `stateDir` it expects.
- Tests for the new server/API layer; existing Halyard tests stay green.

## Design Critique Log

Three independent adversarial review rounds (a fresh agent each round, each seeing the prior
round's revisions), all verifying claims against Halyard source.

### Critique Round 1

**Findings (blockers/major):**
1. **`reconcileNow` was not offline-safe.** `buildReconcileSources` adds a *live* ASC poller
   (`LiveAscClient`) for any iOS-enabled app, so credential-free dev would make Apple network
   calls / raise spurious errors.
2. **Engine `reconcile()` ≠ `halyard reconcile`.** Publicity, graduation, triage, and the
   `coordinator_error` lifecycle live in the CLI *around* the engine call, so a flip would go
   `live` with no announcement.
3. **adapter-node binds `0.0.0.0`** — the "localhost only" security claim wasn't configured.
4. (Major) Vite SSR would try to bundle the Node-only `halyard` lib; (Major) `HALYARD_CONFIG_ROOT`
   was framed as existing CLI behavior but doesn't exist; (Major) workspace build-ordering for
   `dist/` was hand-waved; (Major) `/health` 503-until-ready was semantically wrong; plus minors
   (live flag provider, concurrent writers, sub-path embed).

**Resolution:** Switched `reconcileNow` to a flag-poll source (no ASC); set `HOST=127.0.0.1` in
start scripts + a bind test; documented Vite `ssr.external`; reframed `HALYARD_CONFIG_ROOT` as
new console-only behavior with absolute-path joins; made `predev` run `npm run build -w halyard`;
reframed `/health` as a config-validity probe; added flip-live-provider, concurrent-writer, and
sub-path caveats. (Verified correct as-is: `approveProposal`/`buildReconcileSources`/loader
signatures.)

### Critique Round 2

**Findings (blockers/major):**
1. **`firePublicity` does not just "stage" — owned-`auto` channels auto-publish immediately**, and
   firing it with the offline `FilePublisher` in an `HttpPublisher`-configured project would
   silently misroute the announcement. (Round-1's fix had *added* `firePublicity` to
   `reconcileNow` — itself scope creep beyond the user's flag-poll-only choice.)
2. **Licensing bypass / false parity:** `reconcile`/`firePublicity` across `apps` skips the
   multi-app Pro gate the CLI enforces.
3. Config discovery could split org-root vs CWD apps-dir; 4. **CSRF** (`checkOrigin`) unaddressed
   and load-bearing for the embed goal; 5. server-only boundary asserted by path but not enforced
   (`ssr.external` ≠ client-bundle protection); plus `flagClient`/`voiceCanon` gaps.

**Resolution:** Reverted to **transitions-only `reconcileNow`** (no `firePublicity` from the head;
publicity stays the CLI/cron's job, which picks the correct publisher) — this matches the user's
approved scope and removes the auto-publish/misroute hazard. Added the **multi-app Pro gate** to
the head's acting path. Pinned config discovery to one resolved root for org+apps. Documented
**CSRF `checkOrigin` on** + same-origin host requirement. Made the **`$lib/server` boundary**
explicit with a client-bundle check. Added `flagClient` to service state.

### Critique Round 3

**Verdict:** solid, no blockers. Verified every round-2 fix against source — `getEntitlement()`
and `enforceMultiApp(appCount, entitlement)` are real and exported from `"halyard"`; flag-poll /
`FlagFileClient` / loader signatures all match; transitions-only reconcile is genuinely
network-free and testable in a temp dir. **Findings:** (Medium) `listProposals` has no status
filter — "open by default" is the *service's* job, not the library's; (Minor) `summarizeRelease`
takes `now` as a string (pass `now()` or get `NaN` ages); (Minor) `enforceMultiApp` throws (must
be caught → 403, not 500); (Minor) loaders throw a typed `ConfigError`, and `discoverAppSlugs`
returns `[]` so a zero-app project loads healthy. No internal contradictions remained.

**Resolution:** Clarified `listQueue` does the status filter + `coordinator_error` partition
service-side (with a test asserting `approved` is excluded by default); noted `summarizeRelease(rel,
now())`; specified the `enforceMultiApp` catch → 403 mapping; documented the `ConfigError` catch
and the empty-apps-is-healthy behavior.
