# Halyard — Test Plan (pre-launch)

> Source: `9c503c7` · 2026-06-15 · branch `feat/web-console-auth`.
> Companion to [`CODEBASE-DIGEST.md`](CODEBASE-DIGEST.md).
> Current baseline (verified this session): `npm run typecheck` clean · `npm test` **317 pass**
> · `npm run web:test` **74 pass**. Total **391 automated tests green**.

This plan is the **test ladder** from cheapest/safest to most realistic. The first three rungs
require no credentials and gate every change; rungs 4–6 are arming/live and are gambled against
the *smallest possible blast radius* first. Nothing user-visible happens before a real flag flip.

---

## Rung 0 — Static gates (every change, CI-enforced)
| Check | Command | Pass signal |
|---|---|---|
| Typecheck (src + tests) | `npm run typecheck` | exit 0, 0 errors |
| Core suite | `npm test` | 317 pass |
| Coverage gate | `npm run test:coverage` | passes the configured threshold ([`vitest.config.ts`](../vitest.config.ts)) |
| Web suite | `npm run web:test` | 74 pass |
| Build | `npm run build` | `dist/` emits ESM + `.d.ts` |

CI (`.github/workflows/ci.yml`) runs typecheck + `test:coverage` on every PR and push to `main`.
**Gate:** all green before merging the web-auth branch or tagging any release.

## Rung 1 — Offline spine suite (what the 317 tests prove)
Zero credentials; every external port uses its git-backed / template / fake fallback. Coverage
by area (file pointers in [`tests/`](../tests/)):

| Area | Representative tests | What it proves |
|---|---|---|
| State machine | `state-machine.test.ts`, `record-store.test.ts` | Legal transitions, dedup, re-entry (`in_review#2`, `live#2`) |
| Release lifecycle | `release-runner.test.ts`, `deploy-failure.test.ts`, `m3-shipped-dark.test.ts` | build/test gates, `dead` on failure, dark-resting state |
| Reconcile | `reconcile.test.ts`, `reconcile-cli.test.ts`, `full-reconcile.test.ts`, `poll-schedule.test.ts` | idempotent polling, **source error isolation**, full cycle |
| Launch / flag | `launch-split.test.ts`, `m4-flag-flip.test.ts`, `flag-poll.test.ts`, `graduation.test.ts` | launch≠release, flip→live, flag-removal proposal after window |
| Publicity | `m5-publicity.test.ts`, `publicity-*.test.ts`, `announce-policy.test.ts`, `channel-gate.test.ts` | **owned auto vs third-party human gate**, announce policies, resilience |
| Agents (propose-only) | `m6-triage.test.ts`, `triage-*.test.ts`, `rejection.test.ts`, `narrative.test.ts`, `anthropic-agents.test.ts` | classifiers raise proposals, **never auto-act** |
| Maintenance | `m7-maintenance.test.ts`, `maintenance-*.test.ts` | cert/deadline/Renovate watchers, provider-failure resilience |
| Mobile surfaces | `ios-adapter.test.ts`, `ios-release.test.ts`, `android-adapter.test.ts`, `android-release.test.ts`, `asc-review.test.ts`, `play-review.test.ts`, `asc-map.test.ts` | Fastlane lanes, ASC/Play review polling |
| Backends | `backend.test.ts`, `service-*.test.ts` (8) | git vs service backend parity |
| Config / CLI | `config.test.ts`, `discover.test.ts`, `cli-args.test.ts`, `cli-dispatch.test.ts` | Zod validation, secret-ref rejection, command routing |
| Licensing / payments / preflight | `licensing.test.ts`, `payments.test.ts`, `preflight.test.ts`, `service-preflight.test.ts` | entitlement, read-only verify, readiness gating |
| Secrets / invariants | `secret-*.test.ts`, `security-batch.test.ts`, `hardening.test.ts`, `reentrancy-deep.test.ts`, `fetch-timeout.test.ts`, `audit-fixes.test.ts` | **no secret written to record/log/URL**, deep re-entrancy, timeouts |
| End-to-end | `e2e.test.ts` | full spine tag → live → triage → rollback in-suite |

**The five invariants each have explicit coverage** (see `security-batch`, `channel-gate`,
`triage-*` no-autoaction, `secret-*`, `reconcile` projection). Re-run on every change.

## Rung 1b — Web console suite (the new auth boundary)
[`web/tests/`](../web/tests/) — 74 tests, 10 files. Critical for the in-flight auth work:

| File | Covers |
|---|---|
| `loopback.test.ts` | `isLoopbackAddress` (IPv4-mapped IPv6 `::ffff:127.0.0.1`, `::1`, ranges), `looksProxied` (each forwarded header → true; `ORIGIN` → false), `bindGuard` truth table |
| `auth.test.ts` | `sanitizeNext` open-redirect table, `secureCookieFlag`, `parseBearer`, session create/destroy/expire (injected clock), `timingSafeEqualStr` |
| `hooks.test.ts` | every gate branch: no-token loopback→resolve, no-token+`x-forwarded-*`→403, non-loopback→403, token+Bearer→resolve, token+cookie→resolve, no-creds page→302 `${base}/login`, `/api`→401, data→401, `/login` passthrough, `route.id===null`→resolve; **asserts no Set-Cookie carries the raw token** |
| `login.test.ts` | valid token → session + Set-Cookie + redirect to sanitized `next`; invalid → `{error}`, no cookie; logout clears |
| `bind.test.ts` | `web:start` still contains `HOST=127.0.0.1` |
| `base-path.test.ts` | `HALYARD_BASE_PATH` → `kit.paths.base` baked at build |
| `api.test.ts` | `/api/*` + `/api/reconcile-full` shapes, `/health` 200 |
| `service-backend.test.ts`, `console-service.test.ts`, `flag-client-select.test.ts` | service-backend routing, console facade, live-vs-file flag selection |

**Manual auth verification before merge** (the suite can't fully exercise a live browser/proxy):
1. **No-token + loopback:** `npm run web:build && npm run web:start` → browse `http://127.0.0.1:3000` → open, no login.
2. **No-token + non-loopback refused:** `HOST=0.0.0.0 node web/server.js` (no token) → process exits non-zero, stderr warns, **no token printed**.
3. **No-token + forwarded header → 403:** curl with `-H 'x-forwarded-for: 1.2.3.4'` against the loopback server → 403.
4. **Token mode browser:** set `HALYARD_CONSOLE_TOKEN=$(openssl rand -hex 32)`, `web:start` → `/` redirects to `/login` → submit token → cookie issued (NOT `Secure` on http loopback) → board loads → "Sign out" clears.
5. **Token mode machine:** `curl -H "Authorization: Bearer $HALYARD_CONSOLE_TOKEN" .../api/...` succeeds; wrong/absent → 401.
6. **CSRF:** login form POST succeeds on http loopback (ORIGIN auto-set); a cross-site `fetch` to `/api/*` with non-JSON content-type is rejected.
7. **Base-path:** `HALYARD_BASE_PATH=/halyard npm run web:build && npm run web:start` → served under `/halyard`, all nav/login/api links prefixed.

## Rung 2 — Dry runs (no accounts)
| Command | What it walks | Pass signal |
|---|---|---|
| `npm run verify:launch` | full spine against **fakes** | pass/fail of the projection, exit 0 |
| `npm run demo` | full spine against **real adapters** in a temp dir (build → `local_dir` deploy → flip → reconcile → `live` → publicity) | reaches `live`; see [`DEMO.md`](DEMO.md) |
| `halyard preflight --probe off` | config-only readiness (offline) | every required row green, exit 0 |

## Rung 3 — Per-integration live smoke (each in isolation, nothing user-visible)
Run one integration at a time; arm nothing else. From [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md) §3 + [`SMOKE.md`](SMOKE.md):

| Integration | Smoke | Pass signal |
|---|---|---|
| Approval webhook | trigger any proposal (e.g. cert alert via `workflow_dispatch` on maintenance) | push reaches your phone |
| Flags | `halyard flip --flag test.smoke --state on/off --app <slug>` against real provider; `npm run smoke:flags` | `halyard status` / provider UI reflect it; **delete the test flag after** |
| Sentry path | `workflow_dispatch` `sentry-alert.yml` | triage pass runs; seeded spike opens a proposal |
| Reconcile | `workflow_dispatch` `reconcile.yml` | exit 0, no `coordinator_error` proposal |
| Preflight (live) | `halyard preflight` (probe on) | each required integration: configured **and** reachable, exit 0 |
| Owned publish | keep `HALYARD_LIVE_PUBLISH` **off**; inspect `FilePublisher` records | drafts look right *before* arming |
| Payments | `halyard payments verify` | provider auth OK (read-only) |

## Rung 4 — Staged real launch
Lowest-stakes app/surface, smallest audience. Run the per-launch go/no-go
([`LAUNCH-READINESS.md`](LAUNCH-READINESS.md) §2), flip ON, watch `halyard status` + `halyard
queue`, keep rollback (`flip --state off`) one command away.

---

## Exit criteria for "launch-ready"
- [ ] Rungs 0–2 fully green (391 automated tests + dry runs).
- [ ] Web-auth branch: suite green **and** the 7 manual auth checks pass, then merged via PR.
- [ ] Rung 3 smoke passed for **every integration the first launch actually uses** (skip ones not shipping).
- [ ] `halyard preflight` (live) exits 0 for the target app.
- [ ] Rollback rehearsed at least once (flip OFF → `rolled_back` → re-flip → `live#2`, no re-announce).

## Notes / known limits
- Live external providers (ASC, Play, Sentry, Cloudflare, real flag provider, Anthropic agents)
  are **not** in the offline suite — they're exercised only in CI/production behind their ports.
- `test:coverage` enforces a threshold; a coverage drop fails CI even if tests pass.
- Some shells swallow `npm run <s> -- --flag`; use `npx tsx scripts/<file>.ts` directly.
