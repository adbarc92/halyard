> ## ⚠️ DEPRECATED — EXECUTED 2026-06-09
> Both lanes and the prerequisite have shipped: prep-commit (PR #29), desktop surface
> (PR #30), Android production Play review poll (PR #31). This document is retained as a
> historical record only. Active work is tracked in
> [`2026-06-10-remaining-work-swarm-handoff.md`](./2026-06-10-remaining-work-swarm-handoff.md).

# Handoff — deferred leaf-lanes (parallel build)

Design: [`2026-06-09-deferred-leaf-lanes-design.md`](./2026-06-09-deferred-leaf-lanes-design.md)
(passed 3 rounds of adversarial critique). This handoff carves that design into **two
dispatch-ready worktree lanes** plus a **prerequisite prep-commit** (already implemented).

## Prerequisite — land first, before dispatching either lane

**Branch `prep/flag-poll-track-aware-rest` (already committed locally; 224 tests green,
typecheck clean).** It makes `flag-poll.ts` track-aware (production Android no longer rests at
`uploaded`) and recognizes the `desktop` surface, and types `play_track`/`play_version_code` on
`ExternalRefsSchema`. **Merge this to `main` first.** Once merged, neither lane below touches
`flag-poll.ts` — the lanes have zero write-overlap.

## Integration order

1. Merge `prep/flag-poll-track-aware-rest` → `main` (prerequisite).
2. Dispatch Lane A and Lane B in parallel worktrees (any merge order — they share no files).
3. Reconcile: from `main` with both merged, run `npm run typecheck && npx vitest run` — expect
   green with two net-new test files and one new schema block.

## Rules of the road (apply to BOTH lanes)

1. **Stay in your lane.** Write only the files your lane *owns*. If you need a change in another
   file, record it as a contract request in your final report — do not make it.
2. **Worktree per lane**, branch `feat/<lane>`. Never commit to `main`; open a PR.
3. **Do not touch `flag-poll.ts`** — the prep-commit already did the shared edit. If you think
   you need it, you don't: re-read your lane's resting-state note.
4. **Preserve the invariants.** Adapters/sources report exit codes / external truth; they never
   decide pass/fail and never flip/promote (gates do). Never log a secret; config carries
   `SECRET:NAME` refs only, resolved to env at runtime.
5. **No scope widening.** Build only your lane's items. Report anything else you find.
6. **Verify before claiming done.** Run the lane's Verify command and paste real output.
7. No `Co-Authored-By` lines, no "Generated with…" attribution in commits/PRs.

---

### Lane A — Desktop surface (Tauri)   ·   ready (after prep-commit)

- **Scope:** Implement the desktop release surface so a `desktop` app can be built, tested, and
  distributed by the coordinator, resting at `uploaded` until the flag flip projects it to
  `live` (the prep-commit already taught flag-poll to recognize `desktop`).
- **Owns (exclusive write):**
  - `src/halyard/surfaces/desktop.ts` (new)
  - `src/halyard/surfaces/index.ts` (replace the `desktop` throw at ~line 26)
  - `src/halyard/config/app-config.schema.ts` (replace `DesktopSurfaceSchema` only)
  - `tests/surface-desktop.test.ts` (new)
- **Reads (no write):** `src/halyard/surfaces/web.ts` (the pattern to mirror),
  `src/halyard/surfaces/types.ts` (the `SurfaceAdapter` contract — do **not** add methods),
  `src/halyard/surfaces/command-runner.ts`, `src/halyard/surfaces/android.ts`,
  `tests/release-runner.test.ts` (how a surface test drives a fake runner).
- **Shared contract:** none. (`flag-poll.ts` is handled by the prep-commit — do not touch it.)
- **Depends on / blocks:** depends on the prep-commit being merged; blocks nothing.
- **Build notes:**
  - `DesktopSurfaceAdapter implements SurfaceAdapter`, `surface = "desktop"`, methods
    `build` / `test` / `deploy` **only** (the existing contract). Mirror `web.ts`'s *shape*.
  - `build` = configured `tauri build` command via `runner.run` → `{ ok: exitCode===0,
    outputDir, command }`.
  - `test` = configured test command via `runner.run` → `{ exitCode, command }`.
  - `deploy` via `runner.runArgv` (NO shell — runtime values must not be shell-interpreted).
    Two targets in a discriminated union:
    - `local_dir`: copy the build output to an inspectable preview dir (mirror web's local_dir).
    - `github_releases`: `gh release create <tag> <artifact…>` via `runArgv`. Use the `gh` CLI
      directly, the way web calls `wrangler` directly — **do not add a Fastfile lane** (that's a
      cross-repo file outside this lane).
  - Replace the deliberately-loose `DesktopSurfaceSchema` (currently `{ enabled }.passthrough()`)
    with a **strict, desktop-specific** block — do NOT copy `WebSurfaceSchema` wholesale (web's
    `prod_url`/`promote_gate` are web-promote concepts that don't apply). Fields:
    `enabled: boolean`, `build {command, output_dir}`, `test {command}`, `deploy`
    (discriminated union of `github_releases {repo, tag_pattern}` + `local_dir {dir}`), all
    `.strict()`.
  - Confirm in `release-runner.ts` that a successful `deploy` advances any surface to `uploaded`
    (it is surface-agnostic — expected no edit needed). If it is surface-gated, that's a contract
    request, not an edit you make.
- **Done when:** a tagged `desktop` release runs build → test → deploy and lands at `uploaded`
  with the deploy artifact recorded; `getAdapter("desktop")` returns the adapter (no throw);
  desktop config typos are rejected by the strict schema.
- **Verify:** `npx vitest run tests/surface-desktop.test.ts && npm run typecheck`
- **Open questions:** exact `gh release create` argv for a Tauri bundle (one artifact vs. a
  platform matrix — start single-artifact); whether the Tauri toolchain is available in the test
  env (mock the runner in tests; don't shell out to a real `tauri`).

---

### Lane B — Android production-track review poll   ·   ready (after prep-commit)

- **Scope:** Add a Play Store review poll for **production-track** Android that drives
  `uploaded → in_review → shipped_dark` — the mirror of the existing iOS App Store Connect poll.
  Non-production tracks (internal/alpha/beta) are unaffected; they keep resting at `uploaded`.
- **Owns (exclusive write):**
  - `src/halyard/coordinator/sources/play-review.ts` (new — the source + pure status→transition map)
  - `src/halyard/coordinator/sources/play-client.ts` (new — `PlayClient` iface + `LivePlayClient`)
  - `src/halyard/coordinator/sources/index.ts` (register the source; add `makePlayClient` dep)
  - `src/halyard/surfaces/android.ts` (refresh the outdated "not wired here" comment at ~lines 14-18 — comment only)
  - `tests/play-review.test.ts` (new)
- **Reads (no write):** `src/halyard/coordinator/sources/asc-review.ts` and
  `src/halyard/coordinator/sources/asc-client.ts` (the exact pattern to mirror),
  `src/halyard/coordinator/reconcile.ts` (the `ReconcileSource` / `TransitionProposal` contract),
  `src/halyard/contracts/release.schema.ts` (`external_refs.play_version_code` / `play_track` are
  now typed by the prep-commit), `tests/asc-review.test.ts` (the test to mirror).
- **Shared contract:** none. (`flag-poll.ts` already excludes production Android via the
  prep-commit — do not touch it.) `app-config.schema.ts` is **not** yours and needs no change:
  the opt-in is `track === "production"`, not a new config field.
- **Depends on / blocks:** depends on the prep-commit being merged; blocks nothing.
- **Build notes:**
  - `play-review.ts`: a `playReviewSource(client: PlayClient): ReconcileSource` with
    `appliesTo = surface === "android" && track === "production" && POLLABLE_STATES.has(state)`,
    where `POLLABLE_STATES = {uploaded, in_review, rejected}` (same set as ASC). The production
    track is read from `release.external_refs.play_track` (recorded at deploy).
  - **Must read `release.external_refs.play_version_code`** to identify the build — unlike ASC
    (whose client ignores the release and queries the latest app version), the Play API needs
    `package + versionCode`. If `play_version_code` is absent (deploy failed before recording
    it), `poll` returns `[]` — no proposal.
  - Keep the **status→transition map a pure function** in `play-review.ts`, separate from the
    client (mirror `mapReviewStatusToTransition` in asc-review.ts). Define a normalized
    `PlayReviewStatus` enum decoupled from Play's raw vocabulary; the raw→normalized translation
    lives in `LivePlayClient`. Map Play's statuses **explicitly** — do not assume they match
    ASC's names. Map to the same shape: in-progress/queued → `in_review`; approved/published →
    `shipped_dark`; rejected/halted → `rejected`; still-processing → no transition.
  - `play-client.ts`: `PlayClient.getReviewStatus(release): Promise<PlayReviewStatus>`. Auth uses
    a **service-account JSON** (not ASC's JWT): the workflow resolves
    `app.surfaces.android.service_account_ref` into a runtime env var (e.g.
    `PLAY_SERVICE_ACCOUNT_JSON` / `SUPPLY_JSON_KEY_DATA`, matching the existing Android upload
    path); `LivePlayClient` reads + parses it and authenticates via the Google API client. Never
    logged.
  - `sources/index.ts`: add `makePlayClient?: (app) => PlayClient` to `SourceDeps`, a
    `defaultMakePlayClient`, and push `playReviewSource(makePlay(app))` inside the per-app loop
    **only when** `app.surfaces.android?.enabled && app.surfaces.android.track === "production"`.
  - **Rejection:** a `rejected` production release stays pollable (re-enters `in_review` on
    resubmit) but the poll does not auto-resubmit — matches ASC. Document it.
- **Done when:** a production-track Android release polls Play and advances
  `uploaded → in_review → shipped_dark`; a non-production release is untouched (no source
  registered for it); a release missing `play_version_code` yields no proposal; tests cover each
  with a fake `PlayClient`.
- **Verify:** `npx vitest run tests/play-review.test.ts && npm run typecheck`
- **Open questions:** the exact Play Developer API field for review status and its enum values
  (map explicitly; reference the Play API docs); the precise runtime env-var name the Android
  workflow exposes the service account under (reuse whatever the existing `supply` upload path
  uses — check `fastlane/Fastfile` / `LAUNCH-READINESS.md`).

---

## What is NOT in this batch (deferred — spine work, serial session)

- **`service` backend** — replaces git-backed persistence behind record-store/launch-store/
  reconcile/state-machine. Large, spine-wide.
- **Web auto-promote** — the `promote_gate: false` path (`uploaded → live` on deploy instead of
  resting for a flag flip). A state-machine/flag-poll/reconcile change with no `SurfaceAdapter`
  hook to hang it on; collides with the spine. (Not the "alias preview to prod_url" idea — that
  framing was wrong and is dropped.)
