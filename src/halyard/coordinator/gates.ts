import type { ReleaseState } from "../contracts/state.js";
import type { TestResult } from "../surfaces/types.js";

/**
 * Deterministic gates (invariant #2: gates are dumb booleans; no model ever decides
 * ship/no-ship). This module is intentionally pure and dependency-free so it stays
 * trivially auditable — read it top to bottom and you know exactly what passes.
 */

export interface GateDecision {
  pass: boolean;
  /** The state to transition to as a result of this gate. */
  to: ReleaseState;
  reason?: string;
}

/** The test gate: a build passes iff its test command exited 0. Nothing else. */
export function testGate(test: TestResult): GateDecision {
  if (test.exitCode === 0) {
    return { pass: true, to: "tested" };
  }
  return {
    pass: false,
    to: "dead",
    reason: `tests failed (exit code ${test.exitCode})`,
  };
}

/** The build gate: a non-zero build exit is a dead release; it never reaches tests. */
export function buildGate(buildOk: boolean): GateDecision {
  return buildOk
    ? { pass: true, to: "built" }
    : { pass: false, to: "dead", reason: "build failed" };
}
