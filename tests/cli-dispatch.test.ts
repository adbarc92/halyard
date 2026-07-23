import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/halyard/cli.js";

// The commands print JSON to stdout / logs to stderr; silence them for clean test output.
let logSpy: ReturnType<typeof vi.spyOn>;
let errSpy: ReturnType<typeof vi.spyOn>;
let stateDir: string;

beforeEach(() => {
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errSpy = vi.spyOn(console, "error").mockImplementation(() => {});
  stateDir = mkdtempSync(join(tmpdir(), "halyard-cli-"));
});
afterEach(() => {
  logSpy.mockRestore();
  errSpy.mockRestore();
  rmSync(stateDir, { recursive: true, force: true });
});

describe("CLI dispatch (exit-code contract)", () => {
  it("an unknown command prints usage and returns 2", async () => {
    expect(await dispatch(["wat"])).toBe(2);
    expect(await dispatch([])).toBe(2);
  });

  it("status and queue succeed (exit 0) against an empty state dir", async () => {
    expect(await dispatch(["status", "--state-dir", stateDir])).toBe(0);
    expect(await dispatch(["queue", "--state-dir", stateDir])).toBe(0);
  });

  it("reconcile over an empty state dir is a clean no-op (exit 0)", async () => {
    // Scoped to a single app: acting over the whole onboarded portfolio (>1 app) is gated
    // behind the Pro/self-host entitlement, which this exit-code contract test doesn't assert.
    expect(await dispatch(["reconcile", "--apps", "aurora", "--state-dir", stateDir])).toBe(0);
  });

  it("flip rejects a --state other than on|off", async () => {
    await expect(
      dispatch(["flip", "--flag", "launch.aurora.x", "--state", "maybe", "--state-dir", stateDir]),
    ).rejects.toThrow(/--state must be/);
  });

  it("release run fails loudly when a required flag is missing", async () => {
    await expect(dispatch(["release", "run", "--app", "aurora", "--version", "1.0.0"])).rejects.toThrow(/surface/);
  });

  it("release run rejects an unsupported --surface", async () => {
    await expect(
      dispatch(["release", "run", "--app", "aurora", "--surface", "smartfridge", "--version", "1.0.0"]),
    ).rejects.toThrow(/surface/);
  });
});
