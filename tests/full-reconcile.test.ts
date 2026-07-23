// tests/full-reconcile.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runFullReconcile } from "../src/halyard/orchestration/full-reconcile.js";
import { loadOrgConfig, loadAppConfig } from "../src/halyard/config/loader.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { newRelease, appendTransition } from "../src/halyard/coordinator/record-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = loadOrgConfig(resolve(here, "..", "halyard.config.yml"));
const aurora = loadAppConfig(resolve(here, "..", "apps", "aurora", "app.yml"));

let stateDir: string;
const now = () => "2026-06-11T00:00:00.000Z";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-fullrec-")); });
afterEach(() => { rmSync(stateDir, { recursive: true, force: true }); delete process.env.HALYARD_LIVE_PUBLISH; delete process.env.HALYARD_LIVE_FLAGS; });

describe("runFullReconcile", () => {
  it("on an empty project returns a zeroed report and does not throw", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    const r = await runFullReconcile({ org, apps: [aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now });
    expect(r.reconcile.scanned).toBe(0);
    expect(r.graduationProposals).toBe(0);
    expect(r.publicityFanouts).toBe(0);
    expect(r.triageProposals).toBe(0);
    expect(r.rejectionProposals).toBe(0);
  });

  it("projects an uploaded web release with its flag ON to live (offline, FilePublisher)", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    // Seed a standalone web release at `uploaded`, bound to a flag that is ON in the file provider.
    let rel = newRelease({ releaseId: "rel_aurora_web_1.0.0", app: "aurora", surface: "web", version: "1.0.0" });
    rel = { ...rel, flag: "launch.aurora.test" };
    for (const to of ["tagged", "built", "tested", "uploaded"] as const) rel = appendTransition(rel, to, "ci", now);
    await backend.records.write(rel);
    await new FlagFileClient(stateDir, now).setState("launch.aurora.test", true);

    const r = await runFullReconcile({ org, apps: [aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now });

    expect((await backend.records.read("rel_aurora_web_1.0.0"))!.state).toBe("live");
    expect(r.reconcile.applied.some((a) => a.to === "live")).toBe(true);
    // counts are numbers (publicity may be 0 — the release is launch-less, so firePublicity sees no launch)
    expect(typeof r.publicityFanouts).toBe("number");
  });

  it("enforces the multi-app Pro gate (throws for >1 app unlicensed)", async () => {
    const backend = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    await expect(
      runFullReconcile({ org, apps: [aurora, aurora], backend, stateDir, canonDir: join(stateDir, "canon"), now }),
    ).rejects.toThrow(/Pro feature/i);
  });
});
