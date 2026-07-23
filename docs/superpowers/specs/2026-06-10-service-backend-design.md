# Design — service backend (R3 Phase 1)

**Authored 2026-06-10.** Design record for the `coordinator.backend: service` adapters, the
Phase-1 fan-out of the [R3 service-backend handoff](./2026-06-10-service-backend-swarm-handoff.md).
Phase 0 (the persistence ports) shipped in PR #37; this spec pins the **target** so the adapters can
be built. It is a brainstorming output — the implementation plan follows separately.

## Decisions (the gate the handoff flagged)

| Question | Decision |
|---|---|
| What is the `service` backend for? | **Hosted/SaaS Halyard** — the product-vision central hub runs Halyard as a library against a shared datastore: many projects behind one API. |
| How do adapters reach state? | **HTTP/REST to a Halyard state API.** Thin clients, like the existing `HttpFlagClient`/`HttpPublisher`. The DB lives *behind* the API (the hub owns it); the library stays transport-agnostic and vendor-free. |
| What does Phase 1 deliver? | **Client adapters + a documented HTTP contract**, tested against an injected `fetch`. The hub server is a separate build that implements the contract. No server, DB schema, or deploy work here. |
| What semantics does the contract guarantee? | **Parity with the git backend: last-writer-wins per record.** Invariant #3 (dedup) is preserved by the *existing client-side* idempotency (`appendTransition`), unchanged across backends. **Multi-writer concurrency control is explicitly deferred** to the hub-server design (see below) — it is not faked in the client. |

## Semantics: parity with git, not a new consistency model

The pivotal correction in this design (it cost two critique rounds): **the client adapters must not
invent server-side merge/CRDT/lattice semantics.** An earlier draft had the server merge whole records
field-by-field and 409 on conflict. That was wrong on the happy path — `external_refs.review_status`
legitimately changes `in_review → approved` every review poll (`asc-review.ts`, `play-review.ts` →
`reconcile.ts` merges it in), so a "conflicting value → 409" rule **permanently wedges** a normal
release. It was also unenforceable (the proposal write carries no actor, so a server cannot tell a
system write from a human one) and entirely **unverifiable** by this phase's tests (which control the
fake server's responses). So:

**The `service` backend is a faithful HTTP mirror of the git port semantics — last-writer-wins per
record, exactly like `writeFileSync`.** Each adapter does the obvious thing: `read` → record or `null`,
`write` → replace the stored record, `scanIds`/`list` → ids/records (**sorted client-side**, see the
comparator note below, so order parity holds regardless of server behavior).

**One deliberate exception — the ledger.** `LedgerStore.markAnnounced` is the single store whose git
semantics are *not* whole-record replace: it is read-modify-write **accumulation** (`ledger.ts` reads
the Set, adds one key, rewrites). The client sends only a single key delta, so the server **must
set-union it server-side** — that is genuine server behavior, and it is the *only* place the
"nothing clever server-side" rule is relaxed. It is called out explicitly here, reflected in the
contract (`POST …/announced`), and the parity slice's fake server MUST implement set-union (with a
multi-channel fan-out case, since `fanout.ts` calls `markAnnounced` once per channel and a
replace-style fake would silently clobber the replay guard). Every other store is plain replace.

**Invariant #3 still holds, because it never depended on the storage layer.** Dedup is a *client-side*
property: `appendTransition` is a no-op when the release is already in the target state, and the
`(release_id + transition + attempt)` dedup_key is computed by the same pure code regardless of
backend. A single writer re-running (CI retry, replay, double poll) converges identically on git and
service. That is the guarantee this phase delivers and tests.

### What is deferred (and named, not faked)

The git backend has **no** multi-writer concurrency control — two processes writing the same
`state/releases/x.json` race with last-writer-wins today; in practice there is one reconcile runner.
The SaaS hub's *aspiration* of safe concurrent writers is a **real new requirement that cannot be
satisfied in a client-adapter-only phase** — it needs the server plus, almost certainly, a Phase-0
**port revision** (e.g. `read` returns a version/ETag, `write` sends `If-Match` and surfaces a
conflict the caller retries). That is a deliberate, documented **follow-up for the hub-server design**,
not something to half-build here:

> **Open design question (hub server / future port phase):** optimistic concurrency. Recommended path
> when the hub is built — `read` returns an opaque version, `write` is conditional on it, a `409`
> surfaces to the caller, and reconcile's read-modify-write retries. This changes the ports, so it is
> its own phase. Until then, the service backend matches git's single-writer last-writer-wins model,
> and operators run one reconcile writer per project (as today).

