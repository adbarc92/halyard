# Halyard — Codebase Digest (for agents)

> Audience: an agent integrating with / extending / owning this code.
> Source: `9c503c7` · 2026-06-15 · branch `feat/web-console-auth` · digested by reading the
> root manifests, all launch docs, the web-auth design, and mapping `src/`, `web/`, `tests/`,
> `.github/`, `apps/` (structure read; a few internals inferred and marked).
> Purpose of this digest: **ownership / extension** (guide the operator-facing launch and any
> further hardening). Verified: `npm run typecheck` clean; `npm test` **317 pass**; `npm run
> web:test` **74 pass**.

## TL;DR
Halyard is an **event-driven, git-backed release + publicity coordinator** for a multi-app
shop (iOS / Android / web / desktop), written in TypeScript (Node ≥20, ESM, Zod, Vitest). It is
**not a pipeline**: it is a durable state machine whose coordinator is a *projection* of
external truth (App Store Connect, the flag provider, Sentry, GitHub). The one thing to know:
**the flag flip — a human action — is the launch**, not store approval. A build ships "dark"
(`shipped_dark`, flag OFF), and flipping the flag ON projects `live` and fans out publicity.
The whole spine runs offline with zero credentials (every external port has a git-backed /
template fallback); going live means wiring real providers behind those ports and arming opt-in
toggles. Feature-complete and certified green; the only material in-flight work is the
**web-console auth boundary** on this branch (not yet merged — see Gotchas).

## Where to look (navigation index)
| I need to… | Go to |
|------------|-------|
| Understand the *why* (source of truth) | [`design.md`](../design.md) · operator manual [`README.md`](../README.md) |
| Add/route a CLI command | [`src/halyard/cli.ts`](../src/halyard/cli.ts) (`dispatch()`) |
| Change legal state transitions | [`src/halyard/coordinator/state-machine.ts`](../src/halyard/coordinator/state-machine.ts) (`LEGAL_TRANSITIONS`) |
| Change how external truth is polled | [`src/halyard/coordinator/reconcile.ts`](../src/halyard/coordinator/reconcile.ts) + [`coordinator/sources/`](../src/halyard/coordinator/sources/) |
| Change the data model | [`src/halyard/contracts/`](../src/halyard/contracts/) (`release.schema.ts`, `launch.schema.ts`, `proposal.schema.ts`, `state.ts`) |
| Add/modify a build-deploy surface | [`src/halyard/surfaces/`](../src/halyard/surfaces/) (`web.ts`/`ios.ts`/`android.ts`/`desktop.ts`) |
| Change flag-provider behavior | [`src/halyard/flags/`](../src/halyard/flags/) (`select.ts`, `file-client.ts`, `http-client.ts`) |
| Change publicity / channels | [`src/halyard/publicity/`](../src/halyard/publicity/) (`fanout.ts`, `channels.ts`, `select.ts`) |
| Change config schema/validation | [`src/halyard/config/`](../src/halyard/config/) (`*.schema.ts`, `loader.ts`) |
| Understand web-console auth | [`web/src/hooks.server.ts`](../web/src/hooks.server.ts), [`web/src/lib/server/auth.ts`](../web/src/lib/server/auth.ts), [`web/src/lib/server/loopback.js`](../web/src/lib/server/loopback.js) |
| Wire a real launch (operator) | [`docs/LAUNCH.md`](LAUNCH.md) · readiness [`docs/LAUNCH-READINESS.md`](LAUNCH-READINESS.md) · cold-start [`docs/LAUNCH-HANDOFF.md`](LAUNCH-HANDOFF.md) |
| Embed Halyard as a library | [`docs/INTEGRATION.md`](INTEGRATION.md) · root export [`src/halyard/index.ts`](../src/halyard/index.ts) |

## Architecture
**Shape:** a single npm package (`halyard`) with one workspace (`web`). The library spine is
project-agnostic; per-project differences live in `apps/<slug>/app.yml` + secrets. CI workflows
and a SvelteKit console are additional consumers of the same library.

| Unit | Path | Purpose |
|------|------|---------|
| Coordinator library | `src/halyard/` | The spine: state machine, reconcile engine, stores, gates, publicity, agents (CLI bin: `halyard`) |
| Web console | `web/` | SvelteKit operator UI (status, queue, flag flip, launches, releases) — imports the library |
| Workflows | `.github/workflows/` | ci, release, reconcile, maintenance, sentry-alert |
| App config | `apps/<slug>/app.yml` | Per-app surfaces/flags/triage/channels (`apps/aurora` is the reference) |
| Org config | `halyard.config.yml` | Coordinator backend, approval webhook, drafting model, channel registry |
| State (records) | `state/` | Git-backed JSON: `releases/ launches/ proposals/ flags/ publicity/ notifications/` |
| Voice canon | `canon/voice/` | Accreting corpus of approved posts (brand-voice moat) |
| Mobile lanes | `fastlane/` | iOS + Android `test/build/upload` (Ruby) |
| Scripts | `scripts/` | `demo.ts`, `verify-launch.ts`, `issue-license.ts`, `commit-state.sh`, `smoke/` |

