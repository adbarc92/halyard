import { describe, expect, it } from "vitest";
import { RAW_TO_STATUS, mapRawAscState } from "../src/halyard/coordinator/sources/asc-client.js";

describe("§E: ASC raw appStoreState → normalized review status", () => {
  it("maps every documented raw state to its status", () => {
    for (const [raw, expected] of Object.entries(RAW_TO_STATUS)) {
      expect(mapRawAscState(raw)).toBe(expected);
    }
  });

  it("only the approved-family states yield `approved` (→ shipped_dark)", () => {
    const approved = Object.entries(RAW_TO_STATUS)
      .filter(([, s]) => s === "approved")
      .map(([raw]) => raw);
    expect(approved.sort()).toEqual(
      ["ACCEPTED", "PENDING_APPLE_RELEASE", "PENDING_DEVELOPER_RELEASE", "READY_FOR_SALE"].sort(),
    );
  });

  it("defaults unknown / missing states to `processing` (never auto-advances)", () => {
    expect(mapRawAscState("SOME_NEW_APPLE_STATE")).toBe("processing");
    expect(mapRawAscState(undefined)).toBe("processing");
    expect(mapRawAscState("")).toBe("processing");
  });
});
