import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runCertWatch } from "../src/halyard/maintenance/cert-watch.js";
import { runDeadlineWatch } from "../src/halyard/maintenance/deadlines.js";
import { runRenovate } from "../src/halyard/maintenance/renovate.js";
import { proposeOnce, readProposal } from "../src/halyard/coordinator/proposals.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";
import type {
  CertExpiryProvider, DependencyUpdate, DependencyUpdateProvider, MergeClient, PlatformDeadlineProvider,
} from "../src/halyard/maintenance/types.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

class NullNotifier implements Notifier {
  async notify(_p: Proposal): Promise<void> {}
}

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
const now = () => "2026-06-06T00:00:00.000Z";
beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-mr-"));
  backend = makeGitBackend({ stateDir });
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

const base = { apps: [app], notifier: new NullNotifier(), now };

describe("§E: maintenance watchers surface provider failures (fail-loud)", () => {
  it("cert: a throwing provider is isolated and reported", async () => {
    const provider: CertExpiryProvider = { async getCertStatus() { throw new Error("cert API 500"); } };
    const { created, errors } = await runCertWatch({ ...base, backend, provider });
    expect(created).toHaveLength(0);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toContain("cert API 500");
  });

  it("deadline: a throwing provider is reported", async () => {
    const provider: PlatformDeadlineProvider = { async getDeadlines() { throw new Error("calendar down"); } };
    const { errors } = await runDeadlineWatch({ ...base, backend, provider });
    expect(errors.join("\n")).toContain("calendar down");
  });

  it("deps: a throwing listUpdates is reported", async () => {
    const provider: DependencyUpdateProvider = { async listUpdates() { throw new Error("renovate API down"); } };
    const mergeClient: MergeClient = { async merge() {} };
    const { errors } = await runRenovate({ ...base, backend, provider, mergeClient });
    expect(errors.join("\n")).toContain("renovate API down");
  });
});

describe("§E: renovate merge-failure and auto-resolve branches", () => {
  it("a failed merge is isolated: it's reported, excluded from merged, and others still merge", async () => {
    const updates: DependencyUpdate[] = [
      { id: "zod", name: "zod", updateType: "patch", from: "1", to: "2", pr: 11 },
      { id: "vitest", name: "vitest", updateType: "minor", from: "1", to: "2", pr: 12 },
    ];
    const provider: DependencyUpdateProvider = { async listUpdates() { return updates; } };
    const mergeClient: MergeClient = {
      async merge(_repo, pr) { if (pr === 11) throw new Error("merge conflict"); },
    };
    const result = await runRenovate({ ...base, backend, provider, mergeClient });

    expect(result.merged.map((u) => u.pr)).toEqual([12]); // 11 failed, 12 merged
    expect(result.errors.join("\n")).toContain("merge conflict");
  });

  it("a dependency proposal whose PR vanished upstream is auto-resolved", async () => {
    // An open dep proposal from a prior pass...
    await proposeOnce(backend.proposals, {
      proposal_id: "prop_dep_aurora_oldpkg", kind: "dependency_update", app: "aurora",
      title: "Review major update: oldpkg", body: "...", status: "open", created_at: now(),
    });
    // ...is no longer in the current update list → resolved.
    const provider: DependencyUpdateProvider = {
      async listUpdates() { return [{ id: "newpkg", name: "newpkg", updateType: "major", from: "1", to: "2", pr: 99 }]; },
    };
    await runRenovate({ ...base, backend, provider, mergeClient: { async merge() {} } });

    expect(readProposal(stateDir, "prop_dep_aurora_oldpkg")!.status).toBe("resolved");
  });
});