**Entry points:** library API → [`src/halyard/index.ts`](../src/halyard/index.ts); CLI →
[`src/halyard/cli.ts`](../src/halyard/cli.ts) (`dispatch(argv)`, script guard at bottom); web →
[`web/server.js`](../web/server.js) (fail-fast bind guard → adapter-node `build/index.js`),
request gate [`web/src/hooks.server.ts`](../web/src/hooks.server.ts).

## Key flows
### Release (`halyard release run --app --surface --version`)
`cli.ts dispatch` → load org+app config (`config/loader.ts`) → new `Release` (state `tagged`) →
surface adapter `build`/`test`/`deploy` (`surfaces/*`) → deterministic `gates.ts`
(`buildGate`/`testGate`) → on success transition toward `uploaded` (or auto-promote `live` for
web) → write to `state/releases/` → exit non-zero if `dead`.

### Reconcile (cron `*/20`, or `halyard reconcile`)
`reconcile.ts` scans release IDs → for each release, each `ReconcileSource` (`sources/asc-review`,
`play-review`, `flag-poll`, sentry triage) `appliesTo?`→`poll()`→`TransitionProposal[]` →
`applyTransition()` enforces **dedup + legality** → graduation proposes flag removal after the
stable window → publicity fires on `live` → `commit-state.sh` commits only changed records.
One bad poller is isolated; the sweep continues and exits non-zero with a `::warning::`.
The shared cycle lives in [`src/halyard/orchestration/full-reconcile.ts`](../src/halyard/orchestration/full-reconcile.ts) (`runFullReconcile`).

### Flip = launch (`halyard flip --flag <key> --state on`, human)
Flag client (`flags/select.ts` → file or HTTP) `setState(on)` → next flag-poll projects
`shipped_dark → live` → `publicity/fanout.ts`: owned channels auto-publish (light gate),
third-party `social_post` proposals stage to the queue for human `approve`. Rollback = flip OFF
→ `rolled_back`; re-flip returns to `live#2` and publicity does **not** re-announce.

## Contracts (integration surface)
### CLI commands ([`src/halyard/cli.ts`](../src/halyard/cli.ts))
| Command | Purpose |
|---------|---------|
| `release run --app --surface --version [--commit]` | Single release: build→test→deploy (exits non-zero on `dead`) |
| `reconcile [--apps]` | Poll external truth, apply transitions, fire publicity/agents |
| `launch create --app --feature --title [--narrative] [--tier] [--announce]` | Create launch; flag born OFF; drafts narrative seed if omitted |
| `launch link --launch --release` | Bind a release to a launch |
| `flip --flag --state on\|off [--app]` | The human launch moment / rollback |
| `status [--stuck] [--release]` | Why a release is where it is / what it waits on |
| `queue [--all]` · `approve --proposal [--text]` | Approval queue; approve feeds voice canon (never auto-posts) |
| `triage [--apps]` | Out-of-band crash triage (Sentry → proposal) |
| `maintenance [--apps]` | Cert / deadline / Renovate watchers |
| `payments verify [--apps]` | Read-only payment-config check |
| `preflight [--apps] [--probe off]` | Production-readiness across every integration (gates a deploy) |
| `license` | Show entitlement (tier, features, expiry) |

### Web console (SvelteKit) — `web/src/routes/`
Pages: `/` (board), `/launches[/:id]`, `/queue`, `/flags`, `/releases`, `/login`, `/logout`.
API (JSON-only bodies): `POST /api/approve`, `POST /api/flip`, `POST /api/reconcile`,
`POST /api/reconcile-full`; `GET /health` (200 ok / 503 error / `degraded` on service-backend).

### Library exports — [`src/halyard/index.ts`](../src/halyard/index.ts)
Public API grouped by milestone M0–M8 (config+contracts, surfaces+coordinator, reconcile+state
machine, ASC poll, launch/flag split, publicity+approval, agents, maintenance, voice canon).
Engine is dependency-injected with a `SecretStore` hook — see [`docs/INTEGRATION.md`](INTEGRATION.md).

### Data shapes — [`src/halyard/contracts/`](../src/halyard/contracts/)
`Release` (`release_id`, `app`, `surface`, `version`, `state`, `flag?`, `transitions[]` with
dedup keys, `external_refs`); `Launch` (`launch_id`, `feature`, `title`, `narrative_seed`,
`tier`, `announce_policy`, `releases[]`, `flag`); `Proposal` (`kind` ∈ flag_removal | hotfix |
rejection | social_post | cert_alert | deadline_alert | dep_update; `status` open/approved/
rejected). **States** (`state.ts`): `tagged → built → tested → uploaded → in_review →
shipped_dark → live → rolled_back`; any pre-live → `dead`; `rejected→in_review` resubmit loop;
`rolled_back→live` re-flip loop.

