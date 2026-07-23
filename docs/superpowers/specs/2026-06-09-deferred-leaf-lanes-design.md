# Deferred leaf-lanes — parallel build design

**Date:** 2026-06-09
**Status:** Final — passed 3 rounds of adversarial critique (see Design Critique Log);
pending user re-approval (scope changed from the originally-approved 3 leaf-lanes to 2 lanes
+ a shared prep-commit — see below)

## Context

Halyard is feature-complete and certified green (PRs #11–#28). `LAUNCH-HANDOFF.md`
names four deferred engineering items off the launch-critical path: desktop surface,
`service` backend, web auto-promote, and a production-track Android review poll.

This session parallelizes **two** lanes — a new desktop surface adapter (Lane A) and a
new Android production-track review source (Lane B). Adversarial review (rounds 1–2)
established that **none** of the four deferred items is a pure leaf: every one of them
ultimately touches `flag-poll.ts` and/or the reconcile spine. The two chosen lanes are
the *least* entangled (one shares a single additive line of `flag-poll.ts`; the other
adds a small track-aware guard to it). The other two (`service` backend, web
auto-promote) are *heavy* spine work — deferred to a serial session; see "Deferred —
spine work" below.

**Honest framing:** these two lanes are not collision-free. They share exactly one file,
`flag-poll.ts`, in disjoint clauses. The merge point is a few lines in one function —
small and known in advance, not zero. See the collision map.

## Invariants (load-bearing — every lane preserves these)

1. The coordinator is a **projection**, never authority.
2. Gates are **deterministic booleans** — adapters report exit codes; gates adjudicate.
   No adapter decides ship/promote/flip.
3. Every transition has an idempotent `(release_id + transition)` dedup key.
4. Config holds **secret references** (`SECRET:NAME`), never values. Adapters never log
   credentials.
5. Owned vs third-party is the publicity boundary (not directly touched by these lanes,
   but never relaxed).

## Lane A — Desktop surface (Tauri)

- **New file:** `src/halyard/surfaces/desktop.ts` — `DesktopSurfaceAdapter implements
  SurfaceAdapter` (`build`/`test`/`deploy` only — the existing contract at
  `surfaces/types.ts:66-71`; do **not** add methods to the interface). Mirrors `web.ts`'s
  shape, not its tools:
  - `build` = configured `tauri build` command via `runner.run` → exit code + output dir.
  - `test` = configured test command → exit code.
  - `deploy` = upload the built artifact via `runner.runArgv` (no shell; runtime values never
    shell-interpreted, per invariant #4 and the web.ts precedent). Two targets:
    `local_dir` (local verify, copies output like web's local_dir) and `github_releases`
    (real distribution via the **`gh` CLI** — `gh release create <tag> <artifact>` — mirroring
    how web calls `wrangler` directly rather than going through fastlane; **no new Fastfile
    lane is required**, avoiding cross-repo scope creep).
- **Resting state:** desktop has no store review, so a desktop release rests at `uploaded`,
  exactly like web and non-prod Android, and the flag flip projects it to `live`.
  **This requires a one-line edit to a shared file** — see flag-poll edit below. (Verify in
  `release-runner.ts` that deploy lands a desktop release at `uploaded`; if the post-deploy
  state is surface-gated there, extend that gate too — expected to already be surface-agnostic.)
- **Edit (1 line):** `surfaces/index.ts:26` — replace the `desktop` throw with
  `new DesktopSurfaceAdapter()`.
- **Edit (1 line, SHARED):** `flag-poll.ts:24` — add `desktop` to the `uploaded`-resting
  clause: `(surface === "web" || surface === "android" || surface === "desktop")`. Purely
  additive; this is the single line Lane A and Lane B both touch.
- **Config:** replace the deliberately-loose `DesktopSurfaceSchema`
  (`app-config.schema.ts:122-128`, currently `{ enabled }.passthrough()`) with a **strict,
  desktop-specific** block — do **not** blind-copy `WebSurfaceSchema` (web's `prod_url` and
  `promote_gate` are web-promote concepts that do not apply to desktop). Fields:
  `enabled`, `build {command, output_dir}`, `test {command}`, `deploy` (discriminated union of
  `github_releases {repo, tag_pattern}` + `local_dir {dir}`), all `.strict()`. Tightening
  `.passthrough()` → `.strict()` is part of this lane so desktop config typos fail loudly.
- **Tests:** `tests/surface-desktop.test.ts` (mirror the web surface test, with a fake runner
  asserting the `gh`/copy argv and that build/test exit codes pass through untouched).
- **Decision:** distribution target = **GitHub Releases** via `gh` CLI.
- **Shared-file note:** Lane A solely owns `app-config.schema.ts` and `surfaces/index.ts`;
  it shares only the one additive `flag-poll.ts:24` line with Lane B.

## Lane B — Android production-track review poll

- **New file:** `src/halyard/coordinator/sources/play-review.ts` — mirrors the *structure* of
  `sources/asc-review.ts` (a pure `mapReviewStatus→transition` function split from the client),
  driving `uploaded → in_review → shipped_dark` for **production-track** Android. (`in_review`
  and both transitions already exist in the state machine — verified, no state-machine change.)
  - `appliesTo` = `surface === "android" && track === "production" && POLLABLE_STATES.has(state)`
    where `POLLABLE_STATES = {uploaded, in_review, rejected}` (same set as ASC).
  - **Must read `release.external_refs.play_version_code`** to identify the build — unlike ASC
    (whose client ignores the release and queries the latest app version), the Play API requires
    `package + versionCode`. If `play_version_code` is absent (a failed/early-exited deploy
    never recorded it), `poll` returns `[]` — no proposal. This is a real ASC↔Play asymmetry,
    not a 1:1 mirror.
  - **Rejection handling:** a `rejected` production release stays pollable (re-enters
    `in_review` on resubmit) but the poll does **not** auto-resubmit; document that resubmit is
    a human/CI action, matching ASC's behavior.
- **New file:** `src/halyard/coordinator/sources/play-client.ts` — `LivePlayClient`
  implementing a `PlayClient` interface (`getReviewStatus(release): Promise<PlayReviewStatus>`),
  the analog of `asc-client.ts`/`LiveAscClient`. The source takes an injected `PlayClient` so it
  is testable with a fake, exactly like `AscClient`.
  - **Auth:** Play uses a **service-account JSON**, not ASC's JWT-from-key. The workflow
    resolves `app.surfaces.android.service_account_ref` (`SECRET:` ref already in config) into a
    runtime env var (e.g. `PLAY_SERVICE_ACCOUNT_JSON` / `SUPPLY_JSON_KEY_DATA`, matching the
    existing Android upload path in `LAUNCH-READINESS.md`); `LivePlayClient` reads and parses it
    and authenticates via the Google API client. Never logged (invariant #4).
  - Define a normalized `PlayReviewStatus` enum decoupled from Play's raw vocabulary
    (`inProgress`/`completed`/`halted`/`draft`/`unpublished`), exactly as `asc-review.ts` defines
    its own `ReviewStatus`. The raw→normalized translation lives in `LivePlayClient`; the
    normalized→transition map lives in the pure function in `play-review.ts`.
- **Edit (1 file):** `sources/index.ts` — add `makePlayClient?` to `SourceDeps`, a
  `defaultMakePlayClient`, and push `playReviewSource(...)` inside the per-app loop **only when
  `app.surfaces.android?.enabled && app.surfaces.android.track === "production"`**. Production
  track is itself the opt-in — **no new config field**, so Lane B does **not** touch
  `app-config.schema.ts`.
- **Edit (SHARED, the non-trivial one):** `flag-poll.ts:24` — the android `uploaded`-resting
  clause is currently track-blind, so a production release at `uploaded` with the flag flipped
  ON early would jump straight to `live`, **bypassing the review poll** this lane adds. Make the
  android clause exclude the production track. flag-poll today sees only `{state, surface,
  flag}` and has no `track`, so Lane B must thread the track in. Preferred minimal approach:
  have the Android **deploy** record `play_track` into `external_refs` (it already does —
  `android.ts:83`) and gate flag-poll on `external_refs.play_track !== "production"` rather than
  plumbing app config into flag-poll. This keeps the edit inside flag-poll + the release record
  and avoids a reconcile-signature change. **This is Lane B's one genuine spine touch** and the
  file it shares with Lane A.
- **Status mapping:** map Play's raw statuses explicitly; do not assume they match ASC's.
- **Tests:** `tests/play-review.test.ts` (mirror `tests/asc-review.test.ts`, fake `PlayClient`)
  plus a flag-poll regression test that a production-android release at `uploaded` with flag ON
  does **not** go `live`.
- **Edit (1 line, low risk):** refresh the outdated comment at `android.ts:14-18` ("not wired
  here" → "wired via the play-review source"). android.ts is touched by no other lane.
- **Shared-file note:** Lane B solely owns `sources/index.ts`, `android.ts`, and the two new
  source files; it shares only `flag-poll.ts` with Lane A.

## Collision map

| File | A (desktop) | B (play-review) |
|---|---|---|
| `app-config.schema.ts` | edit (strict desktop block) | — |
| `surfaces/index.ts` | edit (1 line) | — |
| `surfaces/desktop.ts` (new) | create | — |
| `sources/index.ts` | — | edit (deps + 1 push) |
| `sources/play-review.ts`, `play-client.ts` (new) | — | create |
| `coordinator/sources/android.ts` (comment) | — | edit (1 line) |
| **`flag-poll.ts`** | **edit line 24 (+`desktop`)** | **edit line 24 (track-gate)** |
| `surfaces/types.ts` | — (no interface change) | — |
| `state-machine.ts` / `reconcile.ts` | — | — |

**Exactly one shared file: `flag-poll.ts`.** Both lanes edit the same `isAtRest` predicate
(line 24) in disjoint ways — Lane A appends a `desktop` surface; Lane B narrows the `android`
clause by track. A textual merge will conflict on that line, but the *resolution* is trivial
and known now: the merged clause is
`(surface === "web" || surface === "desktop" || (surface === "android" && external_refs.play_track !== "production")) && state === "uploaded"`.
**Mitigation:** sequence the merges — whichever lane lands first leaves a one-line rebase for
the second; or, cleaner, pre-land the merged `isAtRest` predicate as a tiny separate prep
commit on `main` *before* dispatching either worktree, so neither lane touches flag-poll at
all. The prep-commit option restores true zero-collision and is recommended.

## Prep-commit — land on `main` before dispatching either worktree

A single small commit on `main` makes both lanes truly collision-free and is itself the
only place `flag-poll.ts` changes. It must be self-contained and leave the build green.

1. **Widen the predicate type.** `flag-poll.ts:21` types the param `{ state: string; surface:
   string }` — it cannot read `external_refs`. Change to `Pick<Release, "state" | "surface" |
   "external_refs">` and add `import type { Release } from "../../contracts/release.schema.js";`.
2. **Type the new external refs.** `ExternalRefsSchema` (`release.schema.ts`) is
   `.passthrough()`, so `play_track`/`play_version_code` exist at runtime but aren't typed. Add
   `play_version_code: z.string().optional()` and
   `play_track: z.enum(["internal","alpha","beta","production"]).optional()` to the schema
   (keep `.passthrough()`).
3. **Merged `isAtRest` clause** (use optional chaining — `external_refs` may be absent on legacy
   records, and `undefined !== "production"` correctly treats legacy/non-prod as resting):
   ```ts
   ((release.surface === "web" || release.surface === "desktop" ||
     (release.surface === "android" && release.external_refs?.play_track !== "production"))
    && release.state === "uploaded")
   ```
   with a comment explaining the production-track exclusion and the legacy-undefined intent.
4. **Regression test** in `tests/flag-poll.test.ts`: a production-track android release at
   `uploaded` with flag ON yields **zero** proposals (it must await the review poll); confirm
   existing non-production android tests stay green (they set `internal`/no track → still rest).

Once this is on `main`, neither worktree touches `flag-poll.ts`: Lane A's desktop surface and
Lane B's production-track gate are both already present. **This is a hard prerequisite — dispatch
the worktrees only after the prep-commit merges.**

## Deferred — spine work (NOT in today's parallel batch)

- **`service` backend** — replaces git-backed persistence behind `record-store`,
  `launch-store`, `reconcile`, and the state machine. Large and collision-prone; serial
  session.
- **Web auto-promote** — the deferred item is the `promote_gate: false` path
  (`app-config.schema.ts:115-118`): a web release auto-advancing `uploaded → live` on deploy
  *instead of* resting for a manual flag flip. This is a state-machine / flag-poll / reconcile
  change, **not** a surface-adapter change — `SurfaceAdapter` has no `promote` hook and adding
  one is an interface + spine edit that would collide with Lane B. It joins the serial spine
  session. (Earlier framing of this as "alias the Cloudflare preview to prod_url on flip" was
  incorrect and is dropped.)

## Shared conventions (every lane)

- Branch `feat/<lane>`; never push to main; PR to merge.
- No `Co-Authored-By` lines, no "Generated with…" attribution in commits/PRs.
- Adapters/sources never log secrets (invariant #4) and never decide pass/fail (invariant #2).
- Each lane leaves `npm run typecheck` and `npm test` green before opening its PR.
- Worktree isolation per lane.
- **The prep-commit lands on `main` first** (green) before either worktree is dispatched, so
  neither lane touches `flag-poll.ts`.

## Design Critique Log

### Critique Round 1

Independent reviewer (grounded in the real source) found:

1. **CRITICAL — Lane C ("web auto-promote") is not a leaf-lane.** The proposed
   "promote-on-flip" step has nowhere to live: `SurfaceAdapter` (`types.ts:66-71`) is
   `build`/`test`/`deploy` only, and reconcile drives `source.poll()`, not adapter side
   effects on transitions. The actual deferred item (`promote_gate: false`,
   schema:115-118) is an `uploaded → live`-on-deploy state-machine change — spine work that
   collides with Lane B. **Resolved:** Lane C removed from the parallel batch and moved to
   "Deferred — spine work"; the incorrect "alias preview → prod_url on flip" framing dropped.
2. **HIGH — Lane B's `review_poll` config toggle was unwired and unnecessary.** Sources are
   wired per-app in `buildReconcileSources`; `track === "production"` is already a sufficient,
   self-documenting opt-in. **Resolved:** dropped the new config field; Lane B now gates on the
   production track and no longer touches `app-config.schema.ts`.
3. **MEDIUM — collision map was incomplete.** It omitted that Lane B touches
   `sources/index.ts`. **Resolved:** rewrote the collision map; with Lane C gone and Lane B's
   schema edit removed, the two remaining lanes share **zero** files.
4. **LOW — desktop `DesktopSurfaceSchema` is `.passthrough()`** (schema:122-128), so a real
   config block added naively would accept typos silently. **Resolved:** Lane A now explicitly
   tightens it to `.strict()` mirroring `WebSurfaceSchema`.
5. **LOW — Lane B assumed Play API status strings mirror ASC's 1:1.** **Resolved:** added an
   explicit "map the statuses, don't assume identical" instruction; noted `play_version_code`
   is already captured at deploy (`android.ts:82-84`).

### Critique Round 2

Second independent reviewer (grounded in `flag-poll.ts`, `asc-review.ts`, `asc-client.ts`)
found the "zero shared files" claim to be false and surfaced concrete wiring gaps:

1. **CRITICAL — both lanes must edit `flag-poll.ts`.** `isAtRest` (`flag-poll.ts:24`) lists
   only `web`/`android` at `uploaded`. (a) A `desktop` release is therefore never projected to
   `live` by the flag flip — it strands. (b) The `android` clause is track-blind, so a
   production release at `uploaded` with the flag flipped ON early would jump to `live`,
   bypassing the new review poll. **Resolved:** documented both edits explicitly, corrected the
   collision map to "exactly one shared file," and added the *prep-commit* mitigation
   (pre-land the merged `isAtRest` on `main` before dispatch → true zero-collision).
2. **HIGH — Lane B's PlayClient must read `external_refs.play_version_code`.** ASC's client
   ignores the release and queries the latest version; Play requires `package + versionCode`. A
   blind "mirror" would have no way to query Play. **Resolved:** specified the read, plus an
   empty-proposal guard when the version code is absent (failed deploy). Documented the
   asymmetry.
3. **HIGH — Play authentication path was unspecified.** Play uses a service-account JSON, not
   ASC's JWT. **Resolved:** documented the `service_account_ref` → runtime-env → parse →
   Google-API-client path, reusing the existing Android upload secret.
4. **MEDIUM — Lane A's "mirror WebSurfaceSchema" was wrong.** Web's `prod_url`/`promote_gate`
   are web-promote concepts inapplicable to desktop. **Resolved:** Lane A now defines a
   distinct strict `DesktopSurfaceSchema` (enabled/build/test/deploy only).
5. **MEDIUM — desktop `deploy` tool was unspecified.** **Resolved:** specified `gh release
   create` via `runArgv`, mirroring web's direct-`wrangler` call; explicitly no new Fastfile
   lane (avoids cross-repo scope creep).
6. **LOW — android.ts comment refresh was left conditional.** **Resolved:** made it a definite
   one-line edit Lane B owns (no other lane touches android.ts).

### Critique Round 3

Third independent reviewer (grounded in `flag-poll.ts`, `release.schema.ts`,
`release-runner.ts`, `flag-poll.test.ts`) stress-tested the *prep-commit* — the new lynchpin —
and found it underspecified rather than wrong:

1. **CRITICAL — the prep-commit would not compile as described.** `flag-poll.ts:21` types the
   predicate param as `{ state, surface }`, with no `external_refs`, and `flag-poll.ts` does not
   import `Release`. **Resolved:** the new "Prep-commit" section now specifies widening the type
   to `Pick<Release, "state"|"surface"|"external_refs">` plus the import.
2. **MEDIUM — `external_refs` fields are untyped.** `ExternalRefsSchema` is `.passthrough()`, so
   `play_track`/`play_version_code` are runtime-present but not typed, forcing `as any` at read
   sites. **Resolved:** prep-commit adds both as optional typed fields (keeping `.passthrough()`).
3. **MEDIUM — `external_refs` may be absent on legacy records.** A bare `.play_track` access
   could throw. **Resolved:** prep-commit clause uses optional chaining
   (`external_refs?.play_track`), and the doc notes `undefined !== "production"` correctly treats
   legacy/non-prod releases as resting.
4. **HIGH — the prep-commit shipped without a test of its own logic.** **Resolved:** prep-commit
   now *includes* the production-android regression test (flag ON at `uploaded` → zero
   proposals), and explicitly requires existing non-prod android flag-poll tests to stay green.
5. **MEDIUM — Lane A's "rests at `uploaded`" claim, verified.** `release-runner.ts` advances to
   `uploaded` on any `deploy → ok:true`, surface-agnostically — so the claim **holds** with no
   release-runner edit. **Resolved/confirmed:** Lane A's test must assert desktop deploy `ok:true`
   advances to `uploaded` and persists `externalRefs`; no spine edit needed. (Flagged as
   confirmed-fine so it is not re-litigated.)
6. **LOW — prep-commit ordering is process, not code.** Landing a lane before the prep-commit
   reintroduces the conflict. **Resolved:** doc marks the prep-commit a hard, stated prerequisite
   to dispatch; the per-lane handoff prompts will repeat it.

**Outcome:** no remaining build-blocking or design-breaking issues. Residual risk is execution
risk inside each lane (Tauri toolchain availability for A; Play API auth/quota for B), to be
de-risked by each agent early in its lane, not by further design changes. Design is final.
