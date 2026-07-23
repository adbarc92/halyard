# Design — web auto-promote (`promote_gate: false`)

**Authored 2026-06-11.** Design record for F2 of the
[post-R3 roadmap handoff](./2026-06-11-post-r3-roadmap-handoff.md): wire the `promote_gate` web-surface
config (parsed at `app-config.schema.ts:119`, currently read nowhere) so a web release goes `live` on
deploy without a manual flag flip. Brainstorming output; the implementation plan follows separately.

## Decisions (the two pivotal forks)

| Question | Decision |
|---|---|
| How does a web release reach `live` without a manual flip, and how is it rolled back? | **Born-ON flag (auto-flip).** When `promote_gate: false`, the web release's flag is created **born ON** instead of OFF, so the existing flag-poll projects `uploaded → live`. Rollback is the existing `flip … --state off → rolled_back` lever. Auto-promote = the flip is *automated*, not *skipped* — flag stays non-null, flag-poll is still the only path to live, the rollback lever exists. |
| How does this interact with the launch-scoped flag? | **Standalone web only.** It applies to web releases NOT linked into a multi-surface launch — they get their own flag born ON. A web release explicitly `launch link`ed follows that launch's coordinated flag/flip; `promote_gate` does not override a deliberate launch. No per-surface flag machinery. |

The power of born-ON: **no new state, no state-machine change, no schema *shape* change.** The whole feature
is "create the flag ON and project this one release to live" for a standalone web release, reusing flag-poll,
rollback, and the contracts. (It does add two small, necessary *validations* — a graduation exemption and a
reserved-namespace refine — see below.)

## Verified mechanics (confirmed against code across two critique rounds)
- `flag-poll.ts` `isAtRest` includes `surface === "web" && state === "uploaded"` (web does NOT route through
  `shipped_dark`); with `flag != null` + provider state `on` it proposes `uploaded → live` (`externalRefs:
  { flag_state: "on" }`), a legal edge in `state-machine.ts`. Born-ON → flag-poll → `live` works as claimed.
- The inline `reconcile({ backend, sources, now, loadReleaseIds })` call is a real signature
  (`reconcile.ts` `ReconcileOptions`); it **re-reads** the record from `backend`, so it sees the helper's
  just-written `flag` (not stale), and writes the final `live` record correctly.
- A standalone `live` record has `launch_id === null`, and the schema's `live`/`rolled_back` refinement checks
  **only `flag`** (`release.schema.ts` superRefine), so it validates — see the load-bearing note under Invariants.

## Architecture

### Trigger, ownership, and the inline projection
A new library helper, `autoPromoteWebRelease(...)` in `src/halyard/coordinator/auto-promote.ts`, invoked from
the **CLI release path** (`cli.ts` `releaseRun`) *after* `runRelease` returns a web release at `uploaded`:

```
halyard release run --surface web …
  └─ runRelease(...) → release at `uploaded`            (unchanged; surface-agnostic, no flag knowledge)
  └─ if surface === "web" && app.surfaces.web.promote_gate === false
       && release.state === "uploaded"                                 // deploy actually succeeded (Round-3 #2)
       && release.launch_id === null && release.flag === null:         // standalone guard (idempotent)
         await autoPromoteWebRelease({ release, app, stateDir, backend, now }):
           flag    = autoPromoteFlagKey(app.app.slug, version)   // halyard.autopromote.<slug>.<sanitized> (from flags/naming.ts)
           client  = makeFlagClient([app], stateDir, now)        // the SINGLE app in scope (see below)
           await client.setState(flag, true)                     // create-or-update in ONE write — genuinely born ON (Round-3 #1)
           await backend.records.write({ ...release, flag })     // spread carries transitions + state:"uploaded"
           // Inline projection so the release is live ON DEPLOY, using the SAME client we just wrote to:
           await reconcile({ backend, sources: [flagPollSource(client)], now,
                             loadReleaseIds: () => [release.release_id] })
```

