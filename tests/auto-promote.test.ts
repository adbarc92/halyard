// tests/auto-promote.test.ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoPromoteWebRelease } from "../src/halyard/coordinator/auto-promote.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { newRelease, appendTransition } from "../src/halyard/coordinator/record-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

let stateDir: string;
const now = () => "2026-06-11T00:00:00.000Z";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-autopromote-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

// Minimal app config; HALYARD_LIVE_FLAGS is unset so makeFlagClient resolves the FlagFileClient.
function webApp(promoteGate: boolean): AppConfig {
  return {
    app: { slug: "acme" },
    flags: { provider: "file", api_key_ref: "SECRET:X", naming: "launch.{slug}.{feature}", graduate_after_days: 14 },
    surfaces: { web: { promote_gate: promoteGate } },
  } as unknown as AppConfig;
}

/** A web release that deployed (at `uploaded`), standalone (no launch, no flag). */
function deployedWeb(version = "1.4.0"): Release {
  let r = newRelease({ releaseId: `rel_acme_web_${version}`, app: "acme", surface: "web", version });
  for (const to of ["tagged", "built", "tested", "uploaded"] as const) r = appendTransition(r, to, "ci", now);
  return r;
}

describe("autoPromoteWebRelease", () => {
  it("promote_gate:false + standalone web at uploaded → born-ON flag, release.flag set, projected live", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb();
    await backend.records.write(release);

    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });

    expect(result.flag).toBe("halyard.autopromote.acme.1.4.0");
    expect(result.state).toBe("live");
    // Born ON in the provider, single write.
    expect(await new FlagFileClient(stateDir, now).getState("halyard.autopromote.acme.1.4.0")).toBe("on");
    // Persisted live record carries the flag, launch_id still null.
    const stored = await backend.records.read(release.release_id);
    expect(stored!.state).toBe("live");
    expect(stored!.launch_id).toBeNull();
  });

  it("promote_gate:true → no-op (stays uploaded, no flag)", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb();
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(true), surface: "web", stateDir, backend, now });
    expect(result.flag).toBeNull();
    expect(result.state).toBe("uploaded");
    expect(existsSync(join(stateDir, "flags"))).toBe(false);
  });

  it("non-web surface → no-op", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = { ...deployedWeb(), surface: "ios" as const };
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "ios", stateDir, backend, now });
    expect(result.flag).toBeNull();
  });

  it("failed deploy (stranded at tested, not uploaded) → no-op", async () => {
    const backend = makeGitBackend({ stateDir });
    let r = newRelease({ releaseId: "rel_acme_web_2.0.0", app: "acme", surface: "web", version: "2.0.0" });
    for (const to of ["tagged", "built", "tested"] as const) r = appendTransition(r, to, "ci", now);
    await backend.records.write(r);
    const result = await autoPromoteWebRelease({ release: r, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(result.flag).toBeNull();
    expect(result.state).toBe("tested");
  });

  it("already-bound (flag set) → no-op (idempotent across re-runs)", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = { ...deployedWeb(), flag: "halyard.autopromote.acme.1.4.0" };
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(result.state).toBe("uploaded"); // unchanged; helper short-circuits
  });
});

import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { FlagFileClient as FFC2 } from "../src/halyard/flags/file-client.js";

describe("auto-promote end-to-end (rollback + redeploy)", () => {
  it("rolls back via flip-off and a redeploy does NOT un-rollback", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb("3.0.0");
    await backend.records.write(release);

    // Deploy → live.
    const live = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(live.state).toBe("live");

    // Operator rolls back: flip the flag OFF, then reconcile → rolled_back.
    const client = new FFC2(stateDir, now);
    await client.setState("halyard.autopromote.acme.3.0.0", false);
    await reconcile({ backend, sources: [flagPollSource(client)], now, loadReleaseIds: () => [release.release_id] });
    expect((await backend.records.read(release.release_id))!.state).toBe("rolled_back");

    // Redeploy: re-run the helper for the SAME (now flag-bound) release → no-op (stays rolled_back).
    const after = await backend.records.read(release.release_id);
    const redeploy = await autoPromoteWebRelease({ release: after!, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(redeploy.state).toBe("rolled_back");
  });
});
