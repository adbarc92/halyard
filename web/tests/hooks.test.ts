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
  it("wrong Bearer token is rejected (401 on /api)", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/api/flip", path: "/api/flip", headers: { authorization: "Bearer wrong" } });
    const res = await handle({ event, resolve: okResolve() });
    expect(res.status).toBe(401);
  });
  it("wrong Bearer token on a page redirects to /login", async () => {
    const handle = await loadHandle("secret");
    const { event } = makeEvent({ routeId: "/queue", path: "/queue", headers: { authorization: "Bearer wrong" } });
    await expect(handle({ event, resolve: okResolve() })).rejects.toMatchObject({ status: 302 });
  });
  it("valid session cookie resolves", async () => {
    process.env.HALYARD_CONSOLE_TOKEN = "secret";
    vi.resetModules();
    const { createSession, SESSION_COOKIE } = await import("../src/lib/server/auth.js");
    const id = createSession();
    const handle = (await import("../src/hooks.server.js")).handle as any;
    const { event } = makeEvent({ routeId: "/", cookies: { [SESSION_COOKIE]: id } });
    const resolve = okResolve();
    await handle({ event, resolve });
    expect(resolve).toHaveBeenCalled();
  });
});

describe("hooks: Bearer brute-force throttling (#1 — closes the /login bypass)", () => {
  // Each loadHandle() resets modules, so the rate limiter starts empty per test.
  const badBearer = (addr: string) =>
    makeEvent({ routeId: "/api/flip", path: "/api/flip", clientAddress: addr,
      headers: { authorization: "Bearer wrong" } }).event;

  it("locks out repeated wrong Bearer guesses with 429 (not just 401)", async () => {
    const handle = await loadHandle("secret");
    for (let i = 0; i < 5; i++) {
      const res = await handle({ event: badBearer("203.0.113.9"), resolve: okResolve() });
      expect(res.status).toBe(401);
    }
    const res = await handle({ event: badBearer("203.0.113.9"), resolve: okResolve() });
    expect(res.status).toBe(429);
  });

  it("refuses even a correct Bearer while the client is locked out", async () => {
    const handle = await loadHandle("secret");
    for (let i = 0; i < 5; i++) {
      await handle({ event: badBearer("203.0.113.10"), resolve: okResolve() });
    }
    const good = makeEvent({ routeId: "/api/flip", path: "/api/flip", clientAddress: "203.0.113.10",
      headers: { authorization: "Bearer secret" } }).event;
    const res = await handle({ event: good, resolve: okResolve() });
    expect(res.status).toBe(429);
  });

  it("does not throttle no-Bearer requests (session/anon traffic never trips the limiter)", async () => {
    const handle = await loadHandle("secret");
    for (let i = 0; i < 8; i++) {
      await expect(
        handle({ event: makeEvent({ routeId: "/queue", path: "/queue", clientAddress: "203.0.113.11" }).event, resolve: okResolve() }),
      ).rejects.toMatchObject({ status: 302 });
    }
  });
});