**Why the inline `reconcile` (Round-1 #1):** `releaseRun` does NOT otherwise call `reconcile`; without this the
release would sit at `uploaded` until the next cron sweep (which a standalone web shop may run rarely), and the
operator would think the feature is broken. The scoped, flag-poll-only reconcile for this single `release_id`
delivers `live` on deploy and reuses the engine (no duplicated projection); the cron sweep stays idempotent
(flag ON + already `live` → no-op). It passes **only** `flagPollSource` — no review pollers, and `reconcile`
never calls graduation/publicity (those are orchestrated separately in `reconcileRun`), so there is no
scope creep.

**Why this location:** not a reconcile source (sources are read-only pollers that *propose* — invariant #1; a
flag write is a side-effect); not inside `runRelease` (surface-agnostic, pre-dates flag/launch knowledge). The
CLI release path already orchestrates config + clients and is where `launch create` likewise creates a flag.
**Standalone holds by construction** — a freshly-run release has `launch_id === null`; the
`launch_id === null && flag === null` guard is explicit and **idempotent across re-runs**.

### Flag client selection — the single app, consistency by construction (corrects Round-1 #4)
The helper builds `makeFlagClient([app], stateDir, now)` from the **single app already in scope** — NOT
`loadApps(flags)`. Round 1 wrongly prescribed matching reconcile's `loadApps(...)`; Round 2 showed `releaseRun`
has no `loadApps` in scope (it loads one app via `--app`/`--app-config`), and pulling it in would import the
multi-app discovery + the Pro gate this single-app command deliberately avoids — *and* still wouldn't guarantee
provider agreement (the dominant divergence axes are `HALYARD_LIVE_FLAGS` and token resolution, not the app
set). The correct, simpler property: **the deploy-time go-live is consistent by construction because the inline
reconcile reuses the very `client` the helper wrote born-ON to.** Which client the *cron* later builds only
affects later sweeps (rollback observation) — that is a pre-existing property of the whole flag system (the cron
and an operator must share a provider config), not something this feature introduces or must solve. Token
resolves at runtime, never logged (invariant #4).

### Flag naming — reserved namespace, per version, sanitized (Round-1 #3, Round-2 #3)
`autoPromoteFlagKey(slug, version)` and the `AUTO_PROMOTE_PREFIX = "halyard.autopromote."` constant live in the
**leaf module `flags/naming.ts`** (alongside `flagKeyFor`), so both the helper and `graduation.ts` import them
from there — graduation does NOT import the heavyweight `auto-promote.ts` (which pulls in the flag client +
reconcile engine), avoiding a needless coupling / latent cycle (Round-3 #3).
`autoPromoteFlagKey(slug, version)` → **`halyard.autopromote.<slug>.<sanitized-version>`** where the version is
slugified to a safe charset: `version.replace(/[^A-Za-z0-9.]+/g, "-")`. Two reasons for the shape:
1. **Per-version** so each web release is independently rollback-able (`flip …1.4.0 off` doesn't touch `…1.5.0`).
2. **Sanitized** because `version` is only semver-validated when `app.version_scheme.semver` is true
   (`cli.ts`); with semver off it is an arbitrary non-empty string that could contain `/` or spaces, which would
   create nested dirs in the `FlagFileClient` path and diverge from the `encodeURIComponent`'d `HttpFlagClient`
   URL. Slugifying keeps the key a single safe segment, typeable for `flip --flag …` rollback. (Collision
   across two versions differing only in unsafe chars is negligible and per-version anyway.)
The `halyard.` prefix is a **reserved flag namespace** (enforced — see Graduation).

### Graduation exemption — structural, not prose (Round-1 #3, Round-2 #4)
`proposeFlagGraduations` fires on any release that is `state === "live"`, flag matches the app's launch prefix,
and is past the age window — **with no successor check** — so it would propose removing the *currently-live*
web kill-switch. The reserved namespace alone is NOT sufficient protection: graduation matches
`release.flag.startsWith(prefix)` where `prefix = flags.naming.split("{")[0]`, and a naming like `hal{slug}`
yields prefix `hal`, which *does* prefix `halyard.autopromote.…`. So:
- **Primary fix (structural):** `proposeFlagGraduations` skips any flag in the reserved namespace —
  `if (release.flag.startsWith(AUTO_PROMOTE_PREFIX)) continue;` placed right after graduation's existing
  `state !== "live" || !release.flag` guard (so `release.flag` is known non-null) and before the launch-prefix
  check. `AUTO_PROMOTE_PREFIX` is imported from the leaf `flags/naming.ts` (not the auto-promote module). This
  exempts auto-promote flags regardless of the app's launch prefix.
- **Belt-and-suspenders (validation):** a `FlagsSchema.naming` refine forbids `naming` from starting with
  `halyard.`, so a user launch flag can never collide with the reserved namespace.

*Known trade-off:* superseded per-version auto-promote flags accumulate (one per shipped version) and are never
auto-graduated. Dead-but-harmless; a future "prune superseded auto-promote flags" job is out of scope.

## Behavior matrix

| Surface | `promote_gate` | launch-linked? | Result |
|---|---|---|---|
| web | `false` | no (standalone) | flag born ON + **inline flag-poll projection → `live` on deploy**; **no publicity** (no launch) |
| web | `false` | yes (linked later) | launch's coordinated flag/flip governs; promote_gate ignored (documented override) |
| web | `true` | n/a | **unchanged** — rests at `uploaded`, awaits a manual flip (today's behavior) |
| ios / android / desktop | n/a | n/a | **unchanged** — `promote_gate` is web-only; these never auto-promote |

## Rollback (and why a redeploy doesn't un-rollback) — Round-1 #2
`flip --flag halyard.autopromote.<slug>.<version> --state off` → flag-poll → `rolled_back` (the existing lever;
the auto-created flag is a real provider flag). A CI **redeploy** of the same version re-runs `release run`, but
the guard (`flag === null`) is now false (the record carries the flag), so the helper **no-ops** — it does NOT
recreate or re-flip ON. Coordinator state stays `rolled_back` until a human deliberately re-flips. (The redeploy
still re-runs the actual deploy side-effect in `runRelease` — only the *coordinator state* is a no-op.) Covered
by an explicit "rollback survives a redeploy" test.

## Invariants — all preserved
1. **Projection, not authority.** Flag-poll is unchanged and remains the only path to `live`; the inline
   reconcile is the same flag-poll engine scoped to one id. Flag creation is an explicit deploy-time action.
2. **Deterministic gate.** The gate is the `promote_gate` boolean — no model decides.
3. **Dedup / non-null flag.** `flag` is non-null for `live`/`rolled_back`; the dedup key and flag-poll
   idempotency are untouched.
4. **Secrets.** The flag token resolves at runtime, never logged.
5. **Publicity boundary.** A standalone web release has no launch, so `firePublicity` never fires for it — the
   deliberate trade-off below.

### Load-bearing schema note (Round-2 #2)
A standalone auto-promoted release reaches `live` with **`launch_id === null`**. The schema permits this: the
`live`/`rolled_back` superRefine in `release.schema.ts` checks **only `flag !== null`**, NOT `launch_id`. The
nearby comments ("cannot exist without a flag **and a launch**") are **stale** and must be corrected as part of
this work. Critically, **do NOT "harden" the refine to also require a non-null `launch_id`** — that would make
every auto-promoted web release fail `ReleaseSchema.parse` on write. This dependence is intentional and documented.

## Deliberate product trade-off: standalone web go-live is silent (Round-1 #6)
Because auto-promote is standalone-only and `firePublicity` iterates launches, an auto-promoted web release
**does not announce** (even though its `changelog` is populated). This is **intentional**: continuous web
deploys are frequent and should not each fire publicity. The **escape hatch** is the existing model — to
announce a web go-live, wrap it in a `launch` (create + link), which opts into the coordinated flag/flip and the
announce policy. (Silent go-live being unwanted would be a separate feature — out of scope.)

## Testing
- **Helper unit tests** (`tests/auto-promote.test.ts`, injected fake flag client + git backend over a temp dir):
  - web + `promote_gate: false` + standalone at `uploaded` → a single `setState(true)` called (NO `ensureFlag`),
    `release.flag === "halyard.autopromote.<slug>.<sanitized-version>"` persisted, inline projection lands `live`
    (with `launch_id` still null).
  - `promote_gate: true` → no-op (no flag, state stays `uploaded`). non-web → no-op. Already-bound
    (`launch_id`/`flag` set) → no-op (idempotent).
  - **deploy failed (release stranded at `tested`, not `uploaded`) → no-op** (no flag created) — the
    `state === "uploaded"` guard excludes it (Round-3 #2).
  - a non-semver version with unsafe chars → key is slugified to a single safe segment.
- **Integration slice** (`tests/auto-promote-e2e.test.ts`, git backend + `FlagFileClient`):
  - web release with `promote_gate: false` → reaches `live` with **no manual flip** (proves inline projection).
  - then `flip … off` + reconcile → `rolled_back`; **then re-run `release run` for the same version → stays
    `rolled_back`** (proves a redeploy doesn't un-rollback — Round-1 #2).
- **Graduation test:** an auto-promote (`halyard.autopromote.*`) flag on a long-live release is **not** proposed
  for removal even when the app's launch prefix would otherwise match (Round-2 #4).
- The full existing suite stays green (no state-machine/schema-shape/flag-poll change).

## Scope / non-goals
- **In:** `autoPromoteWebRelease` helper (`coordinator/auto-promote.ts`); `autoPromoteFlagKey` +
  `AUTO_PROMOTE_PREFIX` in the leaf `flags/naming.ts`; the `cli.ts` `releaseRun` wiring (web +
  `promote_gate: false` + `state === "uploaded"` path: build `[app]` flag client + the inline scoped
  reconcile); reading `promote_gate`; the graduation skip for the reserved namespace
  (`coordinator/graduation.ts`); the `FlagsSchema.naming` refine reserving `halyard.`; **updating the stale
  `promote_gate` and `live`-state schema comments**; helper + integration + graduation tests.
- **Out:** per-surface flags within a launch; any change to the launch model, state machine, contracts/schema
  *shape*, or flag-poll; auto-announcing continuous web deploys; a `promote_gate: false` path for non-web
  surfaces; pruning superseded auto-promote flags; per-app `makeFlagClient` selection (noted smell).
- **Notes:** `release run` is single-app and not subject to the multi-app Pro gate; auto-promote adds
  single-app flag-writing here, acceptable (no multi-app entitlement implication). `promote_gate` is a required
  boolean, so every web fixture already sets it — verify values when wiring (a fixture set to `false` begins
  auto-promoting in tests). `setState(flag, true)` is create-or-update on both clients (the `FlagFileClient`
  writes the file unconditionally; the `HttpFlagClient` PUTs `{on:true}`), so the flag is born ON in a **single
  write** — there is no OFF→ON window and no `ensureFlag` call.

## Design Critique Log

### Critique Round 1
An independent reviewer verified the born-ON mechanism against the code and found four lifecycle flaws + precision gaps; resolved:
- **SEVERE — `release run` never reconciles** → added an **inline scoped flag-poll-only `reconcile`** for the single release id so it goes `live` on deploy; cron stays idempotent.
- **HIGH — graduation claim was wrong** (it fires on the currently-live release, no successor check) → moved auto-promote flags to a reserved `halyard.autopromote.` namespace; documented superseded-flag accumulation as out-of-scope.
- **MEDIUM — flag-client provider divergence** → (initially) "use `loadApps`"; **corrected in Round 2** to `makeFlagClient([app])` + consistency-by-construction via the inline reconcile reusing its own client.
- **MEDIUM — rollback durability** untested/surprising → documented redeploy-no-op + added a "rollback survives a redeploy" test.
- **MEDIUM — publicity gap** rationalized as invariant → reframed as a deliberate trade-off with a launch escape hatch.
- **LOW — stale schema comment / required `promote_gate` / write-spread** → added comment update to scope; noted the helper spreads the exact `runRelease` release.

### Critique Round 2
A fresh reviewer confirmed the core mechanism, inline-reconcile signature, re-run idempotency, and no scope creep are sound, and found that **one Round-1 fix was wrong** plus three more issues; resolved:
- **SEVERE — Round-1's `loadApps(flags)` prescription was a misreading**: `releaseRun` has no `loadApps` in scope, and adding it imports multi-app discovery + the Pro gate the design avoids — and still wouldn't guarantee provider agreement. → Use `makeFlagClient([app])`; documented that deploy-time go-live is consistent **by construction** (the inline reconcile reuses the helper's own client), and the cron's later client is a pre-existing flag-system property.
- **HIGH — the standalone `live` record has `launch_id === null`**, depending on the schema refine checking only `flag` while the comment says both are required. → Added a load-bearing note: the dependence is intentional, the comment is stale (fix it), and the refine must NOT be hardened to check `launch_id`.
- **HIGH — non-semver versions can break the flag key** (`/`/spaces; semver check is conditional). → Slugify the version in `autoPromoteFlagKey`.
- **MEDIUM — reserved-namespace exemption was prose-only** and a `flags.naming: "hal…"` prefix re-introduces the graduation hazard. → Made graduation **structurally skip** the `halyard.autopromote.` namespace, plus a `FlagsSchema.naming` refine forbidding the reserved prefix.
- Items confirmed sound (no change): inline-reconcile correctness/no-scope-creep, full re-run idempotency, the final persisted `live` record.

### Critique Round 3
A final reviewer verified the core mechanism, graduation-skip placement, fixture safety (no fixture uses a
`halyard.` naming or `promote_gate: false`), the null-`launch_id` schema dependence, and `getState`-after-`setState`
consistency are all sound, and found two MEDIUMs + one LOW; resolved:
- **MEDIUM — `ensureFlag` births OFF, contradicting "born ON"** and manufacturing the very OFF→ON window the
  Notes had to excuse. Both clients' `setState` is create-or-update. → **Dropped `ensureFlag`**; the helper does a
  single `setState(flag, true)` (genuinely born ON, one write, no window); updated the pseudocode, the Notes, and
  the unit-test assertion.
- **MEDIUM — the guard didn't exclude a failed deploy.** `runRelease` returns a non-deployed release stranded at
  `tested`; the four-condition guard matched it, so the helper would create a flag on a record that never went
  live and the idempotency guard would then block re-arming on a later successful redeploy. → Added
  `release.state === "uploaded"` to the guard + a "deploy failed → no flag" test.
- **LOW — coupling.** Importing `AUTO_PROMOTE_PREFIX` from the heavyweight `auto-promote.ts` into `graduation.ts`
  risks a latent cycle. → Homed `autoPromoteFlagKey` + `AUTO_PROMOTE_PREFIX` in the leaf `flags/naming.ts`; both
  graduation and the helper import from there.
