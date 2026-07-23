# Web Console Auth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an auth boundary to the `@halyard/web` console — one shared `HALYARD_CONSOLE_TOKEN` covering accidental-exposure, standalone-remote, and embedded-behind-proxy, without breaking the zero-config localhost workflow.

**Architecture:** A pure security core (`loopback.js` + `auth.ts`), a `hooks.server.ts` request gate (Bearer / session-cookie / loopback / fail-closed), a `/login` + `/logout` form flow, conditional root-layout chrome (so the login screen is bare and leaks nothing), and a custom adapter-node entry `web/server.js` that fail-fast refuses to bind exposed-without-auth and sets `ORIGIN` so kit's CSRF check passes on http-loopback.

**Tech Stack:** SvelteKit (Svelte 5), `@sveltejs/adapter-node` ^5.5.4, vitest, Node `crypto`.

**Spec:** `docs/superpowers/specs/2026-06-15-web-console-auth-design.md` (read it; it carries the 3-round critique rationale).

---

## Implementation notes (read before starting)

- **Mechanism choice for the bare login screen:** SvelteKit nests layouts — a `login/+layout.svelte` does NOT stop the root `+layout.svelte` from rendering. So instead of a separate login layout, the **root** layout renders its chrome (nav, health banner, Sign-out) *conditionally* (hidden on `/login` and `/logout`), and `+layout.server.ts` omits the project `root` path from the payload when the visitor is unauthenticated (gated on `event.locals.authed`, set by the hook). This achieves the spec's "bare, no leak" intent correctly.
- **`$app/paths` in tests:** `hooks.server.ts` imports `base` from `$app/paths` (a SvelteKit virtual module). vitest (node env, no kit plugin) can't resolve it, so we add a vitest alias to a stub (Task 0). Existing tests are unaffected (stub `base = ""` matches the default).
- **Test isolation for the module-load token read:** `auth.ts` reads `HALYARD_CONSOLE_TOKEN` once at module load and holds the session `Map` at module scope. Any test that sets/clears the token must do so **before** importing `auth.ts`/`hooks.server.ts` and call `vi.resetModules()` between cases (same pattern the existing `service()` tests use).
- **Run web tests with:** `npm run -w web test` (or `cd web && npm run test`). Build the lib first only if a task touches `halyard` (none here do). Typecheck the web workspace with `npm run -w web check`.

## File structure

| File | Responsibility | Task |
|---|---|---|
| `web/src/lib/server/loopback.js` (new, plain JS) | `isLoopbackAddress`, `looksProxied`, `bindGuard` — shared by hook, auth, server.js, tests | 1 |
| `web/src/lib/server/auth.ts` (new) | token read, `timingSafeEqualStr`, `parseBearer`, `secureCookieFlag`, `sanitizeNext`, session store, cookie consts; re-exports loopback | 2,3 |
| `web/src/app.d.ts` (modify) | declare `App.Locals.authed` | 4 |
| `web/vite.config.ts` (modify) | vitest alias `$app/paths` → stub | 0 |
| `web/tests/mocks/app-paths.ts` (new) | `$app/paths` test stub | 0 |
| `web/tests/helpers/request-event.ts` (new) | `RequestEvent` factory for hook/action tests | 4 |
| `web/src/hooks.server.ts` (new) | the request gate | 5 |
| `web/src/routes/login/+page.svelte` (new) | token form | 6 |
| `web/src/routes/login/+page.server.ts` (new) | login `load` + action | 6 |
| `web/src/routes/logout/+page.server.ts` (new) | logout action | 7 |
| `web/src/routes/+layout.server.ts` (modify) | add `authEnabled`; gate `root` on `locals.authed` | 8 |
| `web/src/routes/+layout.svelte` (modify) | conditional chrome + Sign-out form | 8 |
| `web/server.js` (new, plain JS) | bind guard + ORIGIN default + handoff to adapter entry | 9 |
| root `package.json` (modify) | `web:start` → `node web/server.js` | 9 |
| `web/README.md`, `docs/INTEGRATION.md` (modify) | document the token model | 10 |
| `web/tests/{loopback,auth,hooks,login}.test.ts` (new) | tests | 1,2,3,5,6,7 |

---

## Task 0: Test plumbing for `$app/paths`

**Files:**
- Create: `web/tests/mocks/app-paths.ts`
- Modify: `web/vite.config.ts:10-13`

- [ ] **Step 1: Create the stub**

```ts
// web/tests/mocks/app-paths.ts
// Test stub for SvelteKit's $app/paths virtual module (base = root, the default).
export const base = "";
export const assets = "";
```

- [ ] **Step 2: Add the vitest alias**

Replace the `test` block in `web/vite.config.ts`:

```ts
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    alias: { "$app/paths": new URL("./tests/mocks/app-paths.ts", import.meta.url).pathname },
  },
```