This keeps Phase 1 honest: every byte of the deliverable is testable, and the genuinely hard problem
is surfaced as the next design rather than buried as unprovable prose in a client doc.

## Architecture

```
config: coordinator.service { api_url, api_key_ref }
                │  makeBackend(org, { stateDir, canonDir?, fetchFn? }) — "service" branch (ignores stateDir)
                │     resolves api_key_ref token (tryResolveSecret); HARD-FAILS if unresolvable
                ▼
        ServiceHttpClient  { baseUrl, token, fetchFn? }  (fetch wrapper, error mapping, timeout, never logs token)
        ├── ServiceRecordStore    implements RecordStore
        ├── ServiceLaunchStore    implements LaunchStore
        ├── ServiceProposalStore  implements ProposalStore
        ├── ServiceLedgerStore    implements LedgerStore
        └── ServiceCanonStore     implements CanonStore
```

- **`ServiceHttpClient`** (the shared-contract prep, single owner, lands first within Phase 1).
  Options `{ baseUrl: string; token: string; fetchFn?: typeof fetch }` — mirroring `HttpFlagClientOptions`,
  with **constructor injection of `fetchFn`** (defaulting to global `fetch`) so tests run with no
  network. Wraps requests with the bearer token (resolved from `coordinator.service.api_key_ref` at
  runtime, invariant #4 — never logged), JSON encode/decode, a request **timeout** (AbortController),
  and HTTP-status → typed-error mapping. Tenancy is **token-scoped**; paths carry no tenant id.
- **Five adapters**, one file + test each (the parallel lanes). Each implements its Phase-0 port over
  the client. They are **thin: transport + light shape adaptation** — `404 → null`/empty,
  `string[] → Set` (ledger), `{created} → boolean` (canon), and **client-side sort** on
  `scanIds`/`list` for git parity (per-store comparator — see the contract table). No business logic;
  the pure transforms (`appendTransition`, `newRelease`, …) are unchanged and not re-implemented.
- **`makeBackend(org, opts)`** gains its `service` branch and an **optional** `fetchFn?` in opts
  (existing call sites pass `{stateDir, canonDir?}` and are unaffected). The branch reads
  `coordinator.service`, resolves the token via `tryResolveSecret`, and **hard-fails with a clear
  error** if the `service` block or token is missing/unresolvable. There is **no git fallback** — a
  service backend genuinely cannot do anything (even reads) without its token, so this is inherent, not
  a stylistic choice. `assertSupportedBackend` is updated to accept `service`.
  - **Consequence (documented, not hidden):** read-only commands (`halyard status`, `queue`) on a
    service-backed project also require the token in env — unlike git, which needs none. This is
    unavoidable for a remote store.
  - **Web console:** `web/.../project.ts:loadProject` is contractually "never throws → degraded
    result" and today does **not** call `makeBackend`. Wiring the console to a service backend is
    **out of scope** here; when done, it must catch the `makeBackend` hard-fail into a degraded result
    so the never-throws contract holds. Called out so the future integrator isn't surprised.
- **Config** — new org-level block:
  ```yaml
  coordinator:
    backend: service
    service:
      api_url: https://halyard.example.com/api    # non-secret URL (like flags.api_url)
      api_key_ref: SECRET:HALYARD_SERVICE_TOKEN     # resolved at runtime, never stored/logged
  ```
  Full revised `CoordinatorSchema` (shape includes `service`, then `.strict()`, then a `superRefine` —
  note this makes `CoordinatorSchema` a `ZodEffects`; no current consumer relies on it being a bare
  `ZodObject` via `.shape`/`.extend`, confirmed):
  ```ts
  const CoordinatorSchema = z
    .object({
      backend: z.enum(["git", "service"]),
      state_dir: z.string().min(1),   // stays REQUIRED (typed string) — see note below
      service: z.object({ api_url: z.string().url(), api_key_ref: SecretRefSchema }).strict().optional(),
      reconcile_cron: CronSchema,
      dedup: z.boolean().default(true),
    })
    .strict()
    .superRefine((c, ctx) => {
      if (c.backend === "git" && c.service) ctx.addIssue({ code: "custom", path: ["service"], message: "service config is not allowed for backend: git" });
      if (c.backend === "service" && !c.service) ctx.addIssue({ code: "custom", path: ["service"], message: "service config is required for backend: service" });
    });
  ```
  **`state_dir` stays required and typed `string` — it is NOT made optional.** Round 3 caught that
  making it `string | undefined` would break compilation at ~10 sites doing
  `resolve(flags["state-dir"] ?? org.coordinator.state_dir)` (cli.ts × 9 + `web/.../project.ts:63`,
  under `strict`/`exactOptionalPropertyTypes`). For a service backend `state_dir` is simply an **ignored,
  harmless placeholder** (exactly like the currently-inert `dedup` flag — see note) — the service
  adapters never read it. `canonDir` (`drafting.voice_canon`) is likewise only consumed by the git canon
  adapter. This keeps every existing git call site compiling unchanged and adds zero call-site churn.

  > **Note — `dedup` is inert config.** Nothing in `src/` reads `org.coordinator.dedup`; invariant #3
  > is hardwired in the pure `appendTransition`/`isCurrentState`, not gated by the flag. The service
  > backend does not change this. `state_dir`-for-service is the same kind of harmless-unused field.

## HTTP contract (what the adapters assume; the hub implements)

All requests carry `Authorization: Bearer <token>`. JSON bodies. Tenancy from the token. **Writes are
replace (last-writer-wins); the server stores the record as sent.** Adapters sort list results
client-side, so the server is not required to.

| Port method | Request | Response / semantics |
|---|---|---|
| `RecordStore.read(id)` | `GET /releases/{id}` | `200` → Release JSON; `404` → `null` |
| `RecordStore.write(rel)` | `PUT /releases/{id}` body=Release | replace; `200`/`204` |
| `RecordStore.scanIds()` | `GET /releases` | `200` → `string[]`; adapter sorts with **bare `ids.sort()`** (matches `scanReleaseIds`) |
| `LaunchStore.read/write/scanIds` | `GET/PUT /launches/{id}`, `GET /launches` | replace write; `404 → null`; adapter sorts ids with **bare `ids.sort()`** (matches `scanLaunchIds`) |
| `ProposalStore.read/write/list` | `GET/PUT /proposals/{id}`, `GET /proposals` | replace write; `404 → null`; adapter sorts with **`(a,b)=>a.proposal_id.localeCompare(b.proposal_id)`** (matches `listProposals` — NOT bare sort) |
| `LedgerStore.readAnnounced(lid)` | `GET /ledgers/{lid}` | `200` → `string[]` (adapter wraps to `Set`); `404` → empty `Set` |
| `LedgerStore.markAnnounced(lid,k)` | `POST /ledgers/{lid}/announced` body=`{key}` | idempotent set-add; `200`/`204` |
| `CanonStore.append(entry)` | `PUT /canon/{id}` body=entry | create-if-absent; **always `200`** with `{ created: boolean }` (adapter returns `created`) |

*Forward-compat (server SHOULD, client doesn't yet):* `GET /releases` and `/proposals` MAY accept
`?status=`/pagination params; the current client fetches all (matching the git port, which reads the
whole directory). Reserved now so adding them later isn't a contract break.

Schema validation stays client-side on read (`*Schema.parse`) — invariant #1, the projection is never
trusted blindly, regardless of backend.

## Error model, timeouts, write failures

- **Timeout:** `ServiceHttpClient` applies a request timeout via `AbortController`, **default 10s**
  (overridable via an option). This is **net-new** — `HttpFlagClient` has no timeout, so "mirroring its
  options" does not give it for free. A wedged `fetch` must not stall a CI reconcile job (the git
  backend's local I/O never hung).
- **Typed errors:** non-2xx → a single shared error type `ServiceHttpError extends Error` (exported
  from the `ServiceHttpClient` module — the shared surface all five adapter lanes import) carrying
  `{ status: number; retryable: boolean }`, where `retryable` is true for 5xx/network and false for
  4xx-terminal (401/403 auth). Reads map `404 → null`/empty Set (not an error).
- **Write failure parity:** an HTTP write that throws behaves like git's `writeFileSync` throwing — it
  propagates. In `reconcile.ts` the per-record `write` is outside the per-source try/catch, so a thrown
  write aborts the *current sweep* (id-ordered) on **both** backends today — this is **not a regression**
  and not in scope to change here. Because writes are idempotent (re-running converges), the next sweep
  recovers. We do **not** claim per-record write isolation (the earlier draft did, incorrectly).

## Testing

- Each adapter test constructs `ServiceHttpClient` with an injected `fetchFn` (recording requests /
  returning canned responses) — **constructor injection**, no network, no server.
- Assert per port method: correct method/path/body/auth header; `404 → null`/empty; non-2xx → typed
  throw; token sent but **never logged**; ledger read adapts `string[] → Set`; canon returns `created`;
  **`scanIds`/`list` return sorted** even when the fake server returns unsorted (proves client-side sort).
- `makeBackend` service-branch tests: hard-fail when `coordinator.service`/token missing; constructs the
  five adapters when present; `fetchFn` threaded through. Config tests: the `superRefine` matrix
  (git+no-state_dir fails, git+service fails, service+no-service fails, service+service passes).
- **Backend-parity slice:** run a small reconcile/approve/publicity flow against a fake-fetch service
  backend AND against the git backend; assert identical observable results. This is sound precisely
  *because* the service contract is last-writer-wins parity — there is no divergent server merge to be
  unverifiable about. The full existing suite (258 root + 30 web) keeps running on git, unchanged.

## Scope / non-goals

- **In:** `ServiceHttpClient`, the five adapters, the `makeBackend` `service` branch + optional
  `fetchFn`, the `coordinator.service` schema + `superRefine` (with `state_dir` kept required), the
  per-store client-side sort, adapter + config tests with injected fetch, the parity slice (with a
  set-union ledger fake + multi-channel fan-out), and this contract. **Also in scope:** a `preflight`
  readiness item — when `backend === "service"`, `assessReadiness` must check
  `coordinator.service.api_key_ref` resolves (it is the most fundamental dependency; without it every
  state command hard-fails, so preflight reporting "ready" without it would be a false green).
- **Out:** the hub server, DB schema, deploy/auth infra, multi-region, git→service migration tooling,
  **multi-writer concurrency control / optimistic locking** (the named follow-up — needs the server and
  a port revision), web-console service-backend integration, client-side pagination/filtering, and any
  change to the Phase-0 ports or the git backend.
- **Flags & notifications stay app-scoped — intentional.** Flag state (`flags.api_url`) and the notifier
  (`notifications.approval_channel_ref`) keep their existing app/config selection and are **not** routed
  through `coordinator.service`. A service-backend project still configures its flag provider (often a
  real external provider, e.g. LaunchDarkly) and notifier separately; they are already ports with their
  own git+HTTP adapters, and folding them into the org-scoped `Backend` bag would wrongly couple
  app-scoped selection to the backend choice.

## Build order (informs the plan)

1. **Prep (serial, single owner):** `ServiceHttpClient` + `coordinator.service` schema/`superRefine` +
   `makeBackend` service branch (+ optional `fetchFn`). Lands first — every adapter hangs off it.
2. **Fan-out (parallel lanes, one adapter each):** Record, Launch, Proposal, Ledger, Canon.
3. **Reconcile:** full suite green on git; adapter suites green; backend-parity slice green; contract
   spec published for the hub (including the deferred optimistic-concurrency open question).

## Design Critique Log

### Critique Round 1
An independent reviewer found nine issues; the design was revised:
- **CRITICAL — whole-record PUT lost non-transition fields** and could resurrect a stale `flag:null`
  into a `live` record. → (Initially) added a per-field server merge table. *(Round 2 later showed this
  fix was itself wrong; see below — the merge was removed entirely.)*
- **HIGH — proposal auto-resolve race** missed system `→resolved` stomping `approved`. → (Initially) a
  status lattice. *(Also removed in Round 2 — unenforceable; see below.)*
- **HIGH — `makeBackend` token plumbing / degrade-vs-hard-fail** unspecified. → Service branch resolves
  the token and **hard-fails** (no fallback); documented, retained.
- **HIGH — canon boolean / ledger Set vs "non-2xx throws"** collision. → Canon returns `200 {created}`;
  adapters do explicit shape adaptation. Retained.
- **MEDIUM — `coordinator.service` schema** unspecified. → Added the Zod delta + `superRefine`. Retained
  and expanded in Round 2.
- **MEDIUM — fetch injection point** unspecified. → Constructor injection via `fetchFn`. Retained.
- **MEDIUM — `list`/`scanIds` return-all footgun.** → Contract reserves filter/pagination. Retained.
- **MEDIUM — flags/notifier exclusion** implicit. → Explicit reasoned non-goal. Retained.
- **LOW — no error model/timeout/retry.** → Added. Retained (corrected in Round 2).

### Critique Round 2
A fresh reviewer showed the Round-1 server-merge fix was itself broken, and the design was
**substantially simplified** in response:
- **CRITICAL — the `external_refs` "conflict → 409" rule wedges the happy path**: `review_status`
  legitimately changes `in_review → approved` every poll, which would 409 and permanently stick a
  release. → **Removed the whole-record merge.** The contract is now plain last-writer-wins parity with
  git; `external_refs` is replaced like every other field.
- **CRITICAL — the proposal status lattice is unenforceable**: the `ProposalStore.write` port carries no
  actor, so a server cannot distinguish a system write from a human one. The lattice was also ambiguous
  on the real `resolved → open` reopen (`proposals.ts:74`). → **Removed the lattice.** Proposal writes
  are replace (git parity). The system-vs-human race exists in git today and is **not a regression**;
  true protection needs concurrency control, now the named deferred follow-up.
- **HIGH — writes in `reconcile.ts` are outside the per-source try/catch**, so the earlier
  "self-correcting / per-source isolation" claim was false for writes. → Corrected: a thrown write
  aborts the sweep on **both** backends (parity, not a regression); recovery is by idempotent re-run on
  the next sweep. No isolation over-claim.
- **HIGH — hard-fail breaks read-only commands + the web console never-throws contract.** → Documented
  the read-only consequence as inherent (a remote store needs its token to read); flagged the web-console
  integration as out-of-scope future work that must catch the hard-fail into a degraded result.
- **HIGH — parity/double-merge divergence** made the parameterized parity test unsound under a server
  merge. → With merge removed, parity is exact (last-writer-wins both sides), so the slice is sound.
- **MEDIUM — `state_dir` is dead config for a service backend** yet required. → Made `state_dir`
  optional and git-only via the `superRefine`.
- **MEDIUM — sort guarantee unverifiable server-side.** → Adapters **sort client-side**, restoring git
  parity and making it testable with injected fetch.
- **MEDIUM — Zod `.strict()` + `superRefine` interaction** under-specified. → Wrote the full
  `CoordinatorSchema` block and asserted no consumer needs it as a bare `ZodObject`.
- **MEDIUM — launch field merge** ("set-once for other fields") would freeze legitimately-editable
  launch fields. → Moot: launch write is now plain replace (parity), no per-field freezing.
- **Meta (scope honesty)** — Round 1 pushed all correctness into an out-of-scope, untestable server. →
  Resolved by removing the server semantics entirely: the deliverable is now fully client-testable, and
  the genuinely hard problem (concurrency control) is surfaced as the explicit next design, not faked.

### Critique Round 3
A final fresh reviewer found that the Round-2 simplification introduced two new blockers and three
precision gaps; all fixed:
- **CRITICAL — making `state_dir` optional is a compile-breaking regression.** Under
  `strict`/`exactOptionalPropertyTypes`, typing it `string | undefined` breaks
  `resolve(flags["state-dir"] ?? org.coordinator.state_dir)` at ~9 cli sites **and** `web/.../project.ts:63`.
  → Reverted: `state_dir` **stays required and typed `string`**; it is an ignored harmless placeholder
  for the service backend (like the inert `dedup` flag). Zero call-site churn. The `superRefine` no
  longer touches `state_dir`.
- **CRITICAL — the ledger contradicted the "nothing clever server-side / last-writer-wins" thesis.**
  `markAnnounced` is read-modify-write accumulation, not replace; the client sends one key, so the
  server must set-union. → Carved the ledger out **explicitly** as the one accumulating endpoint;
  required the parity-slice fake to set-union and added a multi-channel fan-out case (a replace-style
  fake would silently break the replay guard in `fanout.ts`).
- **HIGH — sort comparator under-specified.** git uses bare `.sort()` for release/launch ids but
  `localeCompare(proposal_id)` for proposals; "match git's `.sort()`" implied one comparator. → Pinned
  the per-store comparator in the contract table + a distinguishing parity fixture.
- **MEDIUM — `coordinator.dedup` framed as load-bearing** though nothing reads it. → Added a note that
  it (and `state_dir`-for-service) are inert/ignored; invariant #3 is hardwired in `appendTransition`.
- **MEDIUM — `preflight` would report a service project "ready" without checking the service token.** →
  Brought a `coordinator.service.api_key_ref` readiness check into scope.
- **LOW — `ServiceHttpClient` over-claims.** Timeout isn't inherited from `HttpFlagClient` (it has
  none) and the error type/timeout default were vague. → Specified **10s default timeout (net-new)** and
  a named shared **`ServiceHttpError { status, retryable }`** exported for all five lanes.

Reviewer confirmed sound (not re-litigated): the removal of the server merge + status lattice, the
write-isolation parity correction, and `proposeOnce` single-writer idempotency holding under
last-writer-wins.
