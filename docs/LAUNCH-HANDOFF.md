# Hand-off — guiding the operator through Halyard's real launch

You (the agent reading this) are taking over to walk the operator through taking an app **live**
with Halyard. The system is **built, tested, documented, and certified** — this is *execution*,
not engineering. Don't rebuild anything; guide the operator through the runbook and keep the
invariants intact.

## 30-second context

Halyard is an event-driven, git-backed release + publicity **coordinator** for a multi-app
shop. The core idea: **the flag flip — not store approval — is the launch.** A release ships
"dark" (built/approved, flag OFF); flipping the flag ON is the launch moment; publicity fires
on that transition. Full rationale: [`design.md`](../design.md); operator manual:
[`README.md`](../README.md).

### The five invariants — load-bearing, never violate
1. The coordinator is a **projection**, never authority.
2. Gates are **deterministic booleans** — no model decides ship/promote/flip/post (agents only
   draft/classify into a queue; a human approves; code executes).
3. Every transition has an idempotent `(release_id + transition)` dedup key.
4. Config holds **secret references** (`SECRET:NAME`), never values — never write a real
   credential to a file, record, log, or URL.
5. **Owned vs third-party is the publicity boundary** — owned channels auto-publish; third-party
   social only stages for human approval. Never auto-post to a third-party API.

If a shortcut would break one of these, don't take it — surface it to the operator instead.

## Current state (as of hand-off)

- Feature-complete; all PRs merged through **#45**. `main` certified green:
  `npm run typecheck`, `npm run test:coverage` (**317 core tests**, coverage gate), `npm run
  web:test` (**74 console tests**), `npm run verify:launch` (✅ 12/12), and `npm run demo` (real
  spine → `live`).
- Nothing remains to build for launch. The items once deferred are now all **built, tested, and
  merged**: the desktop (Tauri) surface, the `service` backend, web auto-promote, the
  production-track Android review poll — plus the full reconcile cycle and the web console.
  None are launch-blocking; they are available if a launch needs them.
