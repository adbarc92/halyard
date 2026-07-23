import { describe, expect, it } from "vitest";
import { sanitizeNext, timingSafeEqualStr, parseBearer, secureCookieFlag } from "../src/lib/server/auth.js";
import { createSession, isValidSession, destroySession, sessionCookieOptions } from "../src/lib/server/auth.js";

describe("sanitizeNext", () => {
  it("keeps a same-origin single-slash path and strips data suffix", () => {
    expect(sanitizeNext("/queue")).toBe("/queue");
    expect(sanitizeNext("/releases?x=1")).toBe("/releases?x=1");
    expect(sanitizeNext("/queue/__data.json")).toBe("/queue");
  });
  it("rejects open-redirect and junk to /", () => {
    for (const n of ["//evil.com", "/\\evil", "http://evil", "", null, undefined]) {
      expect(sanitizeNext(n as any)).toBe("/");
    }
  });
});

describe("timingSafeEqualStr", () => {
  it("true only on exact equal", () => {
    expect(timingSafeEqualStr("abc", "abc")).toBe(true);
    expect(timingSafeEqualStr("abc", "abd")).toBe(false);
    expect(timingSafeEqualStr("abc", "abcd")).toBe(false);
  });
});

describe("parseBearer", () => {
  it("parses case-insensitive Bearer with whitespace", () => {
    expect(parseBearer("Bearer tok")).toBe("tok");
    expect(parseBearer("bearer   tok ")).toBe("tok");
    expect(parseBearer("Basic x")).toBe(null);
    expect(parseBearer(null)).toBe(null);
  });
});

describe("secureCookieFlag", () => {
  it("https via forwarded proto, or https url when ORIGIN set; never plain url alone", () => {
    expect(secureCookieFlag({ forwardedProto: "https" })).toBe(true);
    expect(secureCookieFlag({ urlProtocol: "https:", originSet: true })).toBe(true);
    expect(secureCookieFlag({ urlProtocol: "https:", originSet: false })).toBe(false);
    expect(secureCookieFlag({ forwardedProto: "http", urlProtocol: "http:" })).toBe(false);
  });
});

describe("session store", () => {
  it("create -> valid; destroy -> invalid; expired -> invalid", () => {
    const t0 = 1_000_000;
    const id = createSession(t0);
    expect(isValidSession(id, t0 + 1000)).toBe(true);
    expect(isValidSession(id, t0 + 13 * 60 * 60 * 1000)).toBe(false); // past 12h TTL
    const id2 = createSession(t0);
    destroySession(id2);
    expect(isValidSession(id2, t0)).toBe(false);
    expect(isValidSession(undefined, t0)).toBe(false);
  });
});

describe("sessionCookieOptions", () => {
  it("httpOnly lax path=/ with secure passthrough", () => {
    expect(sessionCookieOptions(true)).toMatchObject({ path: "/", httpOnly: true, sameSite: "lax", secure: true });
    expect(sessionCookieOptions(false).secure).toBe(false);
  });
});