- [ ] **Step 3: Verify existing tests still pass**

Run: `npm run -w web test`
Expected: PASS (47 tests; the alias is inert for them).

- [ ] **Step 4: Commit**

```bash
git add web/tests/mocks/app-paths.ts web/vite.config.ts
git commit -m "test(web): stub \$app/paths for hook/action unit tests"
```

---

## Task 1: `loopback.js` shared guard core

**Files:**
- Create: `web/src/lib/server/loopback.js`
- Test: `web/tests/loopback.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/tests/loopback.test.ts
import { describe, expect, it } from "vitest";
import { isLoopbackAddress, looksProxied, bindGuard } from "../src/lib/server/loopback.js";

describe("isLoopbackAddress", () => {
  it("accepts loopback forms incl. IPv4-mapped IPv6", () => {
    for (const a of ["127.0.0.1", "127.0.0.5", "::1", "localhost", "::ffff:127.0.0.1"]) {
      expect(isLoopbackAddress(a)).toBe(true);
    }
  });
  it("rejects non-loopback and empty", () => {
    for (const a of ["0.0.0.0", "192.168.1.5", "10.0.0.5", "", undefined as any]) {
      expect(isLoopbackAddress(a)).toBe(false);
    }
  });
});

describe("looksProxied", () => {
  it("true when any forwarded-header var is set; ORIGIN does NOT count", () => {
    for (const k of ["ADDRESS_HEADER", "XFF_DEPTH", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER"]) {
      expect(looksProxied({ [k]: "x" })).toBe(true);
    }
    expect(looksProxied({ ORIGIN: "http://x" })).toBe(false);
    expect(looksProxied({})).toBe(false);
  });
});

describe("bindGuard", () => {
  it("refuses only when no token AND (non-loopback host OR proxy posture)", () => {
    expect(bindGuard({ token: undefined, host: "127.0.0.1", env: {} })).toBe("ok");
    expect(bindGuard({ token: undefined, host: "::1", env: {} })).toBe("ok");
    expect(bindGuard({ token: undefined, host: "::ffff:127.0.0.1", env: {} })).toBe("ok");
    expect(bindGuard({ token: undefined, host: "0.0.0.0", env: {} })).toBe("refuse");
    expect(bindGuard({ token: undefined, host: "10.0.0.5", env: {} })).toBe("refuse");
    expect(bindGuard({ token: undefined, host: "127.0.0.1", env: { PROTOCOL_HEADER: "x" } })).toBe("refuse");
    expect(bindGuard({ token: "secret", host: "0.0.0.0", env: {} })).toBe("ok");
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- loopback`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `loopback.js`**

```js
// web/src/lib/server/loopback.js
// Dependency-free plain ESM. Shared by hooks.server.ts, auth.ts, web/server.js, and tests —
// one canonical source for the loopback / proxy-posture / bind-guard logic.

/** Loopback if 127.0.0.0/8, ::1, localhost, or IPv4-mapped IPv6 (::ffff:127.x). */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  let a = String(addr).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "localhost" || a === "::1") return true;
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  return a === "127.0.0.1" || a.startsWith("127.");
}

// adapter-node's forwarded-header config vars. ORIGIN is intentionally excluded: it fixes
// URL/CSRF generation and is set even for a bare loopback server (see the design's F19).
const PROXY_ENV_VARS = ["ADDRESS_HEADER", "XFF_DEPTH", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER"];

/** True if any forwarded-header proxy-posture env var is set. */
export function looksProxied(env) {
  return PROXY_ENV_VARS.some((k) => env[k] != null && env[k] !== "");
}

/** "refuse" iff no token AND (host non-loopback OR proxy posture); else "ok". */
export function bindGuard({ token, host, env }) {
  if (token) return "ok";
  if (!isLoopbackAddress(host) || looksProxied(env ?? {})) return "refuse";
  return "ok";
}
```

- [ ] **Step 4: Run it to verify pass**

Run: `npm run -w web test -- loopback`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/loopback.js web/tests/loopback.test.ts
git commit -m "feat(web): shared loopback/bindGuard core"
```

---

## Task 2: `auth.ts` request-time primitives

**Files:**
- Create: `web/src/lib/server/auth.ts`
- Test: `web/tests/auth.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/tests/auth.test.ts
import { describe, expect, it } from "vitest";
import { sanitizeNext, timingSafeEqualStr, parseBearer, secureCookieFlag } from "../src/lib/server/auth.js";

describe("sanitizeNext", () => {
  it("keeps a same-origin single-slash path and strips data suffix", () => {
    expect(sanitizeNext("/queue")).toBe("/queue");
    expect(sanitizeNext("/releases?x=1")).toBe("/releases?x=1");
    expect(sanitizeNext("/queue/__data.json")).toBe("/queue");
  });
  it("rejects open-redirect and junk to /", () => {
    for (const n of ["//evil.com", "/\\evil", "http://evil", "", null, undefined]) {
      expect(sanitizeNext(n as any)).toBe("/");
    }
  });
});

