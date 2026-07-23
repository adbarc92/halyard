import { beforeEach, describe, expect, it } from "vitest";
import { HttpFlagClient } from "../src/halyard/flags/http-client.js";

interface Call { url: string; method: string; body?: { on?: boolean } }

/** A recording fetch stub that returns a scripted status/body per request. */
function stubFetch(handler: (url: string, method: string) => { status: number; body?: unknown }) {
  const calls: Call[] = [];
  const fetchFn = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const r = handler(url, method);
    return new Response(r.body !== undefined ? JSON.stringify(r.body) : null, { status: r.status });
  }) as typeof fetch;
  return { fetchFn, calls };
}

describe("HttpFlagClient (live flag provider, generic REST)", () => {
  let calls: Call[];
  const client = (handler: Parameters<typeof stubFetch>[0]) => {
    const s = stubFetch(handler);
    calls = s.calls;
    return new HttpFlagClient({ baseUrl: "https://flags.example.com/", token: "t", fetchFn: s.fetchFn });
  };

  beforeEach(() => {
    calls = [];
  });

  it("reads on/off/absent from the provider", async () => {
    expect(await client(() => ({ status: 200, body: { on: true } })).getState("launch.aurora.x")).toBe("on");
    expect(await client(() => ({ status: 200, body: { on: false } })).getState("launch.aurora.x")).toBe("off");
    expect(await client(() => ({ status: 404 })).getState("launch.aurora.x")).toBe("absent");
  });

  it("throws on an unexpected GET status", async () => {
    await expect(client(() => ({ status: 500 })).getState("k")).rejects.toThrow(/500/);
  });

  it("setState PUTs the boolean to the flag's URL", async () => {
    await client(() => ({ status: 200 })).setState("launch.aurora.x", true);
    expect(calls).toEqual([
      { url: "https://flags.example.com/flags/launch.aurora.x", method: "PUT", body: { on: true } },
    ]);
  });

  it("ensureFlag creates the flag OFF only when absent", async () => {
    // Absent → GET then PUT {on:false}.
    await client((_u, m) => (m === "GET" ? { status: 404 } : { status: 200 })).ensureFlag("launch.aurora.x");
    expect(calls.map((c) => c.method)).toEqual(["GET", "PUT"]);
    expect(calls[1]!.body).toEqual({ on: false });

    // Already exists → GET only, no PUT.
    await client(() => ({ status: 200, body: { on: true } })).ensureFlag("launch.aurora.x");
    expect(calls.map((c) => c.method)).toEqual(["GET"]);
  });
});