### Config & environment
| Var / toggle | Required? | Notes |
|---|---|---|
| `HALYARD_APPROVAL_WEBHOOK` | for real launch | Mobile approval surface; unset → `FileNotifier` |
| `HALYARD_LIVE_FLAGS` + app `flags.api_url` + key | to observe launch | else git-backed `FlagFileClient` |
| `HALYARD_LIVE_PUBLISH` + endpoints | owned auto-publish | else `FilePublisher` (local record) |
| `HALYARD_LIVE_MERGE` (repo var) + `GITHUB_TOKEN` | auto-merge | else `DryRunMergeClient` |
| `ANTHROPIC_API_KEY` | optional (Pro) | LLM drafters/classifier; else templates/rules |
| `HALYARD_LICENSE_KEY` | optional | Ed25519-signed; unlocks AI agents / auto-merge / multi-app |
| iOS: `MATCH_*`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | per surface | release + reconcile poll |
| Android: `PLAY_SERVICE_ACCOUNT` (→ `SUPPLY_JSON_KEY_DATA`) | per surface | |
| Web: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | per surface | |
| `SENTRY_AUTH_TOKEN` | for triage | + app `triage.sentry.*` |
| `HALYARD_CONSOLE_TOKEN` | to expose web non-loopback | console-process secret (NOT a `SECRET:NAME` ref); `openssl rand -hex 32` |
| `HOST` / `PORT` / `ORIGIN` / `HALYARD_BASE_PATH` | web | `web:start` sets `HOST=127.0.0.1`, `ORIGIN=http://$HOST:$PORT`; base-path is build-time |

All `SECRET:NAME` config refs resolve from env at runtime (`secrets/resolve.ts`); **a raw value
in a secret field is rejected at config load**.

## Build · run · test
Package manager: **npm** (`package-lock.json`; `web` is a workspace). Pulled from `package.json`.
- Install: `npm install` (runs `prepare` → `npm run build`)
- Typecheck: `npm run typecheck` *(verified clean)*
- Build: `npm run build` (`tsc -p tsconfig.build.json` → `dist/` ESM + d.ts)
- Test (core): `npm test` → **317 pass** *(verified)*; coverage gate: `npm run test:coverage`
- Test (web): `npm run web:test` → **74 pass** *(verified)*
- Dry runs: `npm run verify:launch` (fakes) · `npm run demo` (real adapters, temp dir)
- Web: `npm run web:dev` (Vite) · `npm run web:build` + `npm run web:start` (prod, loopback)
- CLI: `npm run halyard -- <args>` or `tsx src/halyard/cli.ts <args>`

## Gotchas & invariants
- **The five invariants are load-bearing — never violate** (enforced in code + tests):
  (1) coordinator is a projection, never authority; (2) gates are deterministic booleans — no
  model decides ship/promote/flip/post; (3) every transition has an idempotent
  `(release_id + transition)` dedup key; (4) config holds `SECRET:NAME` refs, never values —
  never write a real credential to a file/record/log/URL; (5) owned vs third-party is the
  publicity boundary — owned auto-publishes, third-party only *stages* for a human.
- **Web-console auth is the one open work item.** Historically the console had *no auth* (safe
  only because it binds loopback). This branch (`feat/web-console-auth`, **not yet merged / no
  PR**) adds a `HALYARD_CONSOLE_TOKEN` boundary: no-token+loopback = open dev; no-token+
  non-loopback or any `x-forwarded-*` = refused (bind guard exits, hook 403s); token set =
  `/login` session cookie for browsers, `Authorization: Bearer` for proxies/machines. Three
  critique rounds resolved 24 findings (CSRF/origin on http-loopback, Secure-on-https only,
  random opaque session ids, open-redirect `next` sanitization). Design:
  [`docs/superpowers/specs/2026-06-15-web-console-auth-design.md`](superpowers/specs/2026-06-15-web-console-auth-design.md).
- **`npm run <script> -- --flag x` can swallow args in some shells.** Fall back to
  `npx tsx scripts/<file>.ts --flag x`.
- **Operator drives all outward/irreversible actions** — the real `halyard flip`, tag pushes,
  third-party posts. An agent guides; it does not flip a real flag or post on its own.
- **Multi-app is Pro.** Unscoped `reconcile`/`maintenance` over >1 app fails loudly on the free
  tier (by design) — set `HALYARD_LICENSE_KEY` or scope with `--apps <slug>`.
- **iOS reaches `shipped_dark` only after an App Store *version* is submitted for review**; a
  brand-new app needs metadata/screenshots in App Store Connect for the first submission. If it
  sits at `uploaded`, check the version actually entered review.
- **Single-operator state writes:** don't run the console alongside a reconcile cron writing the
  same `stateDir`. Workflows commit only their own changed records (rebase+retry) via
  `commit-state.sh`. The console never git-commits — that's the operator's / CI's job.
- Mutating `/api/*` routes must keep **`application/json`-only** bodies (CSRF invariant).

## Open questions / unverified
- Exact line numbers inside `cli.ts`/`reconcile.ts` come from a structural map, not a
  line-by-line read — treat command-routing line refs as approximate (open the file to confirm).
- `npm run demo` / `npm run verify:launch` were **not run** for this digest (test suites were);
  the launch docs report both green as of PR #44.
- No live external provider (ASC, Play, Sentry, Cloudflare, flag provider) was exercised — by
  design these are covered in CI/production, not the offline suite.
