# Launch readiness — what's required to go live, and how to test it

Halyard runs fully offline by default: every external integration has a git-backed / template
/ dry-run fallback, so the whole spine is exercisable with no credentials (that's what the
460-test suite + `npm run demo` do). **Going live** means wiring the real providers behind those ports and
arming the opt-in toggles. This doc is the checklist for that, plus how to verify each path
*without* gambling a real launch.

There are two readiness questions, kept separate:

1. **Coordinator readiness** — is Halyard itself wired to act in production? (one-time)
2. **Launch readiness** — is *this specific launch* safe to flip on? (per launch)

---

## 1. Coordinator readiness (one-time)

### Toggles: armed vs. safe default

Every live integration is opt-in. Unset = the safe local default, so a half-configured
coordinator degrades visibly rather than misfiring.

| Toggle (env / repo var) | Armed | Unset (default) |
|---|---|---|
| `HALYARD_LIVE_FLAGS` + per-app `flags.api_url` + token | real flag provider (`HttpFlagClient`) | git-backed `FlagFileClient` |
| `HALYARD_LIVE_PUBLISH` + channel endpoints | owned channels POST for real (`HttpPublisher`) | `FilePublisher` (writes a local record) |
| `HALYARD_LIVE_MERGE` (repo var) + `GITHUB_TOKEN` + `pull-requests: write` | Renovate patch/minor auto-merge | `DryRunMergeClient` |
| `ANTHROPIC_API_KEY` present (+ Pro) | LLM drafters/classifier | deterministic template/rule |
| `HALYARD_APPROVAL_WEBHOOK` present | `WebhookNotifier` → your phone | `FileNotifier` (local file) |
| `HALYARD_LICENSE_KEY` (Pro) | AI agents, auto-merge, multi-app | free tier (templates, dry-run, single app) |

> The approval webhook is **not optional for a real launch** — a gate you can't reach from
> your phone isn't a gate. Set `HALYARD_APPROVAL_WEBHOOK` first.

### Secrets by integration

All resolve from the secret store at runtime (`SECRET:NAME` in config → env / your
`SecretStore`). Names below are what the code/workflows actually read.

| Integration | Secrets / config | Notes |
|---|---|---|
| **Approval surface** | `HALYARD_APPROVAL_WEBHOOK` | org `notifications.approval_channel_ref` |
| **iOS build/upload** (release.yml) | `MATCH_REPO`, `MATCH_PASSWORD`, `MATCH_GIT_BASIC_AUTHORIZATION`, `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | app.yml: `bundle_id`, `asc_app_id`, `team_id`, signing refs |
| **iOS review poll** (reconcile.yml) | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` | drives `uploaded → shipped_dark` |
| **Android** | `PLAY_SERVICE_ACCOUNT` (→ `SUPPLY_JSON_KEY_DATA`) | app.yml: `package`, `track`, `service_account_ref` |
| **Web (Cloudflare)** | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | app.yml: `deploy.project`, `prod_url` |
| **Flag provider** | `AURORA_FLAG_PROVIDER_KEY` (per app `flags.api_key_ref`) + `flags.api_url` | + `HALYARD_LIVE_FLAGS=1` |
| **Crash triage** | `SENTRY_AUTH_TOKEN`, app `triage.sentry.{org, project_ref}` | see [OBSERVABILITY.md](OBSERVABILITY.md) |
| **Owned publish** | `BLOG_PUBLISH_URL`, `EMAIL_SEND_URL` | + `HALYARD_LIVE_PUBLISH=1` |
| **Payments** | the key its `payments.api_key_ref` names | optional; see [PAYMENTS.md](PAYMENTS.md); verify with `halyard payments verify` |
| **Drafting (agents)** | `ANTHROPIC_API_KEY` | optional; Pro; falls back to templates |
| **Pro license** | `HALYARD_LICENSE_KEY` | optional; unlocks AI agents / auto-merge / multi-app — see [LICENSING.md](LICENSING.md) |
| **Maintenance** | `CERT_APPLE_DISTRIBUTION_NOTAFTER`, `CERT_APPLE_PUSH_KEY_NOTAFTER`, `CERT_AUTHENTICODE_NOTAFTER`, `PLATFORM_DEADLINES_JSON`, `RENOVATE_UPDATES_JSON`, `GITHUB_TOKEN` | + repo var `HALYARD_LIVE_MERGE` for auto-merge |
| **Release routing** | repo var `HALYARD_APP` (single-app) | or app-qualified tags `{app}-{surface}-v{version}` |

### Coordinator go-live checklist

