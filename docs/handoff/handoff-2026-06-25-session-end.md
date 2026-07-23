# Session Pickup — 2026-06-25 (ship audit + post-launch swarm)

**Branch:** `integration/swarm-2026-06-25` (pushed; **PR #49 open** against `main`)
**Prior handoff:** [`handoff-2026-06-25-ship-audit-swarm.md`](handoff-2026-06-25-ship-audit-swarm.md) — the audit verdict + lane decomposition that produced this work.

> ⚠️ **Local `main` is stale** (behind `origin/main` by merged PR #48). Next session: `git fetch`
> and treat **`origin/main`** as truth. This checkout currently sits on the integration branch.

## Where we are

This session audited ship-readiness (verdict: **engineering done & green**; shipping is operator
execution + one account action), then ran a 2-lane swarm for the only buildable post-launch work
and resolved a security review. Everything is committed and pushed; nothing is in flight.

| Item | Status | Commit |
|---|---|---|
| Lane A — `halyard app init` (R-ONBOARD) | done | `c74f3cf` (merge `3f8b424`) |
| Lane B — web auth hardening (rate-limit + token rotation) | done | `a54ccee` (merge `af8f540`) |
| ROADMAP reconciled (R-ONBOARD struck, auth line narrowed) | done | `e1dc264` |
| Security-review fixes (#1 Bearer bypass, #2 fail-open key, #3 map cap) | done | `4ea4d39` |

Green on the merged whole: `typecheck` 0 · `npm test` **334** · `npm run web:test` **91** ·
`verify:launch` **12/12** · `svelte-check` 0/0.

## Real issues caught this session

- **Base mismatch during integration:** local `main` was behind `origin/main`; building the
  integration branch off local `main` pulled in 3 unrelated doc files. Fixed by rebasing the
  integration branch onto `origin/main`. (Lesson: base off `origin/main`, not local `main`.)
- **Security review (post-push) found a real auth hole:** the login rate-limiter only guarded the
  `/login` form; the `Authorization: Bearer` path in `hooks.server.ts` was unthrottled, so the
  console token was brute-forceable unthrottled at any endpoint — the limiter was cosmetic. Closed
  by routing the Bearer path through the same per-address limiter (`4ea4d39`). Two lower-severity
  items (shared-bucket self-lockout DoS; unbounded bucket map) fixed in the same commit.

## Remaining items (the punch list)

**Must-do to ship (not engineering):**
1. **Merge PR #49.** Open, `MERGEABLE`. Review + merge to `main`. CI is billing-blocked so it merges
   on local verification (as #44–#48 did).
2. **Unblock GitHub Actions CI billing** (Settings → Billing). The single most important
   non-engineering gap — until cleared, no PR is CI-guarded. Account action, not code.
3. **Operator-driven real launch.** Start at [`LAUNCH-HANDOFF.md`](../LAUNCH-HANDOFF.md). First app =
   a new **iOS** app; operator supplies `bundle_id` / `asc_app_id` / `team_id`. Onboarding is now
   one command: **`halyard app init`** (shipped this session) → set secrets → `halyard preflight`.

**Deferred / blocked (do NOT build without a trigger):**
4. Lane C — multi-writer concurrency control → **blocked** on the hub server (out of repo).
5. Lane D — R4 net-new vendors/channels → open **only when a specific vendor is chosen**.
6. Lane E — the hub server → greenfield, **separate project**.

**Minor follow-ups raised by the lanes (cosmetic; not blocking):**
7. The auth spec `docs/superpowers/specs/2026-06-15-web-console-auth-design.md` still lists
   rate-limiting under "Non-goals (YAGNI)" — now stale (it's implemented). One-line doc fix.
8. `preflight` resolves `apps/` relative to cwd with no `--apps-dir` override, so the `app init`
   auto-preflight only fires when scaffolding into the default `apps/` dir. Known constraint.

**Housekeeping:**
9. Stale local branches left for the operator to prune: `docs/launch-prep`, `fix/audit-polish`,
   `integration/deferred-leaf-lanes` (likely superseded).
10. Environment caveat (not repo): `ANTHROPIC_API_KEY` is set, which disables claude.ai connectors
    (it takes auth precedence). Unset it if org connectors are wanted.

## What to pick up next

Merge PR #49, then either (a) clear CI billing, or (b) resume the operator launch runbook at
`LAUNCH-HANDOFF.md` with `halyard app init` for the first iOS app. No engineering remains to ship.

## Commands worth remembering

`npm run typecheck` · `npm test` (334) · `npm run web:test` (91) · `npm run verify:launch` (12/12)
· `npm run check --workspace web` (svelte-check) · `halyard app init --name <n> --slug <s>
--surfaces ios` (new; flag-drivable, non-TTY).
