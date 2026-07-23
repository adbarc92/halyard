# Ship audit + swarm handoff — 2026-06-25

Two things in one doc:
1. **Audit verdict** — is Halyard ready to ship, and what's left? (independently re-verified today)
2. **Swarm handoff** — the remaining *buildable* work carved into non-colliding parallel lanes.

The headline: **engineering is done and green.** Shipping the first app is *operator execution*
(a serial, human-driven runbook — not swarmable) plus **one account action**. The only work that
parallelizes is forward-looking / post-launch, and most of it is **blocked**. Read both halves;
don't dispatch a swarm expecting it to "ship the project" — it won't, because shipping isn't code.

---

## Part 1 — Audit verdict

### Re-verified green today (2026-06-25, this checkout, not trusting the docs)

| Check | Command | Result |
|---|---|---|
| Types | `npm run typecheck` | ✅ exit 0 |
| Build | `npm run build` | ✅ exit 0 |
| Core suite | `npm test` | ✅ **317 passed** / 75 files |
| Web console | `npm run web:test` | ✅ **74 passed** / 10 files |
| Full-spine dry run | `npm run verify:launch` | ✅ **12/12 GREEN** (dark → flip → live → publicity staged → crash spike yields proposal, no auto-action) |

Repo hygiene: `main` is clean; **all PRs merged through #48**; `origin/main..HEAD` is empty (the
local `docs/readme-web-console-auth` branch is just a stale pointer at an already-merged commit).
The five load-bearing invariants are enforced in code and covered by tests (the `verify:launch`
walk exercises every one). **The memory/docs claim of "feature-complete & certified green" is
accurate.**

### What's left to actually ship — and none of it is a code change

Shipping = wiring real providers behind the existing ports and walking the launch runbook. This is
**operator-driven and serial**; do not try to swarm it.

**A. One account action (a human with billing access, not an agent):**
- **GitHub Actions CI is billing-blocked.** PRs #44/#45 (and onward) merged on *local* verification
  only. Until cleared (Settings → Billing), CI does not guard PRs. This is the single most important
  non-engineering gap. → `docs/ROADMAP.md` "Operational" note.

**B. Operator execution (guided by [`docs/LAUNCH-HANDOFF.md`](../LAUNCH-HANDOFF.md), serial):**
1. Operator supplies the first app's identifiers (iOS: name+slug, `bundle_id`, `asc_app_id`,
   `team_id`).
2. Scaffold `apps/<slug>/app.yml` (iOS-only) — today by hand-copying `apps/aurora/app.yml`; *or*
   with `halyard app init` **if Lane A below has shipped it**.