- [ ] `HALYARD_APPROVAL_WEBHOOK` set; a test notification reaches your phone.
- [ ] At least one surface fully wired (secrets + app.yml) and a real release reaches `uploaded`.
- [ ] iOS: ASC review poll authenticates (no `::warning::` in reconcile logs).
- [ ] Flag provider authenticates and `flags.api_url` is set (else the launch moment can't be observed).
- [ ] Sentry (or equivalent) auth + project wired, threshold set, alert rule → `sentry-alert` ([OBSERVABILITY.md](OBSERVABILITY.md)).
- [ ] Owned publish endpoints reachable **before** arming `HALYARD_LIVE_PUBLISH` (start it off; dry-run via `FilePublisher`).
- [ ] `commit-state.sh` can push to `main` (workflow has `contents: write`; maintenance also `pull-requests: write` if auto-merge).
- [ ] Crons in `reconcile.yml` / `maintenance.yml` match `halyard.config.yml`.
- [ ] Coordinating **more than one app**? Set `HALYARD_LICENSE_KEY` (multi-app is Pro) or scope every acting command with `--apps <slug>` — unscoped `reconcile`/`maintenance` over >1 app fails loudly on the free tier.

---

## 2. Per-launch go / no-go

Run through this before flipping a flag ON.

- [ ] `halyard launch create …` done — the flag is **born OFF** in the provider.
- [ ] The release is linked (`halyard launch link`) and has reached `shipped_dark` (iOS) or `uploaded` (web/Android).
- [ ] `halyard status --release <id>` shows it `waiting_on: flag flip` (not stuck earlier).
- [ ] Narrative seed reviewed/edited (it was drafted from recent commits if you didn't supply one).
- [ ] Channels for the launch tier are correct (`launch` tier unlocks HN/PH; standard doesn't).
- [ ] Rollback plan understood: **flip the flag OFF** → next reconcile projects `rolled_back` (publicity does **not** re-fire on a later re-flip).
- [ ] Triage threshold (`crash_free_users_pct`) set for the app; you'll get a proposal, not an auto-action, on a spike.
- [ ] You're available for the window after flip (the launch moment is a human act, and so is every post to a third-party channel).

**Flip:** `halyard flip --flag <key> --state on --app <slug>` → the next reconcile projects
`live`, and publicity fans out (owned auto-publish; third-party staged to your queue).

---

## 3. How to test it — without gambling a launch

A ladder from cheapest/safest to most realistic:

1. **Offline suite** (`npm test`, 460 tests + coverage gate) — proves the spine, the gates, the
   five invariants, and the re-entrant loops with zero credentials. Run on every change.
2. **Dry runs (no accounts):** `npm run verify:launch` walks the full spine against **fakes**
   (fast pass/fail of the projection); `npm run demo` walks it with the **real** adapters
   (real build → `local_dir` deploy → flip → reconcile → `live` → publicity) in a temp dir, the
   closest thing to a real launch locally. `tests/e2e.test.ts` is the same walk inside the suite.
   See [DEMO.md](DEMO.md).
3. **Per-integration live smoke tests** (each in isolation, nothing user-visible):
   - Flags: `halyard flip --flag test.smoke --state on/off --app <slug>` against the real
     provider; confirm `halyard status` / provider UI reflect it. Delete the test flag after.
   - Approval: trigger any proposal (e.g. a cert alert via `workflow_dispatch` on maintenance)
     and confirm the push reaches your phone.
   - Sentry path: `workflow_dispatch` the `sentry-alert` workflow; confirm a triage pass runs
     and (on a seeded spike) opens a proposal.
   - Reconcile: `workflow_dispatch` `reconcile.yml`; confirm exit 0 and no `coordinator_error`
     proposals (a failing poller opens one).
   - Owned publish: keep `HALYARD_LIVE_PUBLISH` **off** first and inspect the `FilePublisher`
     records; arm it only once the drafts look right.
4. **Staged real launch** — pick the lowest-stakes app/surface, smallest audience; flip on,
   watch `halyard status` + the queue, keep the rollback (flip OFF) one command away.

### Pre-flight commands

```bash
halyard preflight               # production-readiness across every third-party integration
halyard preflight --probe off   #   config-only (offline; skips live reachability checks)
halyard status --stuck          # anything mid-flight and where it's blocked
halyard queue                   # open proposals awaiting you
halyard reconcile               # one manual projection pass (exit 0 = clean)
```

`halyard preflight` is the one-stop check behind the coordinator go-live checklist above: per
app it reports each integration (approval surface, flags, monitoring, payments, stores, web
deploy) as required / configured / reachable, and exits non-zero if any required one isn't
ready — so it can gate a deploy.

---

## Guardrails that hold regardless (the five invariants)

Even fully armed, Halyard cannot: ship/promote/flip/post by model decision (gates are
boolean), auto-post to a third-party API (always staged for human approval), write a secret
to a record/log/URL (config holds references only), or treat the coordinator as authority
(it's a projection of external truth). These are enforced in code and covered by tests — they
are the reason a "go" here is safe.
