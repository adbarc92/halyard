# Launch playbook (go-live runbook)

The **ordered** sequence to take an app live with Halyard. Where
[LAUNCH-READINESS.md](LAUNCH-READINESS.md) is the *requirements + checklist*, this is the
*execution order* — the steps, the exact commands, the expected output, and the rollback at
each one. Work top to bottom.

> Conventions: `$slug` = your app slug (e.g. `aurora`); commands assume CWD is the Halyard
> config root. Each step lists **Owner** (who acts) and **Done when** (the signal to proceed).

---

## Phase 0 — Prerequisites (one-time)

- Repo on GitHub with the workflows present (`ci`, `release`, `reconcile`, `maintenance`,
  `sentry-alert`).
- `halyard.config.yml` + `apps/$slug/app.yml` filled in (surfaces, channels, triage, flags,
  payments). Secret **references** only — see [LAUNCH-READINESS.md](LAUNCH-READINESS.md) for the
  full secrets-by-integration table.
- The GitHub Actions secret store populated with the values those references name.

**Owner:** operator. **Done when:** `git push` runs `ci` green.

---

## Phase 1 — Establish readiness

Run the one-stop check; it tells you exactly what's missing.

```bash
halyard preflight                 # required / configured / reachable, per integration
halyard preflight --probe off     # offline (config-only), e.g. before secrets are in env
```

Iterate **one integration at a time** until `ready: true` for every app:

| If a row is unready… | Set / fix |
|---|---|
| `approval-surface` | `HALYARD_APPROVAL_WEBHOOK` (your phone push endpoint) — **do this first** |
| `flags` | `apps/$slug/app.yml → flags.api_url` + the key its `api_key_ref` names |
| `monitoring` | `SENTRY_AUTH_TOKEN` + the secret its `project_ref` names — see [OBSERVABILITY.md](OBSERVABILITY.md) |
| `payments` | the key its `api_key_ref` names — see [PAYMENTS.md](PAYMENTS.md) |
| `ios-store` | `ASC_KEY_ID` / `ASC_ISSUER_ID` / `ASC_PRIVATE_KEY` + the signing refs |
| `android-store` | the `service_account_ref` secret |
| `web-deploy` | `CLOUDFLARE_API_TOKEN` + `CLOUDFLARE_ACCOUNT_ID` |

**Owner:** operator. **Done when:** `halyard preflight` exits 0 (every required integration green).

---

## Phase 2 — License (only if you need Pro features)

AI agents, auto-merge, and multi-app are Pro ([LICENSING.md](LICENSING.md)). Skip if the free
tier covers you.

```bash
export HALYARD_LICENSE_KEY="<token>"
halyard license                   # confirm: tier "pro" + the features you expect
```

**Owner:** operator. **Done when:** `halyard license` shows the expected tier/features.

---

## Phase 3 — Dry-run rehearsal

Walk the entire spine without touching a real provider.

```bash
npm run verify:launch             # 12 checks against fakes; must be ✅ ALL GREEN
npm run demo                      # the same walk with the REAL adapters in a temp dir (see DEMO.md)
```

**Owner:** operator. **Done when:** exit 0, all green. If red, fix before continuing.

---

## Phase 4 — Create the launch (flag born OFF)

```bash
halyard launch create --app $slug --feature offline_sync --title "Offline sync" \
  [--narrative "..."] [--tier launch] [--announce per_surface]
# review the drafted narrative seed if you didn't pass --narrative
```

Then link it to the release once the release record exists (Phase 5):

```bash
halyard launch link --launch <launch_id> --release <release_id>
```

