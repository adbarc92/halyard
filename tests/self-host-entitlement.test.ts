import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  issueLicense,
  loadEntitlement,
  getEntitlement,
  resetEntitlement,
  isSelfHostEnabled,
} from "../src/halyard/licensing/license.js";
import { enforceMultiApp, FREE, PRO_FEATURES } from "../src/halyard/licensing/entitlement.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}

const NOW = Date.parse("2026-06-07T00:00:00.000Z");
const base = { licensee: "Acme", tier: "pro" as const, issued: "2026-01-01T00:00:00.000Z" };

/** Build an injected env getter from a plain record — keeps the core pure/offline. */
const env = (vars: Record<string, string | undefined>) => (name: string) => vars[name];

describe("self-host entitlement (HALYARD_SELF_HOST)", () => {
  it("unlocks multi-app acting and reports the self-host grant", () => {
    const e = loadEntitlement({ get: env({ HALYARD_SELF_HOST: "1" }), nowMs: NOW });
    expect(e.tier).toBe("pro");
    expect(e.has("multi-app")).toBe(true);
    expect(e.grant).toBe("self-host");
    expect(e.licensee).toBe("self-host");
    expect(e.reason).toMatch(/self-host/i);
    // The actual entitlement decision ("may this act on N apps?") now passes.
    expect(() => enforceMultiApp(3, e)).not.toThrow();
  });

  it("accepts the common truthy spellings and rejects everything else", () => {
    for (const v of ["1", "true", "TRUE", "yes", "on", " true "]) {
      expect(isSelfHostEnabled(v)).toBe(true);
    }
    for (const v of [undefined, "", "0", "false", "off", "no", "maybe"]) {
      expect(isSelfHostEnabled(v)).toBe(false);
    }
  });

  it("a non-affirmative flag value leaves the gate intact", () => {
    const e = loadEntitlement({ get: env({ HALYARD_SELF_HOST: "false" }), nowMs: NOW });
    expect(e.tier).toBe("free");
    expect(e.has("multi-app")).toBe(false);
  });
});

describe("open-core gate stays intact for external users", () => {
  it("no key and no self-host: multi-app acting is NOT entitled", () => {
    const e = loadEntitlement({ get: env({}), nowMs: NOW });
    expect(e.tier).toBe("free");
    expect(e.grant).toBe("none");
    expect(e.has("multi-app")).toBe(false);
    expect(() => enforceMultiApp(2, e)).toThrow(/Pro/);
  });
});

describe("paid path is not weakened by adding self-host", () => {
  it("a valid signed key still entitles Pro (grant=license, real licensee preserved)", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: [...PRO_FEATURES] }, priv);
    const e = loadEntitlement({ get: env({ HALYARD_LICENSE_KEY: token }), nowMs: NOW, publicKeyPem: pub });
    expect(e.tier).toBe("pro");
    expect(e.has("multi-app")).toBe(true);
    expect(e.grant).toBe("license");
    expect(e.licensee).toBe("Acme");
  });

  it("a self-issued key (owner's own keypair set as verifier) is accepted like any valid key", () => {
    // Mirrors the owner running scripts/issue-license.ts against their own keypair and pointing
    // HALYARD_LICENSE_PUBKEY at the matching public half.
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, licensee: "Owner Self", features: [...PRO_FEATURES] }, priv);
    const e = loadEntitlement({
      get: env({ HALYARD_LICENSE_KEY: token, HALYARD_LICENSE_PUBKEY: pub }),
      nowMs: NOW,
    });
    expect(e.grant).toBe("license");
    expect(e.licensee).toBe("Owner Self");
    expect(e.has("multi-app")).toBe(true);
  });

  it("a forged/garbage token does NOT entitle (verification unchanged)", () => {
    const e = loadEntitlement({ get: env({ HALYARD_LICENSE_KEY: "garbage" }), nowMs: NOW });
    expect(e.tier).toBe("free");
    expect(e.has("multi-app")).toBe(false);
  });

  it("a token signed by a DIFFERENT key does NOT entitle", () => {
    const a = keypair();
    const b = keypair();
    const token = issueLicense({ ...base, features: [...PRO_FEATURES] }, a.priv);
    const e = loadEntitlement({ get: env({ HALYARD_LICENSE_KEY: token }), nowMs: NOW, publicKeyPem: b.pub });
    expect(e.tier).toBe("free");
    expect(e.has("multi-app")).toBe(false);
  });

  it("an expired valid-signature token does NOT entitle", () => {
    const { pub, priv } = keypair();
    const token = issueLicense(
      { ...base, features: [...PRO_FEATURES], expires: "2026-01-01T00:00:00.000Z" },
      priv,
    );
    const e = loadEntitlement({ get: env({ HALYARD_LICENSE_KEY: token }), nowMs: NOW, publicKeyPem: pub });
    expect(e.tier).toBe("free"); // NOW is after expiry
  });

  it("a valid paid key takes precedence over the self-host flag (keeps its licensee)", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: [...PRO_FEATURES] }, priv);
    const e = loadEntitlement({
      get: env({ HALYARD_LICENSE_KEY: token, HALYARD_SELF_HOST: "1" }),
      nowMs: NOW,
      publicKeyPem: pub,
    });
    expect(e.grant).toBe("license");
    expect(e.licensee).toBe("Acme");
  });

  it("an INVALID key alongside self-host falls through to the self-host grant (not Pro-from-key)", () => {
    const e = loadEntitlement({
      get: env({ HALYARD_LICENSE_KEY: "garbage", HALYARD_SELF_HOST: "true" }),
      nowMs: NOW,
    });
    expect(e.grant).toBe("self-host");
    expect(e.has("multi-app")).toBe(true);
  });
});

describe("read-only + single-app stays free regardless", () => {
  it("single app never trips the gate on FREE", () => {
    expect(() => enforceMultiApp(1, FREE)).not.toThrow();
    expect(() => enforceMultiApp(0, FREE)).not.toThrow();
  });

  it("single app never trips the gate under self-host either", () => {
    const e = loadEntitlement({ get: env({ HALYARD_SELF_HOST: "1" }), nowMs: NOW });
    expect(() => enforceMultiApp(1, e)).not.toThrow();
  });
});

describe("self-host grant is auditable, not silent", () => {
  const saved = { ...process.env };
  afterEach(() => {
    resetEntitlement();
    process.env = { ...saved };
    vi.restoreAllMocks();
  });

  it("getEntitlement warns once when the grant is self-host", () => {
    resetEntitlement();
    process.env.HALYARD_SELF_HOST = "1";
    delete process.env.HALYARD_LICENSE_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const e = getEntitlement();
    expect(e.grant).toBe("self-host");
    // Called once on first resolution; memoized thereafter.
    getEntitlement();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls.flat().join("")).toMatch(/self-host/i);
  });

  it("getEntitlement does NOT warn for a FREE resolution", () => {
    resetEntitlement();
    delete process.env.HALYARD_SELF_HOST;
    delete process.env.HALYARD_LICENSE_KEY;
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(getEntitlement().grant).toBe("none");
    expect(warn).not.toHaveBeenCalled();
  });
});
