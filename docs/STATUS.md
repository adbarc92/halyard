# Halyard — Project Status

> Canonical, living status. The **State summary** below is rewritten in place each session; the
> **Session log** is appended newest-first. This supersedes dated snapshot files under `docs/handoff/`
> (which remain as frozen history). Do not duplicate artifacts here — link them.

---

## State summary

_Last updated: 2026-07-23_

**TL;DR.** Halyard is feature-complete; the multi-provider launch hub **merged to `main` (PR #50,
2026-07-09)**. The current thread is **publication-prep** — making the repo public + pinned for the
job search — open as **PR #51** on branch `publication-prep`. The repo is still **PRIVATE**.

**Readiness.** Green offline, no live credentials required:
- `npm run build` ✅ · `npm run typecheck` ✅ · `npm test` ✅ · web `npm run web:test` ✅
- **Clean-clone verified:** a fresh `git clone` → `npm ci` + `build` + `test` all exit 0
  (**437 pass**, the portfolio test skips without `apps.private/`).
- `npm run demo` ✅ · `halyard preflight --probe off` ✅

**Publication-prep (PR #51) — what changed this session:**
- **State machine made legible:** README ASCII diagram → Mermaid `stateDiagram-v2`, **checked against
  `LEGAL_TRANSITIONS` by `tests/state-diagram-doc.test.ts`** so it can't drift. New
  `tests/recovery.test.ts` demonstrates failed-transition recovery.
- **Config, not fixtures:** the 12 real portfolio apps moved to git-ignored **`apps.private/`** (only the
  `aurora` example ships; the spine discovers `apps/<slug>/app.yml` at runtime); `.context-curator/`
  untracked; the embargoed org identity genericized to `Example`/`com.example.*`/`example.com` —
  **0 occurrences in tracked files**.
- **Recruiter-first README**; repo description + topics set (`state-machine`,`event-driven`,`release-automation`).

**Open PRs.**
- **[#51](https://github.com/adbarc92/halyard/pull/51)** — publication-prep (this session). Awaiting review/merge.
- ~~[#50](https://github.com/adbarc92/halyard/pull/50)~~ — launch hub, **merged 2026-07-09**.

**Known gaps / caveats.**
- **Git history still carries the embargoed name + a 2.5 MB binary `store.db`** (17/209 commits). Plan:
  **squash to a fresh "Initial public release" commit as the last step before flipping public** (the
  history rewrite is the user's to run; no filter-repo/BFG installed, squash needs neither).
- **`v0.1.0` tag still uncut.**
- **CI (G-CI):** verify GitHub Actions billing actually runs checks on this repo.
- Real-ops now needs `--apps-dir apps.private` (the real catalogue moved out of `apps/`).
- Live provider legs (Gate #2 / G-CREDS) unverified — real creds per app at launch time.

**Next steps (operator/human — engineering is done):**
1. Review + merge **PR #51**.
2. **Squash history** to evict the embargoed name + binary, then **flip the repo public + pin it**.
3. Cut **`v0.1.0`**.
4. Per-app go-live: `preflight --probe off` → set real Gate #2 secrets (see
   [`docs/CREDENTIALS.md`](CREDENTIALS.md)) → `preflight` (live) → `release run`.

Deeper resume context: memory `halyard-launch-status` and
[`docs/handoff/handoff-2026-07-08-launch-hub-swarm.md`](handoff/handoff-2026-07-08-launch-hub-swarm.md).

---

## Session log

### 2026-07-23 — Publication-prep for a public + pinned repo (branch `publication-prep`, PR #51)
Prepped Halyard to go public for the job search; repo still PRIVATE. Two threads:
- **Legibility (resume claims):** README ASCII state diagram → Mermaid `stateDiagram-v2`, verified against
  the exported `LEGAL_TRANSITIONS` by `tests/state-diagram-doc.test.ts` (drift-proof); added
  `tests/recovery.test.ts` (forces a failed transition → idempotent recovery). The old ASCII diagram
  under-drew the machine by 4 edges.
- **Public-consumption refactor (config, not fixtures):** 12 real portfolio apps → git-ignored
  `apps.private/` (spine discovers `apps/` at runtime → only the `aurora` example ships);
  `.context-curator/` untracked; org identity genericized to `Example` (0 in tracked files); portfolio
  test repointed + skips when the private catalogue is absent.
- **README** rewritten recruiter-first (approved); repo description + topics set.
- **Verified:** fresh `git clone` → `npm ci` + build + test all exit 0 (437 pass); secrets scan clean.
- **Remaining (operator):** squash git history to evict the embargoed name + a 2.5 MB binary before
  flipping public; flip public + pin; cut `v0.1.0`.

### 2026-07-08 — One-stop launch-hub swarm shipped (branch `integration/swarm-2026-07-08`, PR #50)
Built the multi-provider control plane from `halyard-launch-hub-SWARM-HANDOFF.md` as a swarm: one
hand-built shared contract, then 13 lanes across two parallel waves with reconciliation between them.
- **L0** (`517a39c`) — deploy-provider registry + mobile-toolchain port + desktop signing seam; adapters
  delegate; closed deploy unions replaced by registry-validated `deploy.target`. Regression-green.
- **Wave A** (`186728f`) — providers command/vercel/fly/github_pages/itch/aws (dry-run tested), `eas`
  toolchain, macOS/Windows signing, preflight `deploy:<surface>` gate, Slack/Discord approval notifiers
  (invariant #5 intact), `HALYARD_SELF_HOST` entitlement (resolves G-LICENSE).
- **Wave B** (`8442334`) — 12 apps onboarded; PROVIDERS/CREDENTIALS docs, LICENSING self-host section,
  README, `scripts/demo.ts` provider-family walk.
- **Result:** 334 → 451 tests; build/typecheck/demo/preflight all green offline. PR #50 opened; handoff
  at `docs/handoff/handoff-2026-07-08-launch-hub-swarm.md`. Remaining = operator (merge, CI, tag, live creds).

### Prior history (pre-STATUS.md)
This file was created 2026-07-08. Earlier milestones — feature-complete build (PRs #11–#27), web console
(#28/#45), deferred leaf-lanes (#29–#31), final audit (#44), R-ONBOARD `halyard app init` + web-auth
hardening (2026-06-25 swarm, #49) — are recorded in `docs/handoff/handoff-2026-06-*.md` and the
`docs/ROADMAP.md`; not duplicated here.
