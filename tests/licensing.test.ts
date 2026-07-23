import { generateKeyPairSync } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { issueLicense, verifyLicense, loadEntitlement, resetEntitlement } from "../src/halyard/licensing/license.js";
import { FREE, makeEntitlement, enforceMultiApp, PRO_FEATURES } from "../src/halyard/licensing/entitlement.js";
import { dispatch } from "../src/halyard/cli.js";

function keypair() {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    pub: publicKey.export({ type: "spki", format: "pem" }).toString(),
    priv: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
  };
}
const NOW = Date.parse("2026-06-07T00:00:00.000Z");
const base = { licensee: "Acme", tier: "pro" as const, issued: "2026-01-01T00:00:00.000Z" };

describe("license signing + verification (offline)", () => {
  it("issues and verifies a valid Pro license", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: [...PRO_FEATURES] }, priv);
    const payload = verifyLicense(token, pub, NOW);
    expect(payload?.licensee).toBe("Acme");
    expect(payload?.features).toEqual([...PRO_FEATURES]);
  });

  it("rejects a tampered payload (signature no longer matches)", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: ["ai-agents"] }, priv);
    const sig = token.split(".")[1]!;
    const forged = Buffer.from(JSON.stringify({ ...base, features: [...PRO_FEATURES] })).toString("base64url") + "." + sig;
    expect(verifyLicense(forged, pub, NOW)).toBeNull();
  });

  it("rejects a license signed by a different key", () => {
    const a = keypair();
    const b = keypair();
    const token = issueLicense({ ...base, features: ["ai-agents"] }, a.priv);
    expect(verifyLicense(token, b.pub, NOW)).toBeNull();
  });

  it("rejects an expired license", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: ["ai-agents"], expires: "2026-01-01T00:00:00.000Z" }, priv);
    expect(verifyLicense(token, pub, NOW)).toBeNull(); // NOW is after expiry
  });

  it("never throws on garbage", () => {
    const { pub } = keypair();
    expect(verifyLicense("not-a-token", pub, NOW)).toBeNull();
    expect(verifyLicense("", pub, NOW)).toBeNull();
  });
});

describe("loadEntitlement (fail-safe to FREE)", () => {
  it("defaults to FREE with no license key", () => {
    expect(loadEntitlement({ get: () => undefined, nowMs: NOW }).tier).toBe("free");
  });

  it("resolves Pro (with exactly its features) from a valid token", () => {
    const { pub, priv } = keypair();
    const token = issueLicense({ ...base, features: ["ai-agents", "multi-app"] }, priv);
    const e = loadEntitlement({ get: (n) => (n === "HALYARD_LICENSE_KEY" ? token : undefined), nowMs: NOW, publicKeyPem: pub });
    expect(e.tier).toBe("pro");
    expect(e.has("ai-agents")).toBe(true);
    expect(e.has("multi-app")).toBe(true);
    expect(e.has("auto-merge")).toBe(false); // not granted
  });

  it("falls back to FREE on an invalid token (never throws)", () => {
    expect(loadEntitlement({ get: (n) => (n === "HALYARD_LICENSE_KEY" ? "garbage" : undefined), nowMs: NOW }).tier).toBe("free");
  });
});

describe("enforceMultiApp gate", () => {
  const proMulti = makeEntitlement({ tier: "pro", licensee: "x", features: ["multi-app"], expiresAt: null });
  it("blocks >1 app on FREE", () => expect(() => enforceMultiApp(2, FREE)).toThrow(/Pro/));
  it("allows 1 app on FREE", () => expect(() => enforceMultiApp(1, FREE)).not.toThrow());
  it("allows >1 app with the multi-app feature", () => expect(() => enforceMultiApp(3, proMulti)).not.toThrow());
});

describe("halyard license", () => {
  afterEach(() => { resetEntitlement(); vi.restoreAllMocks(); });
  it("reports the FREE tier by default", async () => {
    resetEntitlement();
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    expect(await dispatch(["license"])).toBe(0);
    expect(log.mock.calls.flat().join("")).toMatch(/"tier": "free"/);
  });
});
