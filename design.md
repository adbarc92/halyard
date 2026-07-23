# Halyard

**A reusable, event-driven release + publicity coordinator for a multi-app shop.**

> A *halyard* is the line you haul to raise a flag. In this system the flag flip — not the
> store approval — is the real launch, so raising the flag is the whole point. The name also
> works as a verb on the CLI: `halyard ship ios`, `halyard flip launch.aurora.offline_sync`.

*(Runner-up names if you want alternatives: **Cadence** — release rhythm; **Throughline** — the
launch as the narrative thread across surfaces. If you ever publish this, check the npm/crates
namespace first; for an internal Example tool it doesn't matter.)*

---

## 1. The one idea that shapes everything

**This is not a pipeline.** A pipeline is a single linear run with a start and an end, and that
model breaks the instant mobile review enters the picture — no CI job can sit open for the hours-
to-days App Store review takes. What you actually have is an **event-driven state machine with a
durable coordinator**, where CI is just one of several event sources. Once you see it that way,
the publicity arm and the maintenance loop stop being separate systems and become more event
sources on the same bus.

Five invariants follow from that, and the implementation must hold all five:

1. **The coordinator is a projection, never an authority.** Truth about review status lives in
   App Store Connect; truth about a flag lives in your remote-config provider; truth about
   crashes lives in Sentry. The coordinator *polls and reconciles* those into a local view and
   fires transitions on deltas. It never assumes its own copy is correct.
2. **Launch ≠ release.** A *launch* is the surface-agnostic feature + narrative + announcement
   policy. A *release* is a per-surface, per-version instance that fans out from a launch. They
   go live at different times (web instant, iOS days later), so "did we launch X?" only has an
   answer at the launch level.
3. **The flag flip is the launch moment, not the store approval.** Builds ship *dark*. Enabling
   the flag is when the feature exists for users — and it's the event publicity fires on.
4. **Agents for judgment under structure; deterministic code for gates.** A model never
   adjudicates ship/no-ship. Gates are dumb booleans. Agents draft and classify into queues.
5. **The safety boundary is owned vs third-party, not tone.** Owned channels (blog, waitlist
   email) have bounded, reversible blast radius — light gate, can auto-publish. Third-party
   social is unbounded — the post button stays human for a long while.

---

## 2. The state machine

```
 tagged ──auto(CI)──► built ──auto──► tested ──┬─ fail ─► dead
                                               │
                                          pass │ auto
                                               ▼
                                          uploaded
                                               │
                              auto(reconcile)  │  ◄─── poll App Store Connect / Play
                                               ▼
                                          in_review ──reject──► rejected ──► (triage loop)
                                               │
                                       approve │ auto
                                               ▼
                                      shipped_dark        ← build is LIVE but flag is OFF
                                               │
                                   [HUMAN GATE] │  flag flip
                                               ▼
                                            live ──auto──► announce (publicity fires here)
                                               │
                                  [HUMAN GATE]  │  rollback = flip flag OFF
                                               ▼
                                          rolled_back
```

- `shipped_dark` is a **real named state**, not a transient — a build can sit there for days
  while you stage rollout.
- `live` is a **separate transition** triggered by the flag flip.
- `rolled_back` is reachable from `live` by flipping the same flag off — the only "rollback"
  mobile actually gives you.
- Web/desktop **collapse** several states (no `in_review`; the gate is just `promote-to-prod`),
  but the machine is the same shape. That sameness is what lets one coordinator serve all
  surfaces.

---

## 3. The contracts

Two JSON artifacts are the keystones. Everything hangs off these schemas.

### Launch object (surface-agnostic)
```json
{
  "launch_id": "lnch_aurora_offline_sync",
  "app": "aurora",
  "title": "Offline sync",
  "narrative_seed": "Aurora now works on the subway — full read/write offline, syncs on reconnect.",
  "announce_policy": "per_surface",          // per_surface | first_surface | all_surfaces
  "tier": "standard",                          // standard | launch  (launch unlocks HN/PH)
  "releases": ["rel_aurora_ios_1.4.0", "rel_aurora_web_2025.06.04"],
  "created_by": "alex",
  "created_at": "2025-06-04T00:00:00Z"
}
```
The `narrative_seed` is the single highest-value human input in the system: a changelog says
*what changed*, publicity says *why it matters*, and Conventional Commits capture almost none of
the latter. An agent may draft the seed from the diff; a human edits it.

### Release record (the projection — per surface, per version)
```json
{
  "release_id": "rel_aurora_ios_1.4.0",
  "launch_id": "lnch_aurora_offline_sync",
  "app": "aurora",
  "surface": "ios",
  "version": "1.4.0",
  "state": "shipped_dark",
  "flag": "launch.aurora.offline_sync",
  "changelog": ["feat: offline sync", "fix: token refresh race"],
  "external_refs": { "asc_build_id": "...", "review_status": "approved" },
  "transitions": [
    { "to": "built", "at": "...", "by": "ci",
      "dedup_key": "rel_aurora_ios_1.4.0:built" }
  ]
}
```
Every transition carries a **dedup key of `(release_id + transition)`**. An event-driven system
spanning days across external services *will* double-fire (re-poll sees "approved" twice, CI
retries, a webhook lands late). Without the dedup key you announce twice and upload twice.

---

## 4. Configuration — the part you asked for

Two layers. **One org file**, shared across every app; **one file per app**. Config holds
*references* to secrets (key names), never secret values — those resolve from a secret store
(GitHub Actions secrets, 1Password, env). `SECRET:NAME` below is just "look this up by name."

### `halyard.config.yml` (org-level)
```yaml
version: 1
org: { name: Example }

coordinator:
  backend: git                 # git | service   (see §5 — git recommended to start)
  state_dir: ./state           # git-backed launch + release records
  reconcile_cron: "*/20 * * * *"
  dedup: true                  # enforce (release_id + transition) idempotency

notifications:
  # The mobile-reachable approval surface. Gates are useless if you can't reach them
  # from your phone — this is non-negotiable given how you already work.
  approval_channel_ref: SECRET:HALYARD_APPROVAL_WEBHOOK

drafting:
  provider: anthropic
  model: claude-opus-4-8       # verify current string before use
  api_key_ref: SECRET:ANTHROPIC_API_KEY
  voice_canon: ./canon/voice/  # accreting corpus of APPROVED posts = the brand-voice moat

channels:                      # registry; each declares trust class + gate
  blog:
    class: owned
    gate: auto                 # owned → light gate, may auto-publish
    publish: { type: http, endpoint_ref: SECRET:BLOG_PUBLISH_URL }
  waitlist_email:
    class: owned
    gate: auto
    publish: { type: http, endpoint_ref: SECRET:EMAIL_SEND_URL }
  x:
    class: third_party
    gate: human                # third_party → post button stays human; draft + stage only
    publish: { type: manual }
  linkedin:
    class: third_party
    gate: human
    publish: { type: manual }
  hn:
    class: third_party
    gate: human
    requires_tier: launch      # only fires for launch-tier launches
    publish: { type: manual }

defaults:
  announce_policy: per_surface # recommended default for dev-tool audiences (see §5)
```

### `apps/<slug>/app.yml` (per-app)
```yaml
version: 1
app: { name: Aurora, slug: aurora }

version_scheme:
  semver: true
  tag_pattern: "{surface}-v{version}"   # e.g. ios-v1.4.0

flags:
  provider: <remote-config provider>
  api_key_ref: SECRET:AURORA_FLAG_PROVIDER_KEY
  naming: "launch.{slug}.{feature}"     # launch flags are born OFF
  graduate_after_days: 30               # propose flag removal after this stable window
  # distinguish launch flags (short-lived kill-switches) from permanent operational
  # flags (tier/region gates) at creation — opposite desired lifespans.

changelog: { source: conventional_commits, since: last_tag }

surfaces:
  ios:
    enabled: true
    bundle_id: com.example.aurora
    asc_app_id: "..."
    team_id: "..."
    signing:
      method: match                     # fastlane match
      match_repo_ref: SECRET:MATCH_REPO
      asc_api_key_ref: SECRET:ASC_API_KEY
    testflight_group: external
    review_poll_cron: "*/30 * * * *"
  android:
    enabled: true
    package: com.example.aurora
    track: internal
    service_account_ref: SECRET:PLAY_SERVICE_ACCOUNT
  web:
    enabled: true
    deploy: { target: cloudflare_pages, project: aurora-web }
    prod_url: https://aurora.app
    promote_gate: true                  # opt-in manual promote-to-prod
  desktop:
    enabled: false                      # flip on to fold your existing Tauri pipeline in
    # updater_channel, signing cert refs, platform matrix go here when enabled

triage:
  sentry: { project_ref: SECRET:SENTRY_DSN_AURORA, org: example }
  severity_thresholds: { crash_free_users_pct: 99.5 }
  classify: agent                       # agent proposes severity + {flag-kill|hotfix|ignore}

channels:
  enabled: [blog, waitlist_email, x, linkedin]
  overrides: {}                         # per-app channel tweaks

launch_defaults: { announce_policy: per_surface }

maintenance:
  cert_watch:                           # ALERTING only — renewal auth stays manual
    - { kind: apple_distribution }
    - { kind: apple_push_key }
    - { kind: authenticode }
  platform_deadlines: { calendar_ref: SECRET:DEADLINES_CAL }  # SDK mins / target-API cutoffs
  dependencies: { tool: renovate, automerge: [patch, minor] }
```

---

## 5. The two forks, resolved (and left configurable)

**Coordinator backend → start with `git`.** Repo-of-JSON-plus-scheduled-Actions is lighter, has
no always-on server to babysit, keeps state in version control (free audit log + replay), and is
on-brand for how you work. The cost is latency: cron-driven reconciliation reacts in tens of
minutes, not seconds. That's fine for review state (hours-to-days anyway) and for publicity. The
*one* latency-sensitive path — a crash spike you'd want to flag-kill fast — gets Sentry alerting
wired **directly to you**, outside the coordinator, so a slow reconcile loop never delays a page.
`backend` is in config so you can graduate to a running service later without touching the rest.

**Announce policy → default `per_surface`.** For a developer-tool audience, web users hearing
about a feature the day it's live for them beats holding the moment hostage to App Store review.
For a consumer app you'd more often want `all_surfaces` so you don't fragment the launch. It's a
per-launch field, defaulted in config — a genuine product choice, not the system's to pick.

---

## 6. What's reusable (the actual payoff)

| Layer | Transfers? | What it is |
|---|---|---|
| **Spine** | ✅ project-agnostic | coordinator + state machine, the one `release.yml` (inputs: `surface` + `app`), the contracts, approval-queue plumbing, content fan-out, triage/rejection classifiers |
| **Per project** | config + secrets only | `apps/<slug>/app.yml` + secret-store entries — bundle IDs, signing identities, flag keys, channel list, version scheme |
| **Per brand** | ❌ doesn't transfer | the **voice canon** — though it's shared across everything under Example |

Roughly **90% of the labor is API-automatable, ~80% of that is reusable spine.** What resists
automation is small in volume, high in consequence: store review (human at Apple/Google),
cert/key renewal auth (automate the alert, not the renewal), and the consequential gates (release
approval, flag flip, social post button — these *could* be API calls but shouldn't be).

---

## 7. Repo layout

```
halyard/
  halyard.config.yml            # org config (§4)
  apps/aurora/app.yml           # per-app config (§4)
  state/                        # git-backed records  [M2]
    launches/   releases/
  canon/voice/                  # approved-post corpus [M8]
  .github/workflows/
    release.yml                 # reusable, surface+app inputs [M1]
    reconcile.yml               # scheduled coordinator loop  [M2]
  src/halyard/
    config/                     # loader + schema validation  [M0]
    contracts/                  # launch + release schemas     [M0]
    coordinator/                # state machine, reconcile, dedup [M2]
    surfaces/                   # ios/android/web/desktop adapters [M1,M3]
    publicity/                  # fan-out + channel adapters    [M5]
    agents/                     # triage, rejection, narrative  [M6]
    maintenance/                # cert watch, deadlines, deps    [M7]
  fastlane/                     # Fastfile, Matchfile           [M3]
```

---

## 8. Build order (do NOT one-shot this)

Each milestone is independently verifiable; stop and review at each. Web first because it has no
review gate — it proves the spine fastest.

- **M0 — Scaffold.** Config schema + loader + *validation*; contracts as typed schemas; repo
  structure. Verify: invalid config fails loudly with a useful message.
- **M1 — One surface, end to end (web).** `release.yml` parameterized by `surface`+`app`;
  tag → build → test (deterministic gate) → deploy → write a release record. Verify: a tag
  produces a record in `state/` and a deployed preview.
- **M2 — Coordinator.** Git-backed state machine + reconciliation loop + dedup keys +
  idempotency. Verify: re-running reconcile twice produces zero duplicate transitions.
- **M3 — iOS.** Fastlane (match/gym/pilot) + the review poll → introduces `in_review`,
  `shipped_dark`, and the flag-flip transition. Verify: a tag reaches `shipped_dark` hands-off
  and waits.
- **M4 — Flags + launch/release split.** Launch object, flag lifecycle (born OFF → ON →
  graduate). Verify: flipping a flag moves the record to `live`; a stale flag surfaces a removal
  proposal.
- **M5 — Publicity fan-out.** Owned channels first (blog, waitlist email — light gate), then
  staged third-party drafts into the approval queue. Fires on the `live` transition per
  announce policy. Verify: going live drafts all channel variants; owned can auto-publish,
  third-party stages only.
- **M6 — Agents.** Sentry triage classifier (severity + flag-kill/hotfix/ignore) and
  rejection-response drafter, both proposing into queues. Verify: a synthetic crash spike yields
  a classified proposal, not an action.
- **M7 — Maintenance event sources.** Cert-expiry alerting, platform-deadline calendar, Renovate
  auto-merge — all onto the same bus + approval surface.
- **M8 — Voice canon loop.** Feed approved posts back into the drafting prompt so variants stop
  reading like generic AI launch copy.

The mobile-reachable approval surface (§4 `notifications`) should exist by M5 at the latest — the
gates are only real if you can reach them from your phone.
