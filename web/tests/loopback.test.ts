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
