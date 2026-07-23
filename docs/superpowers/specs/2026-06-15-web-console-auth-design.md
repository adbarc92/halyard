# Web console auth — design

## Problem

The `@halyard/web` operator console (SvelteKit, adapter-node) has **no auth boundary**. It is
safe only because `web:start` binds `127.0.0.1`, but nothing in code enforces that: anyone who
runs `node web/build` directly (or overrides `HOST`, or fronts it with a proxy/tunnel) exposes
full mutating control — flag flips (the launch moment), proposal approvals (the human gate for
third-party posts), and full reconcile (which can fire owned-channel auto-publish). The console
is also explicitly built to be **embeddable** behind the central hub / a reverse proxy, where it
must trust a forwarded identity rather than sit open.

This design adds an auth boundary that covers three deployment modes with **one shared secret**:

1. **Accidental exposure** — running it non-loopback without auth must be impossible.
2. **Standalone remote** — reaching the console directly over a network must require a credential.
3. **Embedded behind the hub/proxy** — the proxy authenticates and presents the secret as a header.

## Non-goals (YAGNI)

Multi-user accounts, roles/RBAC, password-rotation UI, rate-limiting/lockout, OAuth/SSO. One
shared operator secret matches the single-operator design. Tracked on the roadmap for later.

## The secret

`HALYARD_CONSOLE_TOKEN` — read once from the environment at module load in
`web/src/lib/server/auth.ts`. A credential: never logged, never sent to the client, never written
to a record. Absent ⇒ "no token configured" mode. Not a `SECRET:NAME` config ref; it is the
console process's own secret, supplied via env like `PORT`/`HOST`. Operators must use a
high-entropy value (`openssl rand -hex 32`).

## Origin / proxy environment (load-bearing for CSRF + cookies)

adapter-node builds the request `url` from `ORIGIN` (or, if unset, `get_origin` which **defaults the
scheme to `https`**). kit's CSRF origin-check compares the browser's `Origin` header to
`url.origin` *before* the hook runs, so a scheme mismatch 403s the login form POST. Therefore:

- **Standalone (no proxy):** `server.js` sets `ORIGIN` to `http://${HOST}:${PORT}` when unset, so
  `url.origin` matches the browser's real `http://…` origin and the login/logout form POSTs pass
  CSRF. (Direct-https standalone: operator sets `ORIGIN=https://…`.)
- **Behind a proxy:** operator sets `ORIGIN` to the public origin and the relevant forwarded-header
  vars (`PROTOCOL_HEADER`, `ADDRESS_HEADER`, `HOST_HEADER`) per adapter-node docs.

`ORIGIN` is **not** treated as a proxy-posture signal (it is needed even for a bare loopback server
to get CSRF/URL right) — see `looksProxied` below.

## Component 0a — `web/src/lib/server/loopback.js` (plain-JS shared core)

A **dependency-free plain-ESM** module (no TypeScript syntax, no SvelteKit imports) placed *inside*
`src/lib/server/` so it sits in the TS project (typechecked, bundled) **and** can be imported by the
node entry `web/server.js` via a relative path and by tests — one canonical path for all three.
Exports:

- `isLoopbackAddress(addr): boolean` — normalizes IPv4-mapped IPv6 (`::ffff:127.0.0.1`), matches
  `127.0.0.0/8`, `::1`, `localhost`. (Dual-stack Node reports loopback peers as `::ffff:127.0.0.1`
  / `::1`, so naive `=== "127.0.0.1"` would misclassify local dev.)
- `looksProxied(env): boolean` — true if any **forwarded-header** var is set: `ADDRESS_HEADER`,
  `XFF_DEPTH`, `PROTOCOL_HEADER`, `HOST_HEADER`, `PORT_HEADER`. (Deliberately **excludes `ORIGIN`**,
  which the standalone path sets for CSRF.)
- `bindGuard({ token, host, env }): "ok" | "refuse"` — refuse iff **no token** and (`host`
  non-loopback **or** `looksProxied(env)`). Single source of truth for the node entry and tests.

## Component 0b — `web/src/lib/server/auth.ts` (TS security core)

Re-exports the `loopback.js` helpers and adds request-time primitives (pure, unit-testable without a
SvelteKit runtime):

