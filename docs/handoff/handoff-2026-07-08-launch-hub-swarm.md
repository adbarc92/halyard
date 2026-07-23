# Handoff — Halyard one-stop launch hub: swarm shipped, PR #50 open, operator follow-up remains

**Written:** 2026-07-08  ·  **Branch:** `integration/swarm-2026-07-08`  ·  **PR:** [#50](https://github.com/adbarc92/halyard/pull/50) (base `main`)

## ⏳ Background operation in flight
None. All engineering is complete, committed, pushed, and PR'd. `npm run build`, `npm run typecheck`,
`npm test` (**451 pass**), `npm run demo` (exit 0), and `halyard preflight --probe off` (13/13 apps
ready, offline with dummy env) were all green at hand-off. Nothing is running; nothing to poll.

## Goal
Turn Halyard from a 2-target coordinator (Cloudflare Pages + GitHub Releases + fastlane) into a
multi-provider control plane for the whole portfolio — all surfaces, all real toolchains, signing,
per-app onboarding. Built from [`halyard-launch-hub-SWARM-HANDOFF.md`](../../halyard-launch-hub-SWARM-HANDOFF.md).

## State — what's done (all on branch `integration/swarm-2026-07-08`)
- **L0 shared contract** — `517a39c`. Deploy-provider registry (`src/halyard/surfaces/deploy/`),
  mobile-toolchain port (`surfaces/mobile/`, `match`|`eas`), desktop signing seam
  (`surfaces/signing/`). Adapters delegate; `deploy.target` registry-validated with per-surface guard.
- **Wave A** — `186728f`. Providers `command`/`vercel`/`fly`/`github_pages`/`itch`/`aws` (dry-run
  tested); `eas` toolchain; macOS notarize+staple (on) + Windows Authenticode (built, disabled);
  preflight `deploy:<surface>` gate (L11); Slack/Discord approval notifiers (L10, invariant #5 intact);
  `HALYARD_SELF_HOST` entitlement (L12, resolves G-LICENSE).
- **Wave B** — `8442334`. 12 apps onboarded (`apps/<slug>/app.yml`); `docs/PROVIDERS.md`,
  `docs/CREDENTIALS.md`, LICENSING self-host section, README, `scripts/demo.ts` provider-family walk.
- **In flight (uncommitted):** none — tree clean. (This handoff doc is the only new file; commit it
  with the branch so it travels with the PR.)

## Successor's next action — in order

1. **Review + merge PR [#50](https://github.com/adbarc92/halyard/pull/50)** into `main`. It cleanly
   adds 4 commits over `origin/main` (the 3 swarm commits + one small pre-existing README doc commit
   `60b7966`). All verification is local (see above) because CI may be billing-blocked — see step 2.

2. **Verify GitHub Actions CI billing (G-CI).** Historically billing-blocked; the portfolio Gate #1
   says it was restored account-wide 2026-07-07. Confirm checks actually run on this repo; if they
   don't, the unblock is the account owner's (Settings → Billing). Until then, PRs merge on local
   verification only.

3. **Cut the `v0.1.0` git tag** (the Wave-0 "free tag" item, L15) once #50 is on `main`.
   `git tag v0.1.0 && git push origin v0.1.0`.

4. **Per-app go-live (Gate #2 / G-CREDS), per app, as you actually launch it** — NOT a blocker to
   merging. Each provider's *live* leg needs real credentials as env-injected tokens (deploy tokens
   are env-only; flags/payments/Sentry/store/signing are `SECRET:` refs in `app.yml`). The exact
   env-var → provider matrix is in **[`docs/CREDENTIALS.md`](../CREDENTIALS.md)**. Flow per app:
   `halyard preflight --probe off` (config-only) → set that app's real secrets → `halyard preflight`
   (live probe) → `halyard release run …`. The 12 onboarded `app.yml` files carry `SECRET:` *placeholders*
   and plausible non-secret ids — swap real bundle ids / repos / project names when launching each.

## Live decisions / assumptions (settled here, not obvious from the diff)
- **Provider registry contract shape** (settled at L0, held stable for all lanes): `DeployProvider {
  target, configSchema (strict zod), surfaces? (omit = any), deploy(ctx, build, cfg) }`. Added an
  optional `surfaces` allowlist beyond the handoff's recommended interface, to preserve the old closed
  unions' per-surface constraint (cloudflare_pages web-only, github_releases desktop-only) — otherwise
  a passthrough registry would silently accept cross-surface targets.
- **`local_dir` unified across web+desktop** and branches on `ctx.surface` for the preview URL (web →
  `index.html`, else → the dir) to preserve exact pre-registry behavior.
- **`notary_profile`** (non-secret) added to the desktop signing schema at integration (L8 request) so
  macOS notarytool uses a keychain-profile name, never a secret in argv.
- **`cli-dispatch` reconcile exit-code test scoped to `--apps aurora`** — with 12 apps onboarded,
  multi-app *acting* (reconcile/maintenance/triage) now correctly requires the Pro/self-host
  entitlement; read-only `status`/`preflight` stay free. This is intended behavior, covered by
  `tests/self-host-entitlement.test.ts`. Set `HALYARD_SELF_HOST=1` (or a Pro key) to act across the
  whole portfolio.
- **Onboarded `prod_url` placeholders use underscores** (`https://slot_sense.example.com`) — zod
  `url()` accepts them; hyphenate to real hostnames when launching. Cosmetic only.

## Remaining optional / cosmetic (not required to launch)
- **L14 (optional, skipped):** Android Play review poll (`coordinator/sources/play-review.ts` exists
  for iOS-style ASC; add a Play equivalent only if you want `in_review→live` projection from Play truth
  rather than the flag flip). Skippable — the flag flip already drives non-production tracks.
- **Demo cosmetic:** the `scripts/demo.ts` desktop `command` step prints a leftover itch preview URL
  (display-only; the `command` provider itself returns `deploy.url ?? ""` correctly).
- **L10 follow-up (optional):** to let an operator *select* Slack/Discord from config, add a notifier
  discriminator to `org-config.schema.ts` + a branch in `publicity/select.ts` (both outside L10's file
  boundary). The presets are built, exported, and tested — just not yet wired to config selection.

## Guardrails to keep (load-bearing invariants)
No model decides ship/promote/flip (#2) · third-party social is draft-only, owned channels may
auto-publish (#5) · payments verify-only · Windows Authenticode stays deferred/off-by-default ·
secrets are `SECRET:NAME` refs (raw creds rejected at load) · runtime values go through `runner.runArgv`
(no shell), only operator-config strings use `runner.run`.
