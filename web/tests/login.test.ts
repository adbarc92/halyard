import { describe, expect, it, afterEach, vi } from "vitest";

// Drives the injected clock so lockout windows advance without real wall-clock time.
let clockNow = "1970-01-01T00:00:00.000Z";
vi.mock("../src/lib/server/clock.js", () => ({ systemClock: () => clockNow }));
function setNowMs(ms: number) { clockNow = new Date(ms).toISOString(); }

async function loadLoginAction(token: string) {
  process.env.HALYARD_CONSOLE_TOKEN = token;
  vi.resetModules();
  return (await import("../src/routes/login/+page.server.js")).actions.default as any;
}
function formEvent(fields: Record<string, string>, cookieSink: any[], addr = "127.0.0.1") {
  const body = new URLSearchParams(fields).toString();
  const request = new Request("http://127.0.0.1/login", {
    method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body,
  });
  return {
    request,
    url: new URL("http://127.0.0.1/login"),
    getClientAddress: () => addr,
    cookies: { set: (n: string, v: string, o: any) => cookieSink.push({ n, v, o }) },
  } as any;
}
afterEach(() => { delete process.env.HALYARD_CONSOLE_TOKEN; clockNow = "1970-01-01T00:00:00.000Z"; vi.resetModules(); });

describe("login action", () => {
  it("valid token sets a session cookie and redirects to next", async () => {
    const action = await loadLoginAction("secret");
    const sink: any[] = [];
    await expect(action(formEvent({ token: "secret", next: "/queue" }, sink)))
      .rejects.toMatchObject({ status: 303, location: "/queue" });
    expect(sink).toHaveLength(1);
    expect(sink[0].n).toBe("hal_session");
    expect(sink[0].v).not.toBe("secret");
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

describe("login rate limiting (injected clock)", () => {
  it("locks the client after repeated bad tokens, then frees it after the window", async () => {
    setNowMs(1_000_000);
    const action = await loadLoginAction("secret");
    const { MAX_FAILURES, LOCKOUT_MS } = await import("../src/lib/server/ratelimit.js");
    const sink: any[] = [];

    // MAX_FAILURES bad attempts: each a plain 401, no lock yet.
    for (let i = 0; i < MAX_FAILURES; i++) {
      const res = await action(formEvent({ token: "nope", next: "/" }, sink));
      expect(res.status).toBe(401);
    }
    // Next attempt — even with the CORRECT token — is throttled, not authenticated.
    const locked = await action(formEvent({ token: "secret", next: "/" }, sink));
    expect(locked.status).toBe(429);
    expect(locked.data.error).toMatch(/too many attempts/i);
    expect(sink).toHaveLength(0); // never issued a session while locked

    // Advance past the lockout window: the correct token now succeeds.
    setNowMs(1_000_000 + LOCKOUT_MS);
    await expect(action(formEvent({ token: "secret", next: "/queue" }, sink)))
      .rejects.toMatchObject({ status: 303, location: "/queue" });
    expect(sink).toHaveLength(1);
  });

  it("a successful login clears accumulated failures", async () => {
    setNowMs(1_000_000);
    const action = await loadLoginAction("secret");
    const { MAX_FAILURES } = await import("../src/lib/server/ratelimit.js");
    const sink: any[] = [];

    // One short of the lock.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      await action(formEvent({ token: "nope", next: "/" }, sink));
    }
    // Succeed (clears the counter).
    await expect(action(formEvent({ token: "secret", next: "/" }, sink)))
      .rejects.toMatchObject({ status: 303 });
    // A fresh run of bad attempts must start from zero, not stack into a lock.
    for (let i = 0; i < MAX_FAILURES - 1; i++) {
      const res = await action(formEvent({ token: "nope", next: "/" }, sink));
      expect(res.status).toBe(401); // still not locked
    }
  });
});

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
