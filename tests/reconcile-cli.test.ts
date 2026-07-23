// tests/reconcile-cli.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { dispatch } from "../src/halyard/cli.js";

let stateDir: string;
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-reccli-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); vi.restoreAllMocks(); });

describe("reconcile CLI stdout shape", () => {
  it("prints the legacy snake_case report keys", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    const code = await dispatch(["reconcile", "--state-dir", stateDir, "--apps", "aurora"]);
    expect(code).toBe(0); // empty project, no source errors

    const out = JSON.parse(lines.join("\n"));
    expect(out).toMatchObject({
      scanned: 0,
      graduation_proposals: 0,
      publicity_fanouts: 0,
      triage_proposals: 0,
      rejection_proposals: 0,
    });
    expect(Array.isArray(out.applied)).toBe(true);
    expect(Array.isArray(out.errors)).toBe(true);
  });
});