- `sanitizeNext(next): string` — safe **same-origin path** or `/`. Accepts only `^/[^/\\]…`
  (rejecting `//evil`, `/\evil`, absolute URLs, CRLF; `new URL(next,"http://x").origin === "http://x"`);
  strips any data suffix. Fed `event.url.pathname` (already base-prefixed); the login action
  redirects to its result **verbatim** (do not re-prepend `base`).
- `timingSafeEqualStr(a, b): boolean` — length-guard then `crypto.timingSafeEqual`.
- `parseBearer(header): string | null` — case-insensitive `Bearer ` scheme, trims surrounding
  whitespace, returns the raw token or null.
- `secureCookieFlag({ forwardedProto, urlProtocol, originSet }): boolean` — true iff
  `forwardedProto === "https"` **or** (`originSet` **and** `urlProtocol === "https:"`). Never keyed
  off `url.protocol` alone (which defaults to `https` when `ORIGIN` is unset → would mark the cookie
  `Secure` on http loopback and break login).
- **Session store** (`createSession(now)`, `isValidSession(id, now)`, `destroySession(id)`): an
  in-memory `Map` of random 256-bit ids (`crypto.randomBytes(32).toString("hex")` → expiry). The
  cookie holds a **random opaque id, nothing token-derived** — not brute-forceable, not equal to the
  token, with real logout/invalidation and absolute TTL (default 12h, injected clock for tests).
  In-process; clears on restart (re-login). Prune-on-check + periodic sweep bounds the map.
  Single-process / single-operator model documented.

Cookie name: `hal_session` (distinct, unlikely to collide). Read via `event.cookies.get`.

## Component 1 — `web/src/hooks.server.ts` (enforcement boundary)

A single `handle({ event, resolve })` hook gates **every** request, classifying on `event.route.id`
and `event.isDataRequest` (real public `RequestEvent` fields in kit 2.x), **never on raw
`event.url.pathname`** (client-router nav / `invalidateAll()` fetches `/<route>/__data.json`, suffix
intact in the hook). `route.id` is base-stripped (`/login`, `/api/...`), so classification is
base-independent; the **redirect Location prepends `base`** (`import { base } from "$app/paths"`).

```
authenticated  :=  (token set) AND ( valid Bearer token OR valid session cookie )
isPage         :=  event.route.id !== null            // assets, /_app/*, vite, 404 => null
isApi          :=  event.route.id startsWith "/api"
isData         :=  event.isDataRequest === true

token NOT set:
  request carries ANY x-forwarded-* header  -> 403   (proxy in front; loopback peer spoofable)
  client address isLoopback                 -> resolve(event)   (zero-config local dev, unchanged)
  else                                      -> 403   (fail closed)
token set, authenticated                    -> resolve(event)
token set, NOT authenticated:
  route is /login or /logout, or NOT isPage -> resolve(event)   (no redirect loop; assets load)
  isApi OR isData                           -> 401 JSON { message: "authentication required" }
  else (real HTML page)                     -> 302 -> `${base}/login?next=<sanitizeNext(path)>`
```

The `x-forwarded-*` rejection in no-token mode closes the co-located-proxy hole (`proxy_pass
127.0.0.1` makes every peer loopback; a proxied request always carries `x-forwarded-*`, a direct dev
request never does). It composes with the startup `looksProxied` refusal (Component 3) without a gap.

- **Bearer first** (proxy/machine), then session cookie (browser).
- **Cookie:** `HttpOnly`, `SameSite=Lax`, `Path=/`, `Max-Age`=TTL, `Secure` per `secureCookieFlag`.
- **Client address** via `event.getClientAddress()`; thrown/empty → non-loopback (fail closed).
- **401** is a hand-built `json({ message }, { status: 401 })` (hook runs before route `error()`).

## Component 2 — `/login` + `/logout` (bare layout, base-aware)

- `web/src/routes/login/+layout.svelte` — **bare** layout (no nav, no `health` call) so the pre-auth
  screen leaks no project root / config state.
- `web/src/routes/login/+page.svelte` — single-field token form, `method="POST"` to `{base}/login`
  (urlencoded), hidden `next`.
