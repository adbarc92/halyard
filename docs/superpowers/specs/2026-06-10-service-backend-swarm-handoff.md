# Handoff — R3 service backend (interface-first mini-swarm)

**Authored 2026-06-09 for the next session.** Executes §R3 of the forward roadmap in
[`2026-06-10-remaining-work-swarm-handoff.md`](./2026-06-10-remaining-work-swarm-handoff.md),
now that that handoff's parallel batch shipped: Lane 1 (per-surface review-poll cron, PR #34),
Lane 2 (web live flag provider + sub-path, PR #33), and the orchestrator's contract-request
extraction (shared `makeFlagClient`, PR #35) are all merged to `main`, green at 258 root + 30 web
tests.

---

## The shape of this work (read this first)

R3 — the `service` backend (`coordinator.backend: service`, currently a hard-throw) — is the one
large remaining item, and **it does not parallelize as-is.** It parallelizes *only after a serial
contract exists.* So this handoff has **two phases**, and they are not symmetric:

- **Phase 0 — Port extraction · SERIAL · SOLO · lands first.** Extract persistence **ports** behind
  the current git implementation, route every caller through them, keep git as the default adapter.
  **Zero behavior change; all 258 root + 30 web tests stay green.** This is the shared contract every
  Phase-1 lane hangs off. It touches the whole spine, so it **cannot be split** — two agents would
  collide on `cli.ts` / `reconcile.ts` / every caller. **This is the next session's actual
  dispatch-ready job.**
- **Phase 1 — Service-adapter fan-out · THE SWARM · BLOCKED.** One `service` adapter per port, in
  parallel non-overlapping lanes (each owns one adapter file + its tests). Genuinely independent —
  but **blocked** on two gates: (1) Phase 0 merged (the ports must exist), and (2) a decision nobody
  has made yet: **what *is* the "service" backend?** (a hosted REST API? Supabase/Postgres? a KV?).
  The adapter bodies can't be written until that's pinned.

**Honest consequence:** tomorrow you **execute Phase 0** (serial). Phase 1's lanes are fully
specified below so they're dispatch-ready the moment both gates clear — but do **not** fan out a
swarm before then. Manufacturing Phase-1 lanes on top of a non-existent port contract is exactly the
false-independence failure the swarm method exists to prevent. This mirrors the prep-commit→fan-out
pattern this repo already used for the flag-poll and web-console lanes.

---

## The one design distinction that makes or breaks this (I/O vs. pure transform)

Today's store modules **mix two different things** in one file:

- **I/O** — the functions that touch the `state/` dir: `readRelease`/`writeRelease`,
  `readLaunch`/`writeLaunch`/`scanLaunchIds`, `readProposal`/`writeProposal`/`listProposals`,
  `readAnnounced`/`markAnnounced`, `appendToCanon`, `FileNotifier.notify`, and the `*Path` helpers.
- **Pure transforms** — functions that take a record and return a new record, touching no disk:
  `appendTransition`, `isCurrentState`, `newRelease`, `newLaunch`, `linkRelease`,
  `bindReleaseToLaunch`, and the `dedupKey` builder.

**Only the I/O belongs in the port.** The pure transforms stay as free functions, unchanged, and
**every adapter imports them verbatim.** A `ServiceRecordStore` reuses `appendTransition` exactly —
it only changes *where the bytes land*, never *how a transition is computed*. This is what keeps each
service adapter tiny and what makes **invariant #3 (the `(release_id + transition)` dedup key) hold
identically across both backends** — the key is computed by the same pure code regardless of where
it's stored. Get this boundary wrong and you'll re-derive dedup logic per adapter and the invariants
will drift. Get it right and Phase 1 is half a dozen thin lanes.

**The pattern already exists in the tree — copy it.** `flags/types.ts` defines the `FlagClient`
interface (`getState` / `ensureFlag` / `setState`); `FlagFileClient` is the git adapter and
`HttpFlagClient` is *already* the service adapter (wired through config by `makeFlagClient`, shipped
in PR #35). **The flag store is the template for all the others** — and it means Phase-1's flag lane
is nearly free (see Lane F).

---

## The five invariants (preserve across BOTH phases and BOTH backends)

1. **Coordinator is a projection, never an authority** — a store read is a projection; validate it
   on the way in (`*.parse()`), never trust it blindly.
2. **Gates are deterministic booleans** — no model decides ship/promote/flip/post.
3. **Every transition carries a `(release_id + transition)` dedup key** — re-applying a transition is
   a no-op. The service adapter must enforce this under *its* consistency model (server-side
   uniqueness or safe check-then-write), not assume filesystem atomicity.
4. **Config holds `SECRET:NAME` references, never values** — resolved at runtime, never logged. A
   service backend's credentials come from the secret store the same way `flags.api_key_ref` does.
5. **Owned-vs-third-party is the publicity safety boundary** — unchanged by persistence; just don't
   let a store refactor leak an offline publisher where an HTTP one is configured.

---

## Phase 0 — Port extraction   ·   SERIAL · SOLO · lands first   ·   ready

**One agent. Do not split.** Every caller changes; this is the shared contract. No feature behavior
changes — this is a pure refactor proven by the existing suite staying green.

### Goal
Define persistence **ports** (one interface per store family — methods are the **I/O functions
only**), a **backend factory** that returns the adapter set, make **git the default adapter**, and
**route every caller through the port**. Then `backend: service` throws from *one* place (the
factory) instead of twelve `assertSupportedBackend` call sites.

### Ports to define (mirror the `FlagClient` shape)
| Port | Methods (I/O only) | Pure helpers that stay FREE functions |
|---|---|---|
| `RecordStore` | `read(id)`, `write(rel)`, `path(id)` | `appendTransition`, `isCurrentState`, `newRelease` |
| `LaunchStore` | `read(id)`, `write(l)`, `scanIds()`, `path(id)` | `newLaunch`, `linkRelease`, `bindReleaseToLaunch` |
| `ProposalStore` | `read(id)`, `write(p)`, `list()`, `path(id)` | — (see note on `proposeOnce`/`reconcileProposal`) |
| `LedgerStore` | `readAnnounced(launchId)`, `markAnnounced(launchId, key)` | — |
| `CanonStore` | `append(entry)` | `readVoiceCanon` reader stays as-is |
| `Notifier` | `notify(proposal)` | already class-shaped (`FileNotifier`) |
| `FlagClient` | **already done** (`getState`/`ensureFlag`/`setState`) | — the template; leave it |

- **`proposeOnce` / `reconcileProposal`** are I/O-*orchestrating* (read-then-maybe-write with the
  dedup decision). **Recommendation:** keep them as **free functions that accept a `ProposalStore`**,
  not as adapter methods — so the orchestration logic lives once and every adapter stays a dumb
  read/write. Same for `appendToCanon`'s "already present?" check. Document whichever you choose.
- **`scanReleaseIds`** currently lives in `reconcile.ts` (not `record-store.ts`). Decide whether it
  moves onto `RecordStore.scanIds()` (recommended, so the service backend can enumerate) or stays.

### Backend factory
- Replace `config/backend.ts`'s `assertSupportedBackend(org)` with `makeBackend(org, stateDir): Backend`
  returning a bag of the stores (`{ records, launches, proposals, ledger, canon, notifier, flags }`).
- For `backend: "git"` → construct the git adapters. For `backend: "service"` → **keep the throw for
  now**, relocated into the factory (Phase 1 replaces it with real adapters). This preserves today's
  fail-fast behavior with one decision point.
- **Recommendation:** thread a single `Backend` bag through callers (one threading point) rather than
  N individual store params.

### Owns (exclusive write) — the whole persistence spine, which is why it's serial
- Store modules: `coordinator/record-store.ts`, `coordinator/launch-store.ts`,
  `coordinator/proposals.ts`, `publicity/ledger.ts`, `publicity/canon-store.ts`, `publicity/notify.ts`
- New: a ports module (e.g. `coordinator/ports.ts` or per-store `*.port.ts`) + the git adapters
  (the existing code, re-housed behind the interfaces) + `config/backend.ts` (now the factory)
- Every caller (re-thread `stateDir` → store/`Backend`): `coordinator/reconcile.ts`,
  `coordinator/release-runner.ts`, `coordinator/graduation.ts`, `coordinator/approve.ts`,
  `coordinator/status.ts`, `agents/triage/triage-runner.ts`, `agents/rejection/rejection-runner.ts`,
  `publicity/trigger.ts`, `publicity/fanout.ts`, `maintenance/cert-watch.ts`,
  `maintenance/deadlines.ts`, `maintenance/renovate.ts`, `cli.ts` (all 12 `assertSupportedBackend`
  sites → one `makeBackend`)
- The tests covering all of the above (update construction to go through the factory; keep the
  temp-dir idiom — the git adapter writes real files, so existing assertions hold)

### Reads (no write)
- `flags/types.ts` + `flags/file-client.ts` + `flags/http-client.ts` + `flags/select.ts` (the
  **template** — `FlagClient` already is a port with two adapters; mirror its shape, don't refork it)
- `config/org-config.schema.ts` (the `backend: z.enum(["git","service"])` field — do not change it)
- `contracts/*.schema.ts` (record/launch/proposal shapes — unchanged)

### Build notes
- **Net result is invisible at runtime.** If any feature behaves differently, you widened scope —
  stop. The proof is the unchanged 258 + 30 suite.
- Keep schema validation **on read and on write** inside the git adapter (it's there today —
  `ReleaseSchema.parse` on both sides). The port interface is I/O; validation is the adapter's job.
- Web consumes the **built `dist/`** — after touching library exports, `npm run build` before
  `npm run -w web test` (the gotcha PR #35 surfaced).

### Done when
A `Backend`/ports abstraction exists; the `FlagClient` pattern is mirrored to the other stores; the
git adapter is the default and every caller uses the port; `backend: service` throws from the
factory alone; pure transforms remain free functions. **Verify (paste real output):**
`npm run typecheck && npx vitest run` → 258 green, then `npm run build && npm run -w web test` →
30 green.

### Open questions
- Single `Backend` bag vs. individual store params (recommend the bag).
- `proposeOnce`/`reconcileProposal`/`appendToCanon`: free-functions-taking-store (recommended) vs.
  adapter methods.
- Does `scanReleaseIds` move onto `RecordStore` (recommended) or stay in `reconcile.ts`?
- Async-ness: the file stores are **sync**, `FlagClient` is **async**. A service backend is
  inherently async. Decide now whether the ports are **async across the board** (recommend: yes —
  `Promise`-returning everywhere, so the service adapter doesn't force a second caller-rewrite in
  Phase 1). This makes Phase 0 the place the sync→async caller churn happens, once.

---

## Phase 1 — Service-adapter fan-out   ·   THE SWARM · BLOCKED   ·   not yet ready

> **DO NOT DISPATCH until both gates clear:** (1) Phase 0 merged (ports exist) **and** (2) the
> service target is decided (the blocking question below). Until then these lanes are specified, not
> ready. Pre-writing them here is the point — dispatch is a single step once unblocked.

### Blocking open question — decide before any Phase-1 code
**What is the `service` backend?** The adapter bodies depend entirely on this. Candidates to weigh:
a team-hosted REST API, Supabase/Postgres, a generic KV/document store. **Run a short
`brainstorming` (or `grill-me`) pass to pin: the protocol, auth (a `SECRET:NAME` ref like the flag
provider uses), and the consistency model that will enforce invariant #3.** That decision produces a
tiny **shared-contract prep** for Phase 1: a `ServiceHttpClient`/SDK + the backend factory's
`"service"` branch — single owner, lands first within Phase 1, exactly like Phase 0's git adapters.

### Lanes (once unblocked — each owns ONE adapter file + its tests, zero overlap)
- **Lane A — `ServiceRecordStore`** implements `RecordStore`. Reuses `appendTransition`/`newRelease`
  verbatim; proves dedup (#3) holds under the service's consistency model.
- **Lane B — `ServiceLaunchStore`** implements `LaunchStore`.
- **Lane C — `ServiceProposalStore`** implements `ProposalStore`; the `proposeOnce` "create-once"
  guarantee must be server-enforced or check-then-write-safe.
- **Lane D — `ServiceLedgerStore`** implements `LedgerStore`; the announced-scope set is the
  publicity idempotency ledger — uniqueness is the whole point.
- **Lane E — `ServiceCanonStore`** implements `CanonStore`.
- **Lane F — `ServiceFlagClient`** — **likely already satisfied** by the existing `HttpFlagClient`
  (`flags/http-client.ts`, wired by `makeFlagClient`). This lane may be a no-op or a thin
  reconciliation that the same provider serves the `service` backend. Confirm, don't rebuild.
- **Shared contract (single owner):** the `ServiceHttpClient`/transport + the factory's `"service"`
  branch that constructs all the above. Other lanes consume it; they don't fork it.

### Phase-1 integration
- Phase-1 prep (transport + factory `"service"` branch) merges first (single owner).
- Adapter lanes merge in any order (one file each, disjoint).
- **Reconcile against BOTH backends:** parameterize the suite over `git` and `service` and run the
  whole thing green on each — the proof that the port abstraction is real and the invariants hold
  regardless of where state lives.

---

## Integration (whole of R3)
1. **Phase 0 merges first** (serial, solo). Reconcile: 258 root + 30 web green, **zero behavior
   change** — that green suite IS the contract guarantee.
2. Decide the service target (brainstorming gate). Then Phase-1 prep merges (single owner).
3. Phase-1 adapter lanes merge in any order.
4. Final reconcile: run the full suite against **both** backends.

## Rules of the road (every dispatched agent)
1. **Stay in your lane.** Write only files your lane owns. Need a change elsewhere? File a contract
   request in your final report — don't make it. (Phase 0 owns the spine *because* it's solo; Phase-1
   lanes own one adapter each.)
2. **Worktree/branch per lane**, `feat/<lane>`. Never commit to `main`; open a PR.
3. **Preserve the five invariants** (above) — especially #3 under a non-filesystem consistency model.
4. **No scope widening.** Phase 0 is a *pure refactor* — if a feature changes behavior, you've gone
   too far. Report anything else you find.
5. **Verify before claiming done.** Run the lane's verify and paste real output (and `npm run build`
   before web tests).
6. No `Co-Authored-By` lines, no "Generated with…" attribution in commits/PRs.

## What this handoff deliberately does NOT do
- It does **not** pick the service technology — that's the Phase-1 gating decision, owned by a
  brainstorming pass, not a lane.
- It does **not** start **R1** (web auto-promote — needs its own design spike per the roadmap) or
  **R2** (full reconcile orchestration in the console). Both touch the same coordinator spine Phase 0
  refactors and would collide if run concurrently; they stay sequenced *after* R3, on the now-cleaner
  port seams. **R4** (net-new enhancement lanes) opens only after R1–R3, as the roadmap states.