describe("timingSafeEqualStr", () => {
  it("true only on exact equal", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("parseBearer", () => {
  it("parses case-insensitive Bearer with whitespace", () => {
    expect(parseBearer("Bearer tok")).toBe("tok");
    expect(parseBearer("bearer   tok ")).toBe("tok");
    expect(parseBearer("Basic x")).toBe(null);
    expect(parseBearer(null)).toBe(null);
  });
});

describe("secureCookieFlag", () => {
  it("https via forwarded proto, or https url when ORIGIN set; never plain url alone", () => {
    expect(secureCookieFlag({ forwardedProto: "https" })).toBe(true);
    expect(secureCookieFlag({ urlProtocol: "https:", originSet: true })).toBe(true);
    expect(secureCookieFlag({ urlProtocol: "https:", originSet: false })).toBe(false);
    expect(secureCookieFlag({ forwardedProto: "http", urlProtocol: "http:" })).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- auth`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement the primitives in `auth.ts`** (session store added in Task 3)

```ts
// web/src/lib/server/auth.ts
import crypto from "node:crypto";
export { isLoopbackAddress, looksProxied, bindGuard } from "./loopback.js";

export const SESSION_COOKIE = "hal_session";

/** Operator token, read once at module load. null => no-token mode. */
export const consoleToken: string | null = process.env.HALYARD_CONSOLE_TOKEN || null;
export function authEnabled(): boolean {
  return consoleToken !== null;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  if (ba.length !== bb.length) return false;
  return crypto.timingSafeEqual(ba, bb);
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export function secureCookieFlag(opts: {
  forwardedProto?: string | null;
  urlProtocol?: string;
  originSet?: boolean;
}): boolean {
  if ((opts.forwardedProto ?? "").toLowerCase() === "https") return true;
  if (opts.originSet && opts.urlProtocol === "https:") return true;
  return false;
}

/** Safe same-origin path or "/". Rejects //, /\, absolute URLs, CRLF; strips any data suffix. */
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return "/";
  const n = next.replace(/\/__data\.json$/, "");
  if (!/^\/[^/\\]/.test(n)) return "/";
  try {
    const u = new URL(n, "http://x");
    if (u.origin !== "http://x") return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}
```

- [ ] **Step 4: Run it to verify pass**

Run: `npm run -w web test -- auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/auth.ts web/tests/auth.test.ts
git commit -m "feat(web): auth primitives (sanitizeNext, bearer, secure-cookie, timing-safe)"
```

---

## Task 3: `auth.ts` session store + cookie options

**Files:**
- Modify: `web/src/lib/server/auth.ts` (append)
- Test: `web/tests/auth.test.ts` (append)

- [ ] **Step 1: Write the failing test (append)**

```ts
import { createSession, isValidSession, destroySession, sessionCookieOptions } from "../src/lib/server/auth.js";

describe("session store", () => {
  it("create -> valid; destroy -> invalid; expired -> invalid", () => {
    const t0 = 1_000_000;
    const id = createSession(t0);
    expect(isValidSession(id, t0 + 1000)).toBe(true);
    expect(isValidSession(id, t0 + 13 * 60 * 60 * 1000)).toBe(false); // past 12h TTL
    const id2 = createSession(t0);
    destroySession(id2);
    expect(isValidSession(id2, t0)).toBe(false);
    expect(isValidSession(undefined, t0)).toBe(false);
  });
});

describe("sessionCookieOptions", () => {
  it("httpOnly lax path=/ with secure passthrough", () => {
    expect(sessionCookieOptions(true)).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax", secure: true });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- auth`
Expected: FAIL (exports not defined).

- [ ] **Step 3: Append the session store to `auth.ts`**

```ts
const TTL_MS = 12 * 60 * 60 * 1000;
interface Session { expiresAt: number; }
const sessions = new Map<string, Session>();

export function createSession(now: number = Date.now()): string {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { expiresAt: now + TTL_MS });
  return id;
}
export function isValidSession(id: string | undefined, now: number = Date.now()): boolean {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (s.expiresAt <= now) { sessions.delete(id); return false; }
  return true;
}
export function destroySession(id: string | undefined): void {
  if (id) sessions.delete(id);
}
export function sessionCookieOptions(secure: boolean) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: TTL_MS / 1000, secure };
}
```

- [ ] **Step 4: Run it to verify pass**

Run: `npm run -w web test -- auth`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/auth.ts web/tests/auth.test.ts
git commit -m "feat(web): in-memory session store + cookie options"
```

---

## Task 4: `App.Locals` type + `RequestEvent` test factory

**Files:**
- Modify: `web/src/app.d.ts`
- Create: `web/tests/helpers/request-event.ts`

- [ ] **Step 1: Declare `Locals.authed`**

Replace `web/src/app.d.ts` contents:

```ts
declare global {
  namespace App {
    interface Locals {
      /** Set by hooks.server.ts: is this request authenticated (or trusted-loopback no-token)? */
      authed: boolean;
    }
  }
}
export {};
```

- [ ] **Step 2: Create the test factory**

```ts
// web/tests/helpers/request-event.ts
import { vi } from "vitest";

/** Minimal RequestEvent fake for hooks/action unit tests. */
export function makeEvent(opts: {
  routeId?: string | null;
  path?: string;
  isDataRequest?: boolean;
  clientAddress?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  origin?: string;
} = {}) {
  const headers = new Headers(opts.headers ?? {});
  const jar = new Map<string, string>(Object.entries(opts.cookies ?? {}));
  const setCookies: { name: string; value: string; opts: any }[] = [];
  const url = new URL(opts.path ?? "/", opts.origin ?? "http://127.0.0.1:3000");
  const event: any = {
    route: { id: opts.routeId ?? null },
    isDataRequest: opts.isDataRequest ?? false,
    url,
    request: new Request(url, { headers }),
    getClientAddress: () => opts.clientAddress ?? "127.0.0.1",
    locals: {},
    cookies: {
      get: (n: string) => jar.get(n),
      set: (n: string, v: string, o: any) => { setCookies.push({ name: n, value: v, opts: o }); jar.set(n, v); },
      delete: (n: string, o: any) => { setCookies.push({ name: n, value: "", opts: o }); jar.delete(n); },
    },
  };
  return { event, setCookies };
}

/** A resolve() spy that returns a 200. */
export const okResolve = () => vi.fn(async () => new Response("ok", { status: 200 }));
```

- [ ] **Step 3: Typecheck**

Run: `npm run -w web check`
Expected: 0 errors.

- [ ] **Step 4: Commit**

```bash
git add web/src/app.d.ts web/tests/helpers/request-event.ts
git commit -m "test(web): App.Locals.authed + RequestEvent factory"
```

---

## Task 5: `hooks.server.ts` — the request gate

**Files:**
- Create: `web/src/hooks.server.ts`
- Test: `web/tests/hooks.test.ts`

- [ ] **Step 1: Write the failing test**

> The token is read at module load, so each case sets the env then `vi.resetModules()` then imports the hook.

```ts
// web/tests/hooks.test.ts
import { describe, expect, it, afterEach, vi } from "vitest";
import { makeEvent, okResolve } from "./helpers/request-event.js";

async function loadHandle(token?: string) {
  if (token === undefined) delete process.env.HALYARD_CONSOLE_TOKEN;
  else process.env.HALYARD_CONSOLE_TOKEN = token;
  vi.resetModules();
  return (await import("../src/hooks.server.js")).handle as any;
}
afterEach(() => { delete process.env.HALYARD_CONSOLE_TOKEN; vi.resetModules(); });

describe("hooks: no token", () => {
  it("loopback resolves", async () => {
    const handle = await loadHandle(undefined);
    const { event } = makeEvent({ routeId: "/", clientAddress: "127.0.0.1" });
    const resolve = okResolve();
    const res = await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
    expect(res.status).toBe(200);
  });
  it("non-loopback is 403", async () => {
    const handle = await loadHandle(undefined);
    const { event } = makeEvent({ routeId: "/", clientAddress: "203.0.113.5" });
    const res = await handle({ event, resolve: okResolve() });
    expect(res.status).toBe(403);
  });
  it("any x-forwarded-* is 403 even from loopback peer", async () => {
    const handle = await loadHandle(undefined);
    const { event } = makeEvent({ routeId: "/", clientAddress: "127.0.0.1", headers: { "x-forwarded-for": "1.2.3.4" } });
    const res = await handle({ event, resolve: okResolve() });
    expect(res.status).toBe(403);
  });
});

describe("hooks: token set", () => {
  it("valid Bearer resolves", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/", headers: { authorization: "Bearer secret" } });
    const resolve = okResolve();
    await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
  });
  it("unauthenticated page redirects to /login", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/queue", path: "/queue" });
    await expect(handle({ event, resolve: okResolve() })).rejects.toMatchObject({
      status: 302, location: "/login?next=%2Fqueue",
    });
  });
  it("unauthenticated /api is 401 (not redirect)", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/api/flip", path: "/api/flip" });
    const res = await handle({ event, resolve: okResolve() });
    expect(res.status).toBe(401);
  });
  it("unauthenticated data request is 401", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/queue", path: "/queue/__data.json", isDataRequest: true });
    const res = await handle({ event, resolve: okResolve() });
    expect(res.status).toBe(401);
  });
  it("/login passes through unauthenticated", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/login", path: "/login" });
    const resolve = okResolve();
    await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
  });
  it("asset (route.id null) passes through unauthenticated", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: null, path: "/_app/x.js" });
    const resolve = okResolve();
    await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- hooks`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `hooks.server.ts`**

```ts
// web/src/hooks.server.ts
import { type Handle, json, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import {
  consoleToken, isValidSession, parseBearer, timingSafeEqualStr,
  isLoopbackAddress, SESSION_COOKIE, sanitizeNext,
} from "$lib/server/auth.js";

function isAuthenticated(event: Parameters<Handle>[0]["event"]): boolean {
  if (!consoleToken) return false;
  const bearer = parseBearer(event.request.headers.get("authorization"));
  if (bearer && timingSafeEqualStr(bearer, consoleToken)) return true;
  return isValidSession(event.cookies.get(SESSION_COOKIE));
}

export const handle: Handle = async ({ event, resolve }) => {
  const routeId = event.route.id;
  const isPage = routeId !== null;
  const isApi = routeId?.startsWith("/api") ?? false;
  const isData = event.isDataRequest === true;

  if (!consoleToken) {
    // No-token mode: loopback-only, and never trust a peer when a proxy is in front.
    const forwarded = [...event.request.headers.keys()].some((k) => k.startsWith("x-forwarded-"));
    let addr = "";
    try { addr = event.getClientAddress(); } catch { addr = ""; }
    if (!forwarded && isLoopbackAddress(addr)) {
      event.locals.authed = true;
      return resolve(event);
    }
    return json({ message: "authentication required" }, { status: 403 });
  }

  if (isAuthenticated(event)) {
    event.locals.authed = true;
    return resolve(event);
  }

  // Token set, unauthenticated.
  event.locals.authed = false;
  if (routeId === "/login" || routeId === "/logout" || !isPage) return resolve(event);
  if (isApi || isData) return json({ message: "authentication required" }, { status: 401 });
  throw redirect(302, `${base}/login?next=${encodeURIComponent(sanitizeNext(event.url.pathname))}`);
};
```

- [ ] **Step 4: Run it to verify pass**

Run: `npm run -w web test -- hooks`
Expected: PASS (7 cases).

- [ ] **Step 5: Commit**

```bash
git add web/src/hooks.server.ts web/tests/hooks.test.ts
git commit -m "feat(web): hooks.server.ts auth gate"
```

---

## Task 6: `/login` route (load + action + form)

**Files:**
- Create: `web/src/routes/login/+page.server.ts`
- Create: `web/src/routes/login/+page.svelte`
- Test: `web/tests/login.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// web/tests/login.test.ts
import { describe, expect, it, afterEach, vi } from "vitest";

async function loadLoginAction(token: string) {
  process.env.HALYARD_CONSOLE_TOKEN = token;
  vi.resetModules();
  return (await import("../src/routes/login/+page.server.js")).actions.default as any;
}
function formEvent(fields: Record<string, string>, cookieSink: any[]) {
  const body = new URLSearchParams(fields).toString();
  const request = new Request("http://127.0.0.1/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  return {
    request,
    url: new URL("http://127.0.0.1/login"),
    cookies: { set: (n: string, v: string, o: any) => cookieSink.push({ n, v, o }) },
  } as any;
}
afterEach(() => { delete process.env.HALYARD_CONSOLE_TOKEN; vi.resetModules(); });

describe("login action", () => {
  it("valid token sets a session cookie and redirects to next", async () => {
    const action = await loadLoginAction("secret");
    const sink: any[] = [];
    await expect(action(formEvent({ token: "secret", next: "/queue" }, sink)))
      .rejects.toMatchObject({ status: 303, location: "/queue" });
    expect(sink).toHaveLength(1);
    expect(sink[0].n).toBe("hal_session");
    expect(sink[0].v).not.toBe("secret");           // opaque id, never the raw token
    expect(sink[0].v.length).toBeGreaterThanOrEqual(64);
  });
  it("invalid token fails 401 and sets no cookie", async () => {
    const action = await loadLoginAction("secret");
    const sink: any[] = [];
    const res = await action(formEvent({ token: "nope", next: "/" }, sink));
    expect(res.status).toBe(401);
    expect(res.data).toMatchObject({ error: "Invalid token" });
    expect(sink).toHaveLength(0);
  });
  it("open-redirect next is neutralized to base root", async () => {
    const action = await loadLoginAction("secret");
    const sink: any[] = [];
    await expect(action(formEvent({ token: "secret", next: "//evil.com" }, sink)))
      .rejects.toMatchObject({ status: 303, location: "/" });
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- login`
Expected: FAIL (module not found).

- [ ] **Step 3: Implement `+page.server.ts`**

```ts
// web/src/routes/login/+page.server.ts
import { fail, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import {
  consoleToken, timingSafeEqualStr, createSession, isValidSession,
  SESSION_COOKIE, sanitizeNext, secureCookieFlag, sessionCookieOptions,
} from "$lib/server/auth.js";

export const load = ({ cookies }: { cookies: { get(n: string): string | undefined } }) => {
  if (consoleToken && isValidSession(cookies.get(SESSION_COOKIE))) throw redirect(302, `${base}/`);
  return {};
};

export const actions = {
  default: async ({ request, cookies, url }: any) => {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const next = sanitizeNext(String(form.get("next") ?? "/"));
    if (!consoleToken || !timingSafeEqualStr(token, consoleToken)) {
      return fail(401, { error: "Invalid token" });
    }
    const id = createSession();
    const secure = secureCookieFlag({
      forwardedProto: request.headers.get("x-forwarded-proto"),
      urlProtocol: url.protocol,
      originSet: process.env.ORIGIN != null,
    });
    cookies.set(SESSION_COOKIE, id, sessionCookieOptions(secure));
    throw redirect(303, next === "/" ? `${base}/` : next);
  },
};
```

> Note: with the Task 0 `$app/paths` stub `base = ""`, `${base}/` === `/`, so the test's expected `location: "/"` holds.

- [ ] **Step 4: Implement the form `+page.svelte`**

```svelte
<!-- web/src/routes/login/+page.svelte -->
<script lang="ts">
  import { page } from "$app/stores";
  import { base } from "$app/paths";
  let { form } = $props();
  const next = $derived($page.url.searchParams.get("next") ?? "/");
</script>

<main class="login">
  <h1>Halyard console</h1>
  <form method="POST" action="{base}/login">
    <input type="hidden" name="next" value={next} />
    <label>Access token
      <input name="token" type="password" autocomplete="current-password" autofocus />
    </label>
    {#if form?.error}<p class="login-error" role="alert">{form.error}</p>{/if}
    <button type="submit">Sign in</button>
  </form>
</main>

<style>
  .login { max-width: 22rem; margin: 6rem auto; display: grid; gap: 1rem; font-family: system-ui, sans-serif; }
  .login form { display: grid; gap: 0.75rem; }
  .login input[type="password"] { width: 100%; padding: 0.5rem; }
  .login-error { color: #c0392b; margin: 0; }
</style>
```

- [ ] **Step 5: Run tests + typecheck**

Run: `npm run -w web test -- login && npm run -w web check`
Expected: login tests PASS; check 0 errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/login/+page.server.ts web/src/routes/login/+page.svelte web/tests/login.test.ts
git commit -m "feat(web): /login route (form + session-issuing action)"
```

---

## Task 7: `/logout` route

**Files:**
- Create: `web/src/routes/logout/+page.server.ts`
- Test: `web/tests/login.test.ts` (append)

- [ ] **Step 1: Write the failing test (append to login.test.ts)**

```ts
describe("logout action", () => {
  it("destroys the session and clears the cookie", async () => {
    process.env.HALYARD_CONSOLE_TOKEN = "secret";
    vi.resetModules();
    const { createSession, isValidSession } = await import("../src/lib/server/auth.js");
    const action = (await import("../src/routes/logout/+page.server.js")).actions.default as any;
    const id = createSession();
    const cleared: any[] = [];
    const event = { cookies: { get: () => id, delete: (n: string, o: any) => cleared.push({ n, o }) } } as any;
    await expect(action(event)).rejects.toMatchObject({ status: 303, location: "/login" });
    expect(cleared[0].n).toBe("hal_session");
    expect(isValidSession(id)).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to verify failure**

Run: `npm run -w web test -- login`
Expected: FAIL (logout module not found).

- [ ] **Step 3: Implement `/logout/+page.server.ts`**

```ts
// web/src/routes/logout/+page.server.ts
import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { destroySession, SESSION_COOKIE } from "$lib/server/auth.js";

export const actions = {
  default: ({ cookies }: any) => {
    destroySession(cookies.get(SESSION_COOKIE));
    cookies.delete(SESSION_COOKIE, { path: "/" });
    throw redirect(303, `${base}/login`);
  },
};
```

- [ ] **Step 4: Run it to verify pass**

Run: `npm run -w web test -- login`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/routes/logout/+page.server.ts web/tests/login.test.ts
git commit -m "feat(web): /logout route"
```

---

## Task 8: Layout — `authEnabled`, gated `root`, conditional chrome + Sign-out

**Files:**
- Modify: `web/src/routes/+layout.server.ts`
- Modify: `web/src/routes/+layout.svelte`

- [ ] **Step 1: Update `+layout.server.ts`**

Replace its contents:

```ts
import type { LayoutServerLoad } from "./$types";
import { service } from "$lib/server/service.js";
import { authEnabled } from "$lib/server/auth.js";

export const load: LayoutServerLoad = ({ locals }) => {
  const h = service().health();
  // Only the nav + degraded banner are rendered from this; never ship stateDir/apps. The project
  // `root` path is omitted for an unauthenticated visitor (the /login screen) to avoid info leak.
  return {
    authEnabled: authEnabled(),
    health: locals.authed
      ? { status: h.status, root: h.root, error: h.error ?? h.backendWarning }
      : { status: h.status, root: "", error: undefined },
  };
};
```

- [ ] **Step 2: Update `+layout.svelte`** — hide chrome on `/login` & `/logout`, add Sign-out

Apply these edits to `web/src/routes/+layout.svelte`:

Add to the `<script>` a current-route check (after the existing `isCurrent` function):

```ts
  const showChrome = $derived($page.route.id !== "/login" && $page.route.id !== "/logout");
```

Wrap the `<nav>…</nav>` block and the degraded banner block in `{#if showChrome}…{/if}`, and add the Sign-out form inside the nav's health area. The nav becomes:

```svelte
{#if showChrome}
<nav class="site-nav">
  <a href="{base}/" class="nav-brand">Halyard</a>
  <div class="nav-links">
    {#each navLinks as link}
      <a
        href="{base}{link.href}"
        aria-current={isCurrent(link.href, $page.url.pathname) ? "page" : undefined}
      >{link.label}</a>
    {/each}
  </div>
  <div class="nav-health {data.health.status === 'ok' ? 'ok' : ''}">
    <span class="health-dot" aria-hidden="true"></span>
    <span class="health-root">
      {data.health.status === "ok" ? data.health.root : "no project"}
    </span>
    {#if data.authEnabled}
      <form method="POST" action="{base}/logout" class="nav-logout">
        <button type="submit" class="btn btn-secondary btn-sm">Sign out</button>
      </form>
    {/if}
  </div>
</nav>

{#if data.health.status !== "ok"}
  <div class="page">
    <div class="degraded-banner" role="alert">
      No Halyard project at <code>{data.health.root}</code>: {data.health.error}
    </div>
  </div>
{/if}
{/if}

{@render children()}
```

(Keep the existing `<script>` imports; `page` and `base` are already imported.)

- [ ] **Step 3: Typecheck + full web suite**

Run: `npm run -w web check && npm run -w web test`
Expected: 0 check errors; all tests PASS (the existing layout payload test from PR #44 still asserts no `stateDir`/`apps` — unchanged; `locals.authed` is undefined in those direct-handler tests, so `health.root` is `""`, which the existing test does not assert against — confirm it still passes).

> If the existing `GET / layout payload` test asserts `health.root` is a string, it still holds (`""` is a string). If it asserts a specific value, update it to not depend on `root` (the test's intent is "no stateDir/apps", which is preserved).

- [ ] **Step 4: Commit**

```bash
git add web/src/routes/+layout.server.ts web/src/routes/+layout.svelte
git commit -m "feat(web): authEnabled + Sign-out; bare chrome on /login; gate root leak"
```

---

## Task 9: `web/server.js` bind guard + `web:start`

**Files:**
- Create: `web/server.js`
- Modify: root `package.json:40` (`web:start`)

- [ ] **Step 1: Implement `web/server.js`**

```js
// web/server.js
// Custom adapter-node entry: fail-fast bind guard, then hand off to the adapter's real server
// (so graceful shutdown / body limits / compression are retained). Run via `npm run web:start`.
import { bindGuard } from "./src/lib/server/loopback.js";

const host = process.env.HOST || "127.0.0.1"; // adapter defaults 0.0.0.0; force a safe default and
process.env.HOST = host;                       // make the guard's host identical to what it will bind.
const port = process.env.PORT || "3000";
// Standalone CSRF: with ORIGIN unset, SvelteKit defaults url scheme to https and rejects the
// http-loopback login form. Setting ORIGIN to the real http origin makes url.origin match.
process.env.ORIGIN ||= `http://${host}:${port}`;

if (bindGuard({ token: process.env.HALYARD_CONSOLE_TOKEN, host, env: process.env }) === "refuse") {
  console.error("refusing to bind non-loopback host without HALYARD_CONSOLE_TOKEN");
  process.exit(1);
}

await import("./build/index.js"); // adapter-node's real entry; binds using the HOST/ORIGIN set above
```

- [ ] **Step 2: Update `web:start` in root `package.json`**

Change line 40 from:

```json
    "web:start": "cross-env HOST=127.0.0.1 node web/build",
```

to:

```json
    "web:start": "cross-env HOST=127.0.0.1 node web/server.js",
```

- [ ] **Step 3: Verify the existing bind test still passes**

Run: `npm run -w web test -- bind`
Expected: PASS (`web:start` still contains `HOST=127.0.0.1`).

- [ ] **Step 4: Smoke-build the web app and confirm server.js boots refuse-path**

```bash
npm run web:build
HOST=0.0.0.0 node web/server.js; echo "exit=$?"
```
Expected: prints `refusing to bind non-loopback host without HALYARD_CONSOLE_TOKEN` and `exit=1`.

Then confirm the allowed path binds (loopback, no token):
```bash
HOST=127.0.0.1 PORT=3055 node web/server.js &
sleep 1; curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:3055/health; kill %1
```
Expected: `200`.

- [ ] **Step 5: Commit**

```bash
git add web/server.js package.json
git commit -m "feat(web): fail-fast bind guard entry (web/server.js) + ORIGIN default"
```

---

## Task 10: Docs

**Files:**
- Modify: `web/README.md:31-38` (Port/bind section)
- Modify: `docs/INTEGRATION.md` (web-console section)

- [ ] **Step 1: Rewrite the `web/README.md` bind section**

Replace the "Port and bind address" section (lines ~31-38) with:

```markdown
## Auth and bind address

The console is gated by one shared secret, `HALYARD_CONSOLE_TOKEN` (env; never logged, never a
config-file value — generate with `openssl rand -hex 32`).

| Env var | Default | Notes |
|---|---|---|
| `HALYARD_CONSOLE_TOKEN` | unset | Required to serve on any non-loopback host or behind a proxy. |
| `HOST` | `127.0.0.1` | Set by `web:start`. |
| `PORT` | `3000` | Listening port. |
| `ORIGIN` | `http://$HOST:$PORT` | Set automatically by `web:start` for standalone; set to the public origin behind a proxy. |

Behavior:
- **No token + loopback** → open, zero-config (local dev), exactly as before.
- **No token + non-loopback host, or any proxy env, or any `x-forwarded-*` request** → refused
  (the bind guard exits; the request hook returns 403). You cannot expose it without auth.
- **Token set** → a browser is redirected to `/login` (token → opaque session cookie); machines and
  reverse proxies send `Authorization: Bearer $HALYARD_CONSOLE_TOKEN`. Sign out clears the session.

`web:start` runs `node web/server.js`, which guards then hands off to the adapter server (it
presupposes a prior `web:build`). Running `node web/build` directly skips the fail-fast guard, but
the request hook still rejects non-loopback / proxied requests when no token is set.
```

- [ ] **Step 2: Add the embed contract to `docs/INTEGRATION.md`**

In the web-console section, add a subsection:

```markdown
#### Auth (embedding behind the hub / a reverse proxy)

The console requires `HALYARD_CONSOLE_TOKEN` to serve anything non-loopback. Behind a proxy:

- The proxy authenticates the operator and forwards `Authorization: Bearer $HALYARD_CONSOLE_TOKEN`
  on every request (the hook lets these straight through — the `/login` page is never shown).
- Set `ORIGIN` to the public origin and the forwarded-header vars (`PROTOCOL_HEADER`,
  `ADDRESS_HEADER`, `HOST_HEADER`) per adapter-node, so `url`/CSRF and the `Secure` cookie flag
  resolve correctly.
- **CSRF invariant:** every mutating `/api/*` route accepts `application/json` only. Do not switch
  any of them to form-encoded bodies — the cookie session's CSRF safety depends on it.
```

- [ ] **Step 3: Commit**

```bash
git add web/README.md docs/INTEGRATION.md
git commit -m "docs(web): document console auth + embed contract"
```

---

## Task 11: Full verification

- [ ] **Step 1: Web suite + typecheck**

Run: `npm run -w web test && npm run -w web check`
Expected: all web tests PASS (existing 47 + new loopback/auth/hooks/login ≈ +24); check 0 errors.

- [ ] **Step 2: Root suite unaffected**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; 317 root tests PASS (no `src/halyard` changes).

- [ ] **Step 3: Confirm no token leak in any cookie/log path**

Run: `npm run -w web test -- login hooks`
Expected: PASS, including the assertion that the session cookie value is never the raw token.

- [ ] **Step 4: Final commit (if any docs/cleanup remain)**

```bash
git status   # expect clean
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** loopback/bindGuard (Task 1) ↔ Components 0a/3; auth primitives + session (Tasks 2-3) ↔ Component 0b; hook (Task 5) ↔ Component 1; /login + /logout (Tasks 6-7) ↔ Component 2; layout authEnabled/bare-chrome (Task 8) ↔ Component 2 + F9; server.js + ORIGIN (Task 9) ↔ Component 3 + F18; docs (Task 10). All spec sections map to a task.
- **Type/name consistency:** `SESSION_COOKIE = "hal_session"`, `consoleToken`, `authEnabled()`, `createSession/isValidSession/destroySession`, `sessionCookieOptions`, `secureCookieFlag`, `sanitizeNext`, `parseBearer`, `timingSafeEqualStr`, `isLoopbackAddress`, `looksProxied`, `bindGuard` — names used identically across tasks.
- **No coordinator code touched** — invariants intact; the token is a console-process env secret, never logged or serialized.
```
