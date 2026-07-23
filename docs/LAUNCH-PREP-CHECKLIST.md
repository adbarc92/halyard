# Halyard — Remaining Launch-Prep Checklist

> Source: `9c503c7` · 2026-06-15 · branch `feat/web-console-auth`.
> Companion to [`CODEBASE-DIGEST.md`](CODEBASE-DIGEST.md) + [`TEST-PLAN.md`](TEST-PLAN.md).
> Consolidates the open items from [`LAUNCH-HANDOFF.md`](LAUNCH-HANDOFF.md),
> [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md), and [`LAUNCH.md`](LAUNCH.md) into one ordered
> worklist. **The system is built and certified green** (391 tests) — what remains is *finishing
> the one open code item*, then *operator-driven wiring and execution*.

Legend: **[code]** = engineering work in this repo · **[ops]** = operator wires secrets/accounts
/ runs the live action (agents guide, don't execute) · **[verify]** = a check, not a change.

---

## A. Finish the one open engineering item — web-console auth
This branch closes the launch-status memory's known gap ("web console has no auth"). It is the
**only** non-merged code item; nothing else needs building for launch.

- [ ] **[verify]** Core + web suites green: `npm run typecheck && npm test && npm run web:test` (expect 317 + 74). *(verified green this session)*
- [ ] **[verify]** Run the 7 manual auth checks in [`TEST-PLAN.md`](TEST-PLAN.md) Rung 1b (loopback open, non-loopback refused, `x-forwarded-*`→403, token login, Bearer, CSRF, base-path).
- [ ] **[code]** Confirm docs match behavior: [`web/README.md`](../web/README.md) auth section + [`docs/INTEGRATION.md`](INTEGRATION.md) embed contract (`Authorization: Bearer`, proxy env, JSON-only CSRF invariant).
- [ ] **[ops]** Open a PR `feat/web-console-auth → main` (never push to main directly; no attribution footer), get it green in CI, merge. Re-certify `main`: `npm ci && npm run build && npm run typecheck && npm test`.

## B. Coordinator readiness (one-time) — operator wiring
From [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md) §1. Arm one integration at a time; each unset
toggle degrades to a safe local default.

- [ ] **[ops]** `HALYARD_APPROVAL_WEBHOOK` set; a test notification reaches your phone. *(not optional — a gate you can't reach isn't a gate)*
- [ ] **[ops]** At least one surface fully wired (secrets + `app.yml`) and a real release reaches `uploaded`.
- [ ] **[ops]** iOS: ASC review poll authenticates (no `::warning::` in reconcile logs) — needs `ASC_KEY_ID`/`ASC_ISSUER_ID`/`ASC_PRIVATE_KEY` + `bundle_id`/`asc_app_id`/`team_id`.
- [ ] **[ops]** Android: `PLAY_SERVICE_ACCOUNT` (→ `SUPPLY_JSON_KEY_DATA`) + `package`/`track`/`service_account_ref`.
- [ ] **[ops]** Web: `CLOUDFLARE_API_TOKEN`/`CLOUDFLARE_ACCOUNT_ID` + `deploy.project`/`prod_url`.
- [ ] **[ops]** Flag provider authenticates and `flags.api_url` is set, with `HALYARD_LIVE_FLAGS=1` (else the launch moment can't be observed).
- [ ] **[ops]** Sentry auth + project wired, threshold set, alert rule → `sentry-alert` (see [`OBSERVABILITY.md`](OBSERVABILITY.md)).
- [ ] **[ops]** Owned publish endpoints (`BLOG_PUBLISH_URL`/`EMAIL_SEND_URL`) reachable **before** arming `HALYARD_LIVE_PUBLISH` (start it off; dry-run via `FilePublisher`).
- [ ] **[ops]** `commit-state.sh` can push to `main` (workflow `contents: write`; + `pull-requests: write` if auto-merge).
- [ ] **[verify]** Crons in `reconcile.yml` / `maintenance.yml` match `halyard.config.yml`.
- [ ] **[ops]** Coordinating **>1 app**? Set `HALYARD_LICENSE_KEY` (multi-app is Pro) or scope every acting command with `--apps <slug>` (unscoped fails loudly on free tier — by design).
- [ ] **[ops]** Web console: if exposing beyond loopback, set `HALYARD_CONSOLE_TOKEN` (`openssl rand -hex 32`); behind a proxy also set `ORIGIN` + forwarded-header env per [`web/README.md`](../web/README.md).
- [ ] **[verify]** `halyard preflight` (probe on) exits 0 for the target app — the one-stop gate for everything above.

## C. Optional integrations (only if the first launch uses them)
- [ ] **[ops]** Payments: wire `payments.api_key_ref`'s key; `halyard payments verify` passes (read-only) — [`PAYMENTS.md`](PAYMENTS.md).
- [ ] **[ops]** Drafting agents: `ANTHROPIC_API_KEY` + Pro (else deterministic templates).
- [ ] **[ops]** Auto-merge maintenance: repo var `HALYARD_LIVE_MERGE` + `GITHUB_TOKEN` + cert/deadline/Renovate env.
- [ ] **[ops]** Desktop (Tauri) surface if shipping it (GitHub Releases).

## D. Pre-launch dress rehearsal (no accounts gambled)
- [ ] **[verify]** `npm run verify:launch` (fakes) green.
- [ ] **[verify]** `npm run demo` (real adapters, temp dir) reaches `live` — closest local proxy to a real launch.
- [ ] **[verify]** Per-integration live smoke (Rung 3 of [`TEST-PLAN.md`](TEST-PLAN.md)): approval, flag round-trip (delete the test flag after), `sentry-alert` dispatch, `reconcile` dispatch (exit 0, no `coordinator_error`).
- [ ] **[verify]** Rollback rehearsed: flip OFF → next reconcile projects `rolled_back`; re-flip → `live#2`, publicity does **not** re-announce.

## E. Per-launch go / no-go (repeat for each launch)
From [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md) §2 — run immediately before flipping ON.

- [ ] **[ops]** `halyard launch create …` done — flag **born OFF** in the provider.
- [ ] **[ops]** Release linked (`halyard launch link`) and at `shipped_dark` (iOS) or `uploaded` (web/Android).
- [ ] **[verify]** `halyard status --release <id>` shows `waiting_on: flag flip` (not stuck earlier).
- [ ] **[ops]** Narrative seed reviewed/edited (auto-drafted from recent commits if not supplied).
- [ ] **[verify]** Channels for the tier correct (`launch` tier unlocks HN/PH; `standard` doesn't).
- [ ] **[ops]** Triage threshold (`crash_free_users_pct`) set; you'll get a proposal, not an auto-action, on a spike.
- [ ] **[ops]** Available for the post-flip window (flip and every third-party post are human acts).
- [ ] **[ops] THE LAUNCH:** `halyard flip --flag <key> --state on --app <slug>` → next reconcile projects `live`; owned channels auto-publish, third-party staged to `halyard queue`.

## F. Post-launch watch
- [ ] **[verify]** `halyard status` + `halyard queue` after flip; approve third-party posts (`halyard approve --proposal <id> --text "…"`) — then post them yourself.
- [ ] **[ops]** Rollback one command away: `halyard flip --flag <key> --state off --app <slug>`.

---

## Hard guardrails (never break, even to "make it work")
The five invariants ([`design.md`](../design.md), enforced in code + tests):
1. Coordinator is a **projection**, never authority.
2. Gates are **deterministic booleans** — no model decides ship/promote/flip/post.
3. Every transition has an idempotent `(release_id + transition)` dedup key.
4. Config holds `SECRET:NAME` **references**, never values — no credential in a file/record/log/URL.
5. Owned auto-publishes; **third-party only stages for a human** — never auto-post to a third-party API.

Agents guide; the **operator** runs every outward/irreversible action (real flip, tag push,
third-party post). Don't provision accounts, invent secret values, disable a gate, or relax an
invariant.

---

## Status summary
| Bucket | State |
|---|---|
| Engineering | **Complete** except web-console auth (this branch, green, needs manual auth checks + PR/merge) |
| Automated tests | **391 green** (317 core + 74 web), typecheck clean — verified 2026-06-15 |
| Coordinator wiring (§B) | Operator TODO — one integration at a time, gated by `halyard preflight` |
| Live smoke + rehearsal (§D) | Operator TODO — no accounts gambled |
| First real launch (§E/§F) | Operator-driven; rollback always one command away |
