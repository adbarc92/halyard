import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  appendTransition,
  newRelease,
  readRelease,
  releasePath,
  writeRelease,
} from "../src/halyard/coordinator/record-store.js";

let stateDir: string;
let clock = 0;
const now = () => `2025-06-05T00:00:${String(clock++).padStart(2, "0")}.000Z`;

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-state-"));
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M1 verify: record store round-trips and append is idempotent", () => {
  it("writes and reads back a release record", () => {
    const rel = appendTransition(
      newRelease({ releaseId: "rel_aurora_web_1.0.0", app: "aurora", surface: "web", version: "1.0.0" }),
      "tagged",
      "ci",
      now,
    );
    writeRelease(stateDir, rel);
    const back = readRelease(stateDir, "rel_aurora_web_1.0.0");
    expect(back?.state).toBe("tagged");
    expect(back?.transitions).toHaveLength(1);
    expect(back?.transitions[0]?.dedup_key).toBe("rel_aurora_web_1.0.0:tagged");
  });

  it("appendTransition is idempotent on the dedup key (foreshadows M2)", () => {
    let rel = newRelease({ releaseId: "rel_aurora_web_1.0.0", app: "aurora", surface: "web", version: "1.0.0" });
    rel = appendTransition(rel, "tagged", "ci", now);
    rel = appendTransition(rel, "built", "ci", now);
    const before = structuredClone(rel);
    // Re-applying the CURRENT state is a no-op (a double-fire: re-poll / CI retry).
    // Re-entering a *previously-visited* state is intentionally NOT a no-op (the resubmit
    // / re-flip loops) — covered separately in the resubmit-loop test.
    rel = appendTransition(rel, "built", "ci", now);
    rel = appendTransition(rel, "built", "ci", now);
    expect(rel.transitions).toHaveLength(2);
    expect(rel).toEqual(before);
  });

  it("persisted JSON contains no secret-looking material (spot check)", () => {
    const rel = appendTransition(
      newRelease({ releaseId: "rel_aurora_web_1.0.0", app: "aurora", surface: "web", version: "1.0.0" }),
      "tagged",
      "ci",
      now,
    );
    writeRelease(stateDir, rel);
    const text = readFileSync(releasePath(stateDir, "rel_aurora_web_1.0.0"), "utf8");
    expect(text).not.toMatch(/sk-|BEGIN |api[_-]?key/i);
  });
});
