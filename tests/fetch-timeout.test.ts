import { describe, it, expect } from "vitest";
import { fetchWithTimeout, DEFAULT_FETCH_TIMEOUT_MS } from "../src/halyard/net.js";

describe("fetchWithTimeout", () => {
  it("aborts a fetch that never resolves once the timeout elapses", async () => {
    // A fetch that hangs forever unless its signal aborts — proves the wrapper bounds it.
    const hanging: typeof fetch = (_input, init) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    await expect(fetchWithTimeout(hanging, "http://example.test", {}, 10)).rejects.toThrow();
  });

  it("passes a fast response straight through (and clears the timer)", async () => {
    const ok: typeof fetch = async () => new Response("ok", { status: 200 });
    const res = await fetchWithTimeout(ok, "http://example.test", {}, 1000);
    expect(res.status).toBe(200);
  });

  it("forwards the caller's init but injects its own abort signal", async () => {
    let seen: RequestInit | undefined;
    const capture: typeof fetch = async (_input, init) => {
      seen = init;
      return new Response(null, { status: 204 });
    };
    await fetchWithTimeout(capture, "http://example.test", { method: "PUT" }, DEFAULT_FETCH_TIMEOUT_MS);
    expect(seen?.method).toBe("PUT");
    expect(seen?.signal).toBeInstanceOf(AbortSignal);
  });
});