3. Set real secrets in env / GitHub secret store (never in YAML — invariant #4). The
   secrets-by-integration table is in [`docs/LAUNCH-READINESS.md`](../LAUNCH-READINESS.md).
4. `halyard preflight --probe off` → fix config gaps → `halyard preflight` for live reachability,
   one integration at a time until every required row is green.
5. Set `HALYARD_APPROVAL_WEBHOOK` (a gate you can't reach from your phone isn't a gate) and confirm
   a test notification lands.
6. Walk [`docs/LAUNCH.md`](../LAUNCH.md): create launch (flag born OFF) → ship dark → **operator
   flips** → approve third-party posts → watch → rollback path ready.

None of B is engineering and none of it parallelizes — each step gates the next and several need
real credentials only the operator holds.

### What's genuinely unbuilt (all post-launch, none blocking)

Confirmed by inspection, not just the roadmap: there is **no `halyard app init` / `onboard`
command** (CLI dispatch in [`src/halyard/cli.ts`](../../src/halyard/cli.ts) handles `release,
reconcile, launch, flip, maintenance, triage, status, payments, preflight, license, queue, approve`
— nothing else). The forward-looking items are Part 2.

---

## Part 2 — Swarm handoff (forward-looking / post-launch work)

### Decomposition summary

| Lane | What | State |
|---|---|---|
| **A** | R-ONBOARD — `halyard app init` scaffolder | ✅ **ready** (dispatch now) |
| **B** | Web console auth hardening (rate-limit + token-rotation slice) | ✅ **ready** (optional; YAGNI-flagged) |
| **C** | Multi-writer concurrency control (optimistic locking) | ⛔ **blocked** — needs the hub server to test against |
| **D** | R4 net-new vendors/channels | ⛔ **blocked** — open only when a specific vendor is chosen; needs factory/config prep first |
| **E** | The hub server itself | ⛔ **out of repo** — greenfield, separate project (DB/deploy/auth) |

Only **A and B are dispatchable now**, and they have **zero write-overlap** (A is CLI/`src/`, B is
`web/`). The one shared file they'd both touch is `docs/ROADMAP.md` — handled as a contract below.
A two-lane swarm is legitimate but small; if you only want the highest-value item, dispatch **Lane A
alone** and skip the swarm machinery.

### Shared contract

- **`docs/ROADMAP.md`** → **owned by Lane A** (integrates last among the two). Each lane that
  completes files an append-only request: "strike my roadmap item." Lane A applies both strikes in
  one edit at integration. No other lane writes this file.
- **`src/halyard/cli.ts`** (command registry + usage block) → **owned by Lane A exclusively.** Lane
  B is web-only and never touches it, so there's no contention — no separate owner lane needed.
- **`README.md`** (root, command cheat-sheet) → **Lane A** edits it (it adds a user-facing command);
  Lane B touches only `web/README.md`. No overlap.

### Integration order

1. Merge **Lane B** (web-only, self-contained) any time.
2. Merge **Lane A** last of the two — it applies both ROADMAP strikes in one write.
3. Reconcile: `npm run typecheck && npm test && npm run web:test && npm run verify:launch` over the
   merged whole; confirm `docs/ROADMAP.md` holds exactly the intended union (both items struck,
   nothing clobbered).

---

### Lane A — R-ONBOARD (`halyard app init`)   ·   **ready**

- **Scope:** Add a `halyard app init` (a.k.a. `onboard`) command that interactively scaffolds
  `apps/<slug>/app.yml` so a first-time operator lands a valid config without hand-copying
  `apps/aurora/app.yml` and pruning surfaces. Full design intent: `docs/ROADMAP.md` § R-ONBOARD.
- **Owns (exclusive write):**
  - new module under `src/halyard/onboard/` (e.g. `onboard/init.ts` + a template emitter)
  - `src/halyard/cli.ts` (add the `app init` dispatch branch + usage line)
  - new tests `tests/onboard*.test.ts`
  - `README.md` (add `halyard app init` to the cheat-sheet)
- **Reads (no write):** `apps/aurora/app.yml` (shape to mirror), `docs/LAUNCH-READINESS.md`
  (secrets-by-integration table, to print the right env vars per chosen surface),
  `src/halyard/config/` (the app.yml schema/loader — emit what it validates).
- **Shared contract:** `docs/ROADMAP.md` → Lane A owns it; on completion strike the R-ONBOARD entry.
- **Depends on / blocks:** none. Unblocks operator step B-2 above (nicer onboarding) but is not
  required for it.
- **Done when:** a brand-new operator runs one command, answers prompts (name+slug; which surfaces:
  iOS/Android/web/desktop), and gets `apps/<slug>/app.yml` containing **only** the chosen surfaces,
  each pre-filled with the correct `SECRET:NAME` refs and `REPLACE_ME` markers for operator-supplied
  identifiers — and `halyard preflight --probe off` **accepts** it. Refuses to overwrite an existing
  file without `--force`. Never prompts for or writes a real secret value (invariant #4). On finish,
  prints the exact env vars/secrets to set for the chosen surfaces and runs
  `halyard preflight --probe off`.
- **Verify:** `npm test` (new onboard tests pass) **and** an end-to-end check: run the command for a
  throwaway slug in a temp dir → `halyard preflight --probe off <that app>` exits clean → confirm no
  real-credential literals in the emitted YAML (only `SECRET:` refs + `REPLACE_ME`).
- **Notes / open questions:** Prompt mechanism — is there an existing interactive-input helper, or
  add one? Keep it non-interactive-testable (accept flags/stdin so tests don't need a TTY). Decide
  `init` vs `onboard` verb (roadmap allows either; pick one, alias optional). Match the existing
  if-chain dispatch style in `cli.ts` — don't introduce a command framework.

### Lane B — Web console auth hardening (rate-limit + token-rotation slice)   ·   **ready (optional)**

- **Scope:** Harden the shipped single-shared-token console auth (PR #45) with the **non-speculative
  slice only**: login rate-limiting (throttle/lock brute-force on `/login`) and a documented
  token-rotation path. **Explicitly out of scope:** multi-user, RBAC, OAuth — those are YAGNI for a
  single operator (`docs/ROADMAP.md` § "Web console auth hardening";
  spec `docs/superpowers/specs/2026-06-15-web-console-auth-design.md`). Only build this lane if the
  operator actually wants it; the current model is intentionally minimal.
- **Owns (exclusive write):**
  - `web/src/lib/server/auth.ts` and a new `web/src/lib/server/ratelimit.ts` (or similar)
  - `web/src/routes/login/+page.server.ts` (wire the limiter)
  - new/extended tests in `web/tests/` (e.g. `web/tests/ratelimit.test.ts`, extend `login.test.ts`)
  - `web/README.md` (document rotation + rate-limit behavior)
- **Reads (no write):** `web/src/hooks.server.ts`, `web/src/lib/server/clock.ts` (use the injectable
  clock so the limiter is testable without real time).
- **Shared contract:** `docs/ROADMAP.md` → owned by **Lane A**; Lane B files a request to strike the
  hardening item. **Do not edit `docs/ROADMAP.md` directly.**
- **Depends on / blocks:** none. Fully isolated to `web/` — no overlap with Lane A.
- **Done when:** repeated bad-token logins are throttled/locked (proven by a test using the
  injectable clock, not wall-clock), the existing 74 web tests still pass, and `web/README.md`
  documents how to rotate `HALYARD_CONSOLE_TOKEN` without a redeploy outage.
- **Verify:** `npm run web:test` — new rate-limit/rotation tests pass, all prior tests still green.
- **Notes / open questions:** Confirm with the operator this slice is wanted before building (YAGNI).
  Keep storage in-memory/per-process (console is single-instance, loopback-by-default) — don't pull
  in a datastore. Preserve the constant-length token compare and `SameSite=Lax` CSRF posture already
  in place; don't regress them.

### Lanes C / D / E — blocked, documented for completeness (do NOT dispatch)

- **Lane C — Multi-writer concurrency control.** Service-backend adapters are last-writer-wins by
  design. True concurrency needs optimistic locking **and a running hub server to test against**,
  which doesn't exist yet. **Blocked on Lane E.** Spec:
  `docs/superpowers/specs/2026-06-10-service-backend-swarm-handoff.md`.
- **Lane D — R4 net-new vendors/channels.** New flag providers / publishers / store backends behind
  the existing ports. A genuine parallel swarm *once opened*, but gated behind small factory/config
  prep and **"open only when a specific vendor is chosen"** — there's no target today, so it's not
  ready. Context: `docs/superpowers/specs/2026-06-11-post-r3-roadmap-handoff.md`.
- **Lane E — The hub server.** Greenfield (DB, deploy, auth), **out of this repo** — a separate
  project. Not a lane here; listed because C depends on it.

---

## Rules of the road (paste into every dispatched agent)

1. **Stay in your lane.** Write only files your lane owns. Need a change elsewhere? Record a contract
   request in your final report — don't edit it.
2. **Branch/worktree per lane.** One feature branch (or git worktree) per lane; never commit to
   `main`. Per the operator's global rules: branch + PR, no `Co-Authored-By`, no "Generated with…"
   attribution.
3. **`docs/ROADMAP.md` is append-only and single-owner (Lane A).** Only Lane A writes it; others
   request the strike.
4. **Don't widen scope.** Build only your lane's items; report anything else you spot.
5. **Honor the five invariants** (see `docs/LAUNCH-HANDOFF.md`): gates stay boolean, no auto-post to
   third-party, secrets are `SECRET:NAME` refs only, coordinator is a projection. A shortcut that
   breaks one is not allowed.
6. **Verify before claiming done.** Run your lane's Verify command and report the real output.

> Dispatching a swarm is opt-in and costs real tokens. This document is complete and safe on its
> own. If you want execution: Lane A is the high-value single dispatch; Lanes A+B are the full
> ready swarm; C/D/E stay parked until their blockers clear.
