import { describe, expect, it } from "vitest";
import { buildGate, testGate } from "../src/halyard/coordinator/gates.js";
import type { CommandResult, TestResult } from "../src/halyard/surfaces/types.js";

function testResult(exitCode: number): TestResult {
  const command: CommandResult = { command: "npm test", exitCode, stdout: "", stderr: "" };
  return { exitCode, command };
}

describe("M1 verify: gates are deterministic booleans (invariant #2)", () => {
  it("testGate passes to `tested` on exit 0", () => {
    expect(testGate(testResult(0))).toEqual({ pass: true, to: "tested" });
  });

  it("testGate fails to `dead` on any non-zero exit", () => {
    for (const code of [1, 2, 137]) {
      const d = testGate(testResult(code));
      expect(d.pass).toBe(false);
      expect(d.to).toBe("dead");
      expect(d.reason).toContain(String(code));
    }
  });

  it("buildGate maps ok→built, fail→dead", () => {
    expect(buildGate(true)).toEqual({ pass: true, to: "built" });
    expect(buildGate(false).to).toBe("dead");
  });
});
