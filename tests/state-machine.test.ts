import { describe, expect, it } from "vitest";
import {
  applyTransition,
  isLegalTransition,
  isTerminal,
  legalNextStates,
} from "../src/halyard/coordinator/state-machine.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

let clock = 0;
const now = () => `2025-06-05T01:00:${String(clock++).padStart(2, "0")}.000Z`;

function releaseAt(state: Release["state"]): Release {
  // Build a record sitting at `state` by walking a legal path to it.
  clock = 0;
  let r = newRelease({ releaseId: "rel_aurora_web_9.9.9", app: "aurora", surface: "web", version: "9.9.9" });
  const path: Record<string, Release["state"][]> = {
    tagged: ["tagged"],
    built: ["tagged", "built"],
    tested: ["tagged", "built", "tested"],
    uploaded: ["tagged", "built", "tested", "uploaded"],
    in_review: ["tagged", "built", "tested", "uploaded", "in_review"],
    shipped_dark: ["tagged", "built", "tested", "uploaded", "in_review", "shipped_dark"],
    dead: ["tagged", "dead"],
  };
  for (const to of path[state] ?? ["tagged"]) {
    const out = applyTransition(r, to, "test", now);
    if (out.applied) r = out.release;
  }
  return r;
}

describe("M2: state machine encodes the §2 graph", () => {
  it("permits the documented edges", () => {
    expect(isLegalTransition("tested", "uploaded")).toBe(true);
    expect(isLegalTransition("uploaded", "in_review")).toBe(true);
    expect(isLegalTransition("in_review", "shipped_dark")).toBe(true);
    expect(isLegalTransition("shipped_dark", "live")).toBe(true);
    expect(isLegalTransition("live", "rolled_back")).toBe(true);
    expect(isLegalTransition("uploaded", "live")).toBe(true); // web promote path
  });

  it("rejects edges that skip or reverse the machine", () => {
    expect(isLegalTransition("tagged", "live")).toBe(false);
    expect(isLegalTransition("tested", "shipped_dark")).toBe(false);
    expect(isLegalTransition("live", "built")).toBe(false);
  });

  it("marks dead terminal; rolled_back is re-flippable back to live", () => {
    expect(isTerminal("dead")).toBe(true);
    expect(isTerminal("rolled_back")).toBe(false); // re-flip ON → live again
    expect(isLegalTransition("rolled_back", "live")).toBe(true);
    expect(isTerminal("uploaded")).toBe(false);
    expect(legalNextStates("dead")).toHaveLength(0);
  });

  it("applyTransition: legal applies, illegal rejected, duplicate is a no-op", () => {
    const uploaded = releaseAt("uploaded");

    const legal = applyTransition(uploaded, "in_review", "reconcile", now);
    expect(legal.applied).toBe(true);

    const illegal = applyTransition(uploaded, "rolled_back", "reconcile", now);
    expect(illegal.applied).toBe(false);
    expect(illegal).toMatchObject({ reason: "illegal" });

    const dup = applyTransition(uploaded, "uploaded", "reconcile", now);
    expect(dup.applied).toBe(false);
    expect(dup).toMatchObject({ reason: "duplicate" });
  });
});
