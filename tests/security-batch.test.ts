import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import {
  DryRunMergeClient,
  EnvDeadlineProvider,
  EnvDependencyProvider,
  GitHubMergeClient,
} from "../src/halyard/maintenance/providers.js";
import { runRenovate } from "../src/halyard/maintenance/renovate.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { WebSurfaceAdapter } from "../src/halyard/surfaces/web.js";
import type { ReleaseContext } from "../src/halyard/surfaces/types.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";
import type { MergeClient } from "../src/halyard/maintenance/types.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const appYaml = readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8");
const app = validateAppConfig(parseYaml(appYaml));

class NullNotifier implements Notifier {
  async notify(_p: Proposal): Promise<void> {}
}

describe("§B: env-sourced provider JSON is schema-validated, not blindly cast", () => {
  const KEYS = ["HALYARD_DEP_UPDATES", "HALYARD_DEADLINES"] as const;
  afterEach(() => KEYS.forEach((k) => delete process.env[k]));

  it("rejects malformed dependency-update JSON (missing/!int pr)", async () => {
    process.env.HALYARD_DEP_UPDATES = JSON.stringify([{ id: "x", name: "x", updateType: "patch", from: "1", to: "2", pr: "not-a-number" }]);
    await expect(new EnvDependencyProvider().listUpdates("aurora")).rejects.toThrow();
  });

  it("rejects an unknown updateType", async () => {
    process.env.HALYARD_DEP_UPDATES = JSON.stringify([{ id: "x", name: "x", updateType: "sideways", from: "1", to: "2", pr: 1 }]);
    await expect(new EnvDependencyProvider().listUpdates("aurora")).rejects.toThrow();
  });

  it("accepts a well-formed update list", async () => {
    process.env.HALYARD_DEP_UPDATES = JSON.stringify([{ id: "zod", name: "zod", updateType: "patch", from: "1", to: "2", pr: 11 }]);
    const updates = await new EnvDependencyProvider().listUpdates("aurora");
    expect(updates[0]).toMatchObject({ name: "zod", pr: 11 });
  });

  it("rejects malformed deadline JSON", async () => {
    process.env.HALYARD_DEADLINES = JSON.stringify([{ id: "d", title: "" }]); // missing date, empty title
    await expect(new EnvDeadlineProvider().getDeadlines("aurora")).rejects.toThrow();
  });
});

describe("§B: the merge client targets an explicit, validated repo (no hardcoded default)", () => {
  it("GitHubMergeClient refuses a malformed repo before any network/token use", async () => {
    await expect(new GitHubMergeClient().merge("not a repo", 1)).rejects.toThrow(/malformed repo/);
  });

  it("DryRunMergeClient records the merge per repo+pr, idempotently", async () => {
    const dir = mkdtempSync(join(tmpdir(), "halyard-merge-"));
    try {
      const client = new DryRunMergeClient(dir, () => "2026-06-06T00:00:00.000Z");
      await client.merge("example/aurora", 11);
      await client.merge("example/aurora", 11); // idempotent
      const path = join(dir, "maintenance", "merged", "example_aurora_11.json");
      expect(existsSync(path)).toBe(true);
      expect(JSON.parse(readFileSync(path, "utf8")).repo).toBe("example/aurora");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("renovate auto-merges into the app's configured repo", async () => {
    const dir = mkdtempSync(join(tmpdir(), "halyard-renovate-"));
    try {
      const calls: Array<[string, number]> = [];
      const mergeClient: MergeClient = { async merge(repo, pr) { calls.push([repo, pr]); } };
      const provider = { async listUpdates() { return [{ id: "zod", name: "zod", updateType: "patch" as const, from: "1", to: "2", pr: 11 }]; } };
      await runRenovate({ backend: makeGitBackend({ stateDir: dir }), apps: [app], provider, mergeClient, notifier: new NullNotifier(), now: () => "t" });
      expect(calls).toEqual([["example/aurora", 11]]); // aurora's configured repo
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("without a configured repo, an eligible update is PROPOSED, never merged", async () => {
    const noRepo = validateAppConfig({
      ...parseYaml(appYaml),
      maintenance: { ...parseYaml(appYaml).maintenance, dependencies: { tool: "renovate", automerge: ["patch", "minor"] } },
    });
    const dir = mkdtempSync(join(tmpdir(), "halyard-norepo-"));
    try {
      const calls: number[] = [];
      const mergeClient: MergeClient = { async merge(_r, pr) { calls.push(pr); } };
      const provider = { async listUpdates() { return [{ id: "zod", name: "zod", updateType: "patch" as const, from: "1", to: "2", pr: 11 }]; } };
      const result = await runRenovate({ backend: makeGitBackend({ stateDir: dir }), apps: [noRepo], provider, mergeClient, notifier: new NullNotifier(), now: () => "2026-06-06T00:00:00.000Z" });
      expect(calls).toHaveLength(0); // nothing merged without a repo
      expect(result.proposed).toHaveLength(1); // proposed for human review instead
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("§B: automerge config cannot authorize a major bump", () => {
  it("rejects automerge: [major] at config validation", () => {
    const raw = parseYaml(appYaml);
    raw.maintenance.dependencies.automerge = ["patch", "major"];
    expect(() => validateAppConfig(raw)).toThrow(/automerge/);
  });
});

describe("§B: web Cloudflare deploy runs via argv (no shell), and parses the preview URL", () => {
  it("deploys with discrete args and extracts the pages.dev URL", async () => {
    const runner = new FakeCommandRunner([
      { match: "wrangler pages deploy", exitCode: 0, stdout: "Published! https://abc123.aurora-web.pages.dev\n" },
    ]);
    const ctx: ReleaseContext = {
      app, surface: "web", releaseId: "rel_aurora_web_2025.06.06", version: "2025.06.06",
      // A commit ref containing shell metacharacters must be harmless because it's an argv element.
      commit: "abc123;rm -rf /", workdir: "/tmp/aurora", runner, log: () => {},
    };
    const result = await new WebSurfaceAdapter().deploy(ctx, {
      ok: true, outputDir: "/tmp/aurora/dist", command: { command: "", exitCode: 0, stdout: "", stderr: "" },
    });
    expect(result.ok).toBe(true);
    expect(result.previewUrl).toBe("https://abc123.aurora-web.pages.dev");
    // The dangerous commit value was passed as a literal argv element, not shell-spliced.
    const call = runner.calls.at(-1)!;
    expect(call.command).toContain("--branch abc123;rm -rf /");
  });
});