- `web/src/routes/login/+page.server.ts` — `load`: if authenticated, redirect to `/`. `default`
  action: validate token (`timingSafeEqualStr`); success → `createSession`, set cookie, redirect to
  `sanitizeNext(form.next)`; failure → `{ error: "Invalid token" }`.
- `web/src/routes/logout/+page.server.ts` — `default` action triggered by a **urlencoded form POST**
  (kit CSRF-checked like login): `destroySession`, clear cookie, redirect to `${base}/login`.
- `+layout.svelte` (main): a "Sign out" form POSTing to `{base}/logout`, shown only when
  `authEnabled`. `+layout.server.ts` adds `authEnabled` derived **purely from
  `process.env.HALYARD_CONSOLE_TOKEN != null`** (never via `service()`, so a degraded project never
  affects it), never exposing the token.

## Component 3 — `web/server.js` (fail-fast bind guard) — preserves adapter-node features

`web:start` becomes `cross-env HOST=127.0.0.1 node web/server.js` (explicit `HOST=127.0.0.1` kept,
both for the safe default and to satisfy `web/tests/bind.test.ts`). `server.js` normalizes HOST,
sets `ORIGIN` for standalone CSRF, runs the shared guard, then hands off to adapter-node's own entry
(retaining graceful shutdown, body limits, compression — no server reimplementation):

```js
// web/server.js  (sketch)
import { bindGuard } from "./src/lib/server/loopback.js";
const host = process.env.HOST || "127.0.0.1";   // adapter defaults 0.0.0.0; force safe + make
process.env.HOST = host;                         // guard's host IDENTICAL to what the adapter binds
const port = process.env.PORT || "3000";
process.env.ORIGIN ||= `http://${host}:${port}`; // standalone CSRF: url.origin matches browser http
if (bindGuard({ token: process.env.HALYARD_CONSOLE_TOKEN, host, env: process.env }) === "refuse") {
  console.error("refusing to bind non-loopback host without HALYARD_CONSOLE_TOKEN"); // stderr, no token
  process.exit(1);
}
await import("./build/index.js"); // adapter-node's real entry; reads the HOST/ORIGIN we just set
```

`web:start` presupposes a prior `web:build` (as today). **Direct `node web/build` bypasses this
guard**, but the hook is the backstop: no-token + non-loopback peer (or any `x-forwarded-*`) → 403.
`vite dev` does not load `server.js`; in dev the bind guard does not apply and the hook allows
`route.id === null` (Vite internals/HMR/assets) so a token-on dev session works. (Note: for a
no-token deployment that *needs* a public `ORIGIN` behind a proxy, a token is required anyway, so the
standalone `ORIGIN` default never collides with the `looksProxied` refusal.)

## Data flow

```
browser (standalone http)          proxy / hub (embedded https)
  GET /  --no cookie-->              GET /  Authorization: Bearer <token>
  hook: 302 ${base}/login?next=/    hook: Bearer valid -> resolve -> page
  POST {base}/login {token}         (no /login seen; no cookie needed)
    CSRF ok (ORIGIN==browser http)
  action: createSession, Set-Cookie (+Secure iff x-forwarded-proto https / https ORIGIN)
  GET /  --cookie--> resolve -> page
  invalidateAll() -> /x/__data.json
    session valid -> data; else -> 401 (client router navigates to login)
