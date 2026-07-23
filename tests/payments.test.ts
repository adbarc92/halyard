import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { StripePaymentProvider } from "../src/halyard/payments/stripe-client.js";
import { dispatch } from "../src/halyard/cli.js";

const here = dirname(fileURLToPath(import.meta.url));
const rawApp = parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")) as Record<string, any>;

function fakeFetch(ok: boolean, body: unknown = {}, status = ok ? 200 : 401): typeof fetch {
  return (async () => ({ ok, status, json: async () => body })) as unknown as typeof fetch;
}

describe("payments config", () => {
  it("accepts a payments block with a SECRET reference", () => {
    expect(() => validateAppConfig(rawApp)).not.toThrow();
    expect(validateAppConfig(rawApp).payments?.provider).toBe("stripe");
  });

  it("rejects a raw key in payments.api_key_ref (invariant #4)", () => {
    const bad = { ...rawApp, payments: { provider: "stripe", api_key_ref: "sk_live_deadbeef" } };
    expect(() => validateAppConfig(bad)).toThrow();
  });
});

describe("StripePaymentProvider.verifyAccess (read-only; never moves money)", () => {
  it("reports reachable + mode on a successful balance read", async () => {
    const live = await new StripePaymentProvider({ apiKey: "sk", fetchFn: fakeFetch(true, { livemode: true }) }).verifyAccess();
    expect(live).toEqual({ provider: "stripe", configured: true, reachable: true, detail: "livemode" });
    const test = await new StripePaymentProvider({ apiKey: "sk", fetchFn: fakeFetch(true, { livemode: false }) }).verifyAccess();
    expect(test.detail).toBe("testmode");
  });

  it("reports unreachable (not a throw) on a non-2xx response", async () => {
    const s = await new StripePaymentProvider({ apiKey: "bad", fetchFn: fakeFetch(false, {}, 401) }).verifyAccess();
    expect(s).toMatchObject({ configured: true, reachable: false, detail: "Stripe API 401" });
  });
});

describe("halyard payments verify (preflight)", () => {
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  });
  afterEach(() => { logSpy.mockRestore(); errSpy.mockRestore(); vi.unstubAllGlobals(); delete process.env.STRIPE_API_KEY_AURORA; });

  it("exits 0 when the configured key authenticates", async () => {
    process.env.STRIPE_API_KEY_AURORA = "sk_test_x";
    vi.stubGlobal("fetch", fakeFetch(true, { livemode: false }));
    expect(await dispatch(["payments", "verify", "--apps", "aurora"])).toBe(0);
  });

  it("does not fail an app that simply has no credentials configured (exit 0)", async () => {
    delete process.env.STRIPE_API_KEY_AURORA; // no key resolvable → reported, not failed
    expect(await dispatch(["payments", "verify", "--apps", "aurora"])).toBe(0);
  });

  it("exits 2 on an unknown subcommand", async () => {
    expect(await dispatch(["payments", "wat"])).toBe(2);
  });
});
