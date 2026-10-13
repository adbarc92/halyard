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

  it("with no --apps, discovers the registered apps in the tree and lists them", async () => {
    const lines: string[] = [];
    vi.spyOn(console, "log").mockImplementation((m?: unknown) => { lines.push(String(m)); });
    vi.spyOn(console, "error").mockImplementation(() => {});

    // No --apps: the sweep is whatever apps/<slug>/app.yml the checkout ships — today the one
    // example app. `scanned` stays 0 (no release records), so `apps` is what proves discovery.
    const code = await dispatch(["reconcile", "--state-dir", stateDir]);
    expect(code).toBe(0);

    const out = JSON.parse(lines.join("\n"));
    expect(out.apps).toEqual(["aurora"]);
    expect(out.scanned).toBe(0);
  });
});