**Owner:** operator. **Done when:** `halyard launch create` reports `"flag_state": "off"` and
the launch record is written. (A linked release doesn't exist until Phase 5, so `halyard
status` won't reflect the flag yet — trust the `create`/`flip` output or the provider here.)

---

## Phase 5 — Ship dark

Tag the release; the `release` workflow builds → tests → deploys → writes the record.

```bash
git tag $surface-v$version        # or $slug-$surface-v$version for a multi-app shop
git push origin $surface-v$version
```

- Web/Android(non-prod) rest at `uploaded`; iOS is driven `uploaded → in_review →
  shipped_dark` by the scheduled `reconcile` ASC poll (hands-off).
- Watch progress:

```bash
halyard status --release <release_id>     # see state + what it's waiting on
```

**Owner:** CI + the coordinator (hands-off). **Done when:** `status` shows `shipped_dark`
(iOS) or `uploaded` (web/Android) — i.e. waiting on the flag flip.

---

## Phase 6 — The launch moment (human gate)

This is the launch. Flip the flag ON; the next reconcile projects `live` and publicity fires.

```bash
halyard flip --flag launch.$slug.offline_sync --state on --app $slug
```

- Owned channels (blog, waitlist email) **auto-publish** on `live`.
- Third-party channels (X, LinkedIn) **stage** as proposals — they are never auto-posted.

**Owner:** operator (the only required human action). **Done when:** `halyard status` shows
`live`.

---

## Phase 7 — Approve third-party posts

```bash
halyard queue                                       # open proposals (the staged social posts)
halyard approve --proposal <id> --text "final copy" # records approval + feeds the voice canon
# then post it yourself — Halyard never posts to a third-party API
```

**Owner:** operator. **Done when:** each `social_post` proposal is approved and posted by hand.

---

## Phase 8 — Watch

```bash
halyard status --stuck            # anything mid-flight / stuck
halyard queue                     # new proposals (e.g. crash triage)
```

A crash spike opens a `crash_triage` proposal (severity + recommendation) and — if wired —
pages you out-of-band via `sentry-alert`. It **proposes**, never acts.

**Owner:** operator on-call. **Done when:** crash-free is stable and the queue is clear.

---

## Phase 9 — Rollback (if needed)

Mobile's only real rollback is the flag:

```bash
halyard flip --flag launch.$slug.offline_sync --state off --app $slug   # → rolled_back
```

Re-flipping ON later returns to `live` (recorded `live#2`); publicity does **not** re-announce.

**Owner:** operator. **Done when:** `status` shows `rolled_back` (or `live` again on re-flip).

---

## Phase 10 — After launch

- After the stable window (`graduate_after_days`), Halyard proposes **flag removal** — approve
  it and delete the now-permanent flag from the code.
- The `maintenance` workflow keeps watching certs / platform deadlines / dependencies.

---

## Suggested T-minus schedule (with the campaign)

Pair the technical steps with [CAMPAIGN.md](CAMPAIGN.md):

| When | Technical | Publicity |
|---|---|---|
| **T-2 weeks** | Phase 0–1 (readiness green) | waitlist live; teaser posts |
| **T-1 week** | Phase 3 dry run; Phase 4 create launch | deep-dive blog drafted; demo asset; outreach |
| **T-1 day** | Phase 5 ship dark; confirm `shipped_dark`/`uploaded` | finalize Show HN / PH / thread copy |
| **Launch day** | Phase 6 flip ON → `live` | Phase 7 approve + post; Show HN; PH |
| **T+1–2 weeks** | Phase 8 watch; Phase 10 graduation | iterate on feedback; follow-up post |

---

## Commands at a glance

```bash
halyard preflight                                   # 1. readiness
halyard license                                     # 2. (Pro)
npm run verify:launch                               # 3. dry run
halyard launch create --app $slug --feature ... --title ...   # 4.
halyard launch link --launch <id> --release <id>    # 4.
git tag $surface-v$version && git push origin $surface-v$version  # 5. ship dark
halyard status --release <id>                       # 5./8. watch
halyard flip --flag launch.$slug.<feature> --state on  --app $slug  # 6. LAUNCH
halyard queue && halyard approve --proposal <id> --text "..."      # 7. third-party
halyard flip --flag launch.$slug.<feature> --state off --app $slug # 9. ROLLBACK
```
