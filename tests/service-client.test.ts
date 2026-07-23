// tests/service-client.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient, ServiceHttpError } from "../src/halyard/coordinator/service/client.js";

/** A fetch double that records the request and returns a canned Response. */
function cannedFetch(res: Response, sink?: (url: string, init: RequestInit) => void) {
  return (async (url: any, init: any = {}) => {
    sink?.(String(url), init);
    return res;
  }) as typeof fetch;
}

describe("ServiceHttpClient", () => {
  it("GET 200 returns parsed JSON; sends bearer auth + strips trailing slash", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = new ServiceHttpClient({
      baseUrl: "https://svc/",
      token: "tok_secret",
      fetchFn: cannedFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }), (u, i) => {
        seenUrl = u;
        seenAuth = (i.headers as Record<string, string>).authorization ?? "";
      }),
    });
    const body = await client.getJson("/releases/rel_1");
    expect(body).toEqual({ ok: true });
    expect(seenUrl).toBe("https://svc/releases/rel_1");
    expect(seenAuth).toBe("Bearer tok_secret");
  });

  it("GET 404 returns null (not an error)", async () => {
    const client = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 404 })) });
    expect(await client.getJson("/releases/missing")).toBeNull();
  });

  it("GET 500 throws a retryable ServiceHttpError; 400 throws non-retryable", async () => {
    const c500 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 500 })) });
    await expect(c500.getJson("/x")).rejects.toMatchObject({ name: "ServiceHttpError", status: 500, retryable: true });
    const c400 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 400 })) });
    await expect(c400.getJson("/x")).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("sendJson PUT 204 resolves undefined; PUT 200 returns body", async () => {
    const c204 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 204 })) });
    expect(await c204.sendJson("PUT", "/releases/r", { a: 1 })).toBeUndefined();
    const c200 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(JSON.stringify({ created: true }), { status: 200 })) });
    expect(await c200.sendJson("PUT", "/canon/c", {})).toEqual({ created: true });
  });

  it("a network error (or abort) becomes a retryable ServiceHttpError", async () => {
    const client = new ServiceHttpClient({
      baseUrl: "https://svc",
      token: "t",
      timeoutMs: 5,
      // never resolves; rejects when the timeout aborts the signal
      fetchFn: ((_u: any, init: any) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch,
    });
    await expect(client.getJson("/slow")).rejects.toMatchObject({ name: "ServiceHttpError", retryable: true });
  });

  it("never includes the token in a thrown error message", async () => {
    const client = new ServiceHttpClient({ baseUrl: "https://svc", token: "SUPERSECRET", fetchFn: cannedFetch(new Response(null, { status: 500 })) });
    await client.getJson("/x").catch((e: Error) => expect(e.message).not.toContain("SUPERSECRET"));
  });
});