- The web console now has **authentication** (PR #45): a `/login` session flow, `/logout`, a
  fail-fast bind guard, and root gated to empty before auth — closing the former loopback-only
  no-auth gap. It is still not required for launch.

## Resuming: onboarding the first real app (iOS) — picks up here

The 2026-06-19 session scoped the first launch to **a new iOS app** and re-certified `main` green
(317 core + 74 web tests, `verify:launch` 12/12). The operator did **not** yet have the app
identifiers; they will supply them **this session**. So your first concrete step is to **scaffold the
app config**, not to re-derive scope.

1. Collect from the operator (they expect to have these now): app **name + slug**, **`bundle_id`**,
   **`asc_app_id`** (ASC numeric app ID — may still be a placeholder if the app isn't registered in
   App Store Connect yet), and **`team_id`** (10-char Apple Developer team ID).
2. Scaffold `apps/<slug>/app.yml` with the **iOS surface only**, copying the shape of
   [`apps/aurora/app.yml`](../apps/aurora/app.yml) and pruning Android/web/desktop. Identifiers go in
   as values the operator gives; credentials stay as `SECRET:NAME` refs (`MATCH_REPO`, `ASC_API_KEY`
   — never real values, invariant #4). **If a `halyard app init` / onboarding command exists by now
   (roadmap item R-ONBOARD in [`ROADMAP.md`](ROADMAP.md)), use it instead of hand-writing the YAML.**
3. `halyard preflight --probe off` (config-only) → fix structural gaps; then set the iOS secrets and
   `halyard preflight` for live reachability. iOS reaches `shipped_dark` only after a version is
   submitted for review (see Gotchas) — a brand-new app needs metadata/screenshots in ASC first.

If you're resuming cold, run the re-certify in "Your first actions" first; otherwise it was just run.

## Your first actions

1. Re-certify the checkout (cheap, catches drift):
   ```bash
   npm ci && npm run build && npm run typecheck && npm test
   ```
2. Ask the operator two things: **which app** and **which surfaces** (iOS / Android / web) this
   first launch covers. Skip integrations they aren't shipping.
3. Run readiness — this is the worklist:
   ```bash
   halyard preflight --probe off     # config-only (before secrets are in env)
   halyard preflight                 # add live reachability once secrets are set
   ```
   Paste/inspect the JSON; go **one integration at a time** until every required row is green.

## The runbook you're following

[`LAUNCH.md`](LAUNCH.md) is the ordered, phased playbook (preflight → configure → dry-run →
create launch → ship dark → **flip** → approve posts → watch → rollback → post-launch). Each
phase has the exact command, owner, and a "done when" signal. Supporting references:

- [`LAUNCH-READINESS.md`](LAUNCH-READINESS.md) — secrets-by-integration, the armed-vs-default
  toggle matrix, the go/no-go checklists, the test ladder.
- [`OBSERVABILITY.md`](OBSERVABILITY.md) (Sentry + the out-of-band `sentry-alert` path),
  [`PAYMENTS.md`](PAYMENTS.md), [`LICENSING.md`](LICENSING.md), [`SMOKE.md`](SMOKE.md) (live
  smoke checks), [`DEMO.md`](DEMO.md) (`npm run demo`), [`INTEGRATION.md`](INTEGRATION.md).

## Gotchas (read before you start)

- **The operator drives outward/irreversible actions.** You guide; *they* run the real
  `halyard flip`, the tag push, and any third-party post. Confirm before anything outward-facing.
- **Secrets:** only ever set them in the environment / GitHub secret store. Never paste a real
  credential into `app.yml`/`halyard.config.yml` (those take `SECRET:NAME` refs only).
- **Multi-app is Pro.** If the operator coordinates >1 app, either set `HALYARD_LICENSE_KEY`
  (the signing private key is held by the operator offline, not in the repo) or scope every
  acting command with `--apps <slug>`. Unscoped `reconcile`/`maintenance` over >1 app fails
  loudly on the free tier — that's by design, not a bug.
- **iOS reaches `shipped_dark` only after an App Store *version* is submitted for review.** The
  `upload` lane does this (`upload_to_app_store(submit_for_review:true, automatic_release:false)`),
  but a brand-new app needs metadata/screenshots present in App Store Connect for the first
  submission. If iOS sits at `uploaded`, check that the version actually entered review.
- **`npm run <script> -- --flag x` can swallow args in some shells.** If a script reports a
  missing flag, run it directly: `npx tsx scripts/<file>.ts --flag x`.
- **Rollback = flip the flag OFF** (`halyard flip --state off`) → `rolled_back`. Re-flipping ON
  returns to `live` (recorded `live#2`); publicity does **not** re-announce.
- **Repo conventions (operator's global rules):** never push to `main` — branch + PR; no
  `Co-Authored-By` lines and no "Generated with…" attribution in commits/PRs.

## What NOT to do

- Don't provision real accounts or invent/guess secret values — the operator supplies those.
- Don't flip a real flag, push a release tag, or post to a third-party channel on your own.
- Don't disable a gate, auto-post third-party, or relax an invariant to "make it work."

## Command cheat-sheet

```bash
halyard preflight [--apps <slug>] [--probe off]      # readiness
halyard license                                       # entitlement (Pro features)
npm run verify:launch        |  npm run demo          # dry runs (fakes / real adapters)
halyard launch create --app <slug> --feature <f> --title <t>   # flag born OFF
halyard launch link --launch <id> --release <id>
git tag <surface>-v<version> && git push origin <surface>-v<version>   # ship dark
halyard status [--stuck] [--release <id>]             # why a release is where it is
halyard flip --flag <key> --state on  --app <slug>    # THE LAUNCH (operator runs this)
halyard queue && halyard approve --proposal <id> --text "..."   # third-party posts (human)
halyard flip --flag <key> --state off --app <slug>    # ROLLBACK
```