```

## Error handling

- Wrong token at `/login` → "Invalid token" (no detail/timing leak).
- `/api/*` or data request without creds → `401 { message }` (surfaced via `errorMessage()`).
- Bind guard failure → non-zero exit + stderr (never the token).
- Expired/destroyed session cookie → unauthenticated (re-login).

## CSRF invariant (must hold)

Login **and logout** use urlencoded form POSTs to same-origin `{base}/login`|`/logout`, so kit's
`csrf.checkOrigin` covers them in prod **provided `ORIGIN` matches the browser origin** (Component 3
sets it for standalone). Every mutating `/api/*` route accepts **`application/json` only** (non-simple
content-type → cross-site `fetch` needs a CORS preflight the app never grants) plus `SameSite=Lax`.
**Invariant:** mutating api routes must keep `application/json`-only bodies.

## Testing

- **`loopback.js` (pure, primary):** `bindGuard` table — (no token,127.0.0.1,no proxy)=ok,
  (no token,::1)=ok, (no token,::ffff:127.0.0.1)=ok, (no token,0.0.0.0)=refuse,
  (no token,10.0.0.5)=refuse, (no token,127.0.0.1,PROTOCOL_HEADER set)=**refuse**, (token,0.0.0.0)=ok.
  `isLoopbackAddress` (mapped IPv6/ranges). `looksProxied` (each header var → true; `ORIGIN` → false).
- **`auth.ts` pure fns:** `sanitizeNext` (bypass table incl. `/x/__data.json`→`/x`);
  `secureCookieFlag` (forwarded-proto https→true; ORIGIN-set+https url→true; http loopback→false);
  `parseBearer` (case/whitespace/missing); session store (create/destroy/expire via injected clock);
  `timingSafeEqualStr`.
- **`hooks.server.ts`:** hand-built minimal `RequestEvent` fake (`cookies.get`, `getClientAddress`,
  `route.id`, `url`, `isDataRequest`, `request.headers`) + `resolve` spy, every branch (no-token
  loopback→resolve; no-token+`x-forwarded-for`→403; no-token non-loopback→403; token+Bearer→resolve;
  token+cookie→resolve; token+no-creds page→302 with `${base}/login`; `/api`→401; data→401; `/login`
  passthrough; `route.id===null`→resolve). Assert no `Set-Cookie` carries the raw token. Add a
  `RequestEvent` factory under `web/tests/helpers/` (hook tests need `cookies.get`; action tests need
  `get/set/delete`).
- **login/logout actions:** valid token → session + `Set-Cookie` + redirect to sanitized next;
  invalid → `{ error }`, no cookie; logout → destroyed + cookie cleared.
- **Regression:** existing web tests pass unchanged with token unset (handlers called directly below
  the hook; loopback default identical). Token-toggling tests must set the env **then**
  `vi.resetModules()` + dynamic-import `auth.ts`/`hooks.server.ts` (same pattern as the `service()`
  tests). `bind.test.ts` still asserts `web:start` contains `HOST=127.0.0.1`.

## Docs

- `web/README.md`: replace "there is no auth boundary" with the token model (login/Bearer/loopback,
  fail-closed bind, no-token-refuses-behind-proxy, `ORIGIN` for standalone CSRF, Secure-on-https,
  `openssl rand`) and the three deployment modes.
- `docs/INTEGRATION.md`: embed-behind-hub contract (`Authorization: Bearer $HALYARD_CONSOLE_TOKEN`),
  required proxy env (`ORIGIN`/`PROTOCOL_HEADER`/`ADDRESS_HEADER`/`HOST_HEADER`), and the
  `application/json` CSRF invariant.

## Invariant check (coordinator)

No coordinator invariant is touched. The token is a console-process secret resolved from env and
never logged/serialized (consistent with invariant #4's spirit). Gates, projection, dedup, and the
publicity boundary are unchanged — this only controls *who can reach* the existing human gates.

## Design Critique Log

### Critique Round 1

Reviewer verified against `@sveltejs/adapter-node@5.5.4` + the SvelteKit runtime. Findings/fixes:

- **F1 (CRITICAL) data-request misclassification** — pathname matching breaks `__data.json`.
  *Resolved:* classify on `event.route.id` + `event.isDataRequest`; data → 401; `sanitizeNext` strips
  the suffix.
- **F2 (HIGH) wrong handler import / lost adapter features.** *Resolved:* `server.js` runs the guard
  then `await import("./build/index.js")`, keeping shutdown/limits/compression.
- **F3 (HIGH) loopback form matching** (`::ffff:127.0.0.1`/`::1`). *Resolved:* `isLoopbackAddress`
  normalizes mapped IPv6 + ranges.
- **F4 (HIGH) `sha256(token)` cookie** = unsalted/unexpiring/brute-forceable bearer. *Resolved:*
  in-memory random-session-id store; cookie holds nothing token-derived; TTL + logout; Secure-on-https.
- **F5 (MEDIUM) open-redirect in `next`.** *Resolved:* `sanitizeNext` same-origin only.
- **F6 (MEDIUM) testability mismatch.** *Resolved:* security core in pure modules; hook tested via a
  `RequestEvent` factory.
- **F7 (MEDIUM) dev-mode differences.** *Resolved:* bind guard prod-only; hook allows `route.id===null`.
- **F8 (LOW/MED) unstated CSRF reasoning.** *Resolved:* explicit CSRF invariant.
- **F9 (LOW) `/login` leaking `health`.** *Resolved:* bare `/login` layout.

### Critique Round 2

Fresh reviewer verified config-default behavior. Findings/fixes:

- **F10 (CRITICAL) HOST-default divergence** (adapter defaults `0.0.0.0`). *Resolved:* `server.js`
  sets `process.env.HOST` before both guard and adapter import; `web:start` keeps `HOST=127.0.0.1`.
- **F11 (CRITICAL) `Secure`-on-http-loopback** (url.protocol defaults https when ORIGIN unset).
  *Resolved:* `secureCookieFlag` keyed off `x-forwarded-proto` (and ORIGIN-set https), not bare
  `url.protocol`.
- **F12 (HIGH) co-located proxy spoofs loopback.** *Resolved:* no-token mode rejects `x-forwarded-*`;
  startup refuses when `looksProxied(env)` and no token.
- **F13 (MEDIUM) bindGuard from a hashed build chunk is unresolvable.** *Resolved:* shared
  dependency-free module (no build-path coupling).
- **F14 (MEDIUM) parity test can't import `server.js`.** *Resolved:* dissolved by F13; tests import the
  shared module directly.
- **F15 (LOW) build/start ordering.** *Resolved:* documented `web:start` presupposes `web:build`; hook
  backstops direct launch.
- **F16 (LOW) logout CSRF.** *Resolved:* logout is a urlencoded form POST.
- **F17 (LOW) degraded-project + `authEnabled`.** *Resolved:* derived purely from the env var.

### Critique Round 3

Final reviewer verified CSRF/origin and base-path behavior against adapter-node 5.5.4 + the built kit
runtime. Findings/fixes:

- **F18 (CRITICAL) kit CSRF 403s the login/logout form POST on http-loopback** — with `ORIGIN` unset,
  `url.origin` defaults to `https://…` while the browser sends `Origin: http://…`, so kit's
  origin-check (which runs before the hook) rejects the form; masked in dev. *Resolved:* `server.js`
  sets `ORIGIN=http://${HOST}:${PORT}` when unset so `url.origin` matches the browser; the dedicated
  "Origin / proxy environment" section documents the standalone and proxy cases.
- **F19 (HIGH) `ORIGIN` in `looksProxied` collides with the F18 fix** (standalone now sets `ORIGIN`,
  which would trip the no-token startup refusal). *Resolved:* `ORIGIN` removed from `looksProxied`;
  proxy posture keyed only on forwarded-header vars.
- **F20 (MEDIUM) `looksProxied` missing `PORT_HEADER`.** *Resolved:* added `PORT_HEADER`; list is now
  `ADDRESS_HEADER`/`XFF_DEPTH`/`PROTOCOL_HEADER`/`HOST_HEADER`/`PORT_HEADER`.
- **F21 (MEDIUM) shared module outside the TS project / cross-root import.** *Resolved:* placed at
  `web/src/lib/server/loopback.js` (in-project, bundled), imported by `server.js` via relative path
  and by `auth.ts`/tests as a sibling.
- **F22 (MEDIUM) base-path** on the `/login` redirect and form actions. *Resolved:* hook redirect
  prepends `base`; forms post to `{base}/login`|`/logout`; `sanitizeNext` is fed the base-prefixed
  pathname and used verbatim (no double base).
- **F23 (LOW) test isolation** — token-toggling needs env-before-import + `resetModules`. *Resolved:*
  documented in the test plan.
- **F24 (LOW) RequestEvent fake surface.** *Resolved:* factory specified (`cookies.get` for hook
  tests; `get/set/delete` for action tests).

Reviewer affirmed as solid (kept): adapter-node 5.5.4 accurate; `envPrefix` default `''` so direct
env reads match; kit CSRF runs before `handle` so the invariant composes; JSON `/api/*` immune to
form-CSRF; `getClientAddress()` returns the raw socket peer when `ADDRESS_HEADER` unset (validating
F12); the two proxy-defense layers compose without a gap; relative-path resolution from the repo-root
`web:start`; no double-listen (only `server.js` imports `build/index.js`).
