# Handoff — 2026-06-19 → next session: onboard the first real iOS app

**For:** future-you / a fresh agent resuming Halyard's first real launch.
**One-line state:** repo tidied, `main` certified green, first launch scoped to **a new iOS app**;
next step is to **scaffold its config from the operator's identifiers** (which the operator will
have this session).

## Start here (don't re-derive)

1. Read [`docs/LAUNCH-HANDOFF.md`](../LAUNCH-HANDOFF.md) — the **"Resuming: onboarding the first real
   app (iOS)"** section at the top is the live entry point. It already encodes the scope decision and
   the first step, so you don't need to re-ask "which app / which surfaces."
2. Skim [`docs/ROADMAP.md`](../ROADMAP.md) — item **R-ONBOARD** is the relevant next feature.
3. Session memory (auto-loaded at start): `halyard-launch-status` note carries the 2026-06-19 resume
   paragraph.

## What happened this session

- **Repo tidy:** removed 6 stale agent worktrees under `.claude/worktrees/`; deleted 40 merged
  branches; added `.claude/` to `.gitignore`.
- **Re-certified `main` green:** `typecheck` clean · 317 core tests (`test:coverage`, 86.97% stmts) ·
  74 web tests (`web:test`, incl. the #45 auth tests) · `verify:launch` 12/12. Total **391 tests**.
- **Docs:** created `docs/ROADMAP.md`; added the iOS resume section to `LAUNCH-HANDOFF.md`; refreshed
  its current-state (PRs through #45, console-auth gap closed).
- **Shipped as PR #47** — https://github.com/adbarc92/halyard/pull/47 (docs/config only, not yet
  merged). See the PR for the exact diff; not duplicated here.

## The actual next task

The operator wants to launch **a new iOS app**. They will supply this session: app **name + slug**,
**`bundle_id`**, **`asc_app_id`** (may be a placeholder if not yet registered in App Store Connect),
**`team_id`**. Then:

1. Scaffold `apps/<slug>/app.yml` — **iOS surface only** — copying the shape of
   [`apps/aurora/app.yml`](../../apps/aurora/app.yml), pruning Android/web/desktop. Credentials stay as
   `SECRET:NAME` refs (`MATCH_REPO`, `ASC_API_KEY`) — never real values (**invariant #4**).
2. `halyard preflight --probe off` (config-only) → fix structural gaps → set iOS secrets in env →
   `halyard preflight` for live reachability.
3. Follow [`docs/LAUNCH.md`](../LAUNCH.md) from there.

**Open decision for the operator:** build **R-ONBOARD** (`halyard app init`) first so onboarding this
app also delivers the feature, **or** hand-scaffold the YAML now and generalize later. Ask; don't
assume.

## Watch-outs

- **iOS reaches `shipped_dark` only after an App Store version is submitted for review.** A brand-new
  app needs metadata/screenshots present in App Store Connect for the first submission.
- **The operator drives all outward/irreversible actions** (the real `halyard flip`, tag pushes,
  third-party posts). You guide; confirm before anything outward-facing. Honor the **five invariants**
  (listed in `LAUNCH-HANDOFF.md`).
- **GitHub Actions CI is billing-blocked** — recent PRs (incl. #47) merged/verified locally only.
  Clear it in Settings → Billing so CI guards future PRs.
- **Repo rules:** branch + PR (never push `main`); no `Co-Authored-By` / "Generated with…" lines.

## Loose ends (operator's call, not blocking)

- **PR #47** is open and unmerged — merge it (or ask) before starting new doc edits.
- Three unmerged branches remain, likely superseded: `docs/launch-prep` (+1, real unmerged launch-prep
  docs worth a look), `fix/audit-polish` (+3), `integration/deferred-leaf-lanes` (+3). I can diff any
  against `main` to decide keep/delete.

## Suggested skills for the next session

- **`brainstorming`** then **`writing-plans`** — if the operator chooses to build R-ONBOARD
  (`halyard app init`) before launching; design the command shape before coding.
- **`test-driven-development`** — for building R-ONBOARD (the repo is TDD-disciplined; 391 tests).
- **`run`** — to drive/inspect the `halyard` CLI (`preflight`, `status`) once config exists.
- **`verify`** — to validate any new user story (e.g. an onboarding story) against acceptance criteria.
