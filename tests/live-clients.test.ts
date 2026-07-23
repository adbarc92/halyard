import { generateKeyPairSync } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { LiveSentryClient } from "../src/halyard/agents/triage/sentry-client.js";
import { LiveAscClient } from "../src/halyard/coordinator/sources/asc-client.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

function stubFetch(ok: boolean, status: number, jsonBody: unknown): string[] {
  const urls: string[] = [];
  vi.stubGlobal("fetch", async (url: string) => {
    urls.push(String(url));
    return { ok, status, statusText: String(status), json: async () => jsonBody } as Response;
  });
  return urls;
}
afterEach(() => vi.unstubAllGlobals());

describe("LiveSentryClient", () => {
  afterEach(() => { delete process.env.SENTRY_AUTH_TOKEN; });

  it("throws when SENTRY_AUTH_TOKEN is absent (never silently reports healthy)", async () => {
    delete process.env.SENTRY_AUTH_TOKEN;
    await expect(new LiveSentryClient("org", "proj").getReleaseHealth("a", "ios", "1.0.0")).rejects.toThrow(/SENTRY_AUTH_TOKEN/);
  });

  it("converts crash_free_rate to a one-decimal percentage", async () => {
    process.env.SENTRY_AUTH_TOKEN = "t";
    stubFetch(true, 200, { groups: [{ totals: { "crash_free_rate(session)": 0.9942, "sum(session)": 1234 } }] });
    const stats = await new LiveSentryClient("org", "proj").getReleaseHealth("aurora", "ios", "1.4.0");
    expect(stats.crashFreePct).toBe(99.4); // round(0.9942 * 1000) / 10
    expect(stats.eventCount).toBe(1234);
  });

  it("throws on a non-ok Sentry response", async () => {
    process.env.SENTRY_AUTH_TOKEN = "t";
    stubFetch(false, 503, {});
    await expect(new LiveSentryClient("org", "proj").getReleaseHealth("a", "ios", "1.0.0")).rejects.toThrow(/Sentry API 503/);
  });
});

describe("LiveAscClient", () => {
  const release = { surface: "ios" } as Release;
  beforeEach(() => {
    const { privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
    process.env.ASC_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    process.env.ASC_KEY_ID = "KID";
    process.env.ASC_ISSUER_ID = "ISS";
  });
  afterEach(() => {
    delete process.env.ASC_PRIVATE_KEY; delete process.env.ASC_KEY_ID; delete process.env.ASC_ISSUER_ID;
  });

  it("maps READY_FOR_SALE to approved", async () => {
    stubFetch(true, 200, { data: [{ attributes: { appStoreState: "READY_FOR_SALE" } }] });
    expect(await new LiveAscClient("123").getReviewStatus(release)).toBe("approved");
  });

  it("treats an unrecognized appStoreState as processing AND warns loudly (no silent park)", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    stubFetch(true, 200, { data: [{ attributes: { appStoreState: "BRAND_NEW_APPLE_STATE" } }] });
    expect(await new LiveAscClient("123").getReviewStatus(release)).toBe("processing");
    expect(warn).toHaveBeenCalledWith(expect.stringMatching(/unrecognized ASC appStoreState 'BRAND_NEW_APPLE_STATE'/));
    warn.mockRestore();
  });

  it("throws on a non-ok ASC response", async () => {
    stubFetch(false, 401, {});
    await expect(new LiveAscClient("123").getReviewStatus(release)).rejects.toThrow(/ASC API 401/);
  });
});
