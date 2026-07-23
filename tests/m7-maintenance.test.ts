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
import { listProposals } from "../src/halyard/coordinator/proposals.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import type {
  CertExpiryProvider, CertKind, CertStatus,
  DependencyUpdate, DependencyUpdateProvider, MergeClient,
  PlatformDeadline, PlatformDeadlineProvider,
} from "../src/halyard/maintenance/types.js";
import type { Notifier } from "../src/halyard/publicity/notify.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
const now = () => "2026-06-05T00:00:00.000Z";

class RecordingNotifier implements Notifier {
  readonly sent: Proposal[] = [];
  async notify(p: Proposal): Promise<void> { this.sent.push(p); }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m7-"));
  backend = makeGitBackend({ stateDir });
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M7: cert-expiry alerting (alert only — never renews)", () => {
  const certs: Record<CertKind, string> = {
    apple_distribution: "2026-06-10T00:00:00.000Z", // 5 days → critical
    apple_push_key: "2026-12-01T00:00:00.000Z", // far off
    authenticode: "2026-12-01T00:00:00.000Z",
  };
  const provider: CertExpiryProvider = {
    async getCertStatus(_app, kind): Promise<CertStatus> {
      return { kind, notAfter: certs[kind] };
    },
  };

  it("alerts on a cert inside the window, ignores far-off ones", async () => {
    const notifier = new RecordingNotifier();
    const { created, errors } = await runCertWatch({ backend, apps: [app], provider, notifier, now });
    expect(errors).toHaveLength(0);
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "cert_expiry", severity: "critical" });
    expect(created[0]!.body).toMatch(/never renews|manually/i); // alert, not an action
    expect(notifier.sent).toHaveLength(1);
  });

  it("is idempotent", async () => {
    const notifier = new RecordingNotifier();
    await runCertWatch({ backend, apps: [app], provider, notifier, now });
    const second = await runCertWatch({ backend, apps: [app], provider, notifier, now });
    expect(second.created).toHaveLength(0);
  });
});

describe("M7: platform-deadline alerting", () => {
  const provider: PlatformDeadlineProvider = {
    async getDeadlines(): Promise<PlatformDeadline[]> {
      return [
        { id: "ios18_sdk", title: "iOS 18 SDK build requirement", date: "2026-06-25T00:00:00.000Z" }, // 20d
        { id: "far", title: "Some 2027 cutoff", date: "2027-01-01T00:00:00.000Z" }, // far
      ];
    },
  };

  it("alerts only on deadlines inside the window", async () => {
    const notifier = new RecordingNotifier();
    const { created } = await runDeadlineWatch({ backend, apps: [app], provider, notifier, now });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatchObject({ kind: "platform_deadline", severity: "high" });
  });
});

describe("M7: Renovate — config gate auto-merges patch/minor, proposes the rest", () => {
  const updates: DependencyUpdate[] = [
    { id: "zod", name: "zod", updateType: "patch", from: "3.23.7", to: "3.23.8", pr: 11 },
    { id: "vitest", name: "vitest", updateType: "minor", from: "2.1.0", to: "2.2.0", pr: 12 },
    { id: "typescript", name: "typescript", updateType: "major", from: "5.6.0", to: "6.0.0", pr: 13 },
  ];
  const provider: DependencyUpdateProvider = { async listUpdates() { return updates; } };

  it("auto-merges patch+minor (authorized action), proposes major for review", async () => {
    const merges: number[] = [];
    const mergeClient: MergeClient = { async merge(_app, pr) { merges.push(pr); } };
    const notifier = new RecordingNotifier();

    const result = await runRenovate({ backend, apps: [app], provider, mergeClient, notifier, now });

    // aurora automerge = [patch, minor]
    expect(merges.sort()).toEqual([11, 12]); // patch + minor merged
    expect(result.merged.map((u) => u.name).sort()).toEqual(["vitest", "zod"]);

    // major is NOT merged — it's a proposal for a human.
    expect(merges).not.toContain(13);
    expect(result.proposed).toHaveLength(1);
    expect(result.proposed[0]).toMatchObject({ kind: "dependency_update", title: expect.stringContaining("typescript") });
    expect(notifier.sent).toHaveLength(1); // only the proposed one is surfaced
  });
});

describe("M7 verify: all three sources land on the same bus + approval surface", () => {
  it("cert + deadline + dependency proposals share the proposals queue", async () => {
    const notifier = new RecordingNotifier();
    await runCertWatch({
      backend, apps: [app], now, notifier,
      provider: { async getCertStatus(_a, kind) { return { kind, notAfter: "2026-06-09T00:00:00.000Z" }; } },
    });
    await runDeadlineWatch({
      backend, apps: [app], now, notifier,
      provider: { async getDeadlines() { return [{ id: "d1", title: "Cutoff", date: "2026-06-20T00:00:00.000Z" }]; } },
    });
    await runRenovate({
      backend, apps: [app], now, notifier,
      provider: { async listUpdates() { return [{ id: "x", name: "x", updateType: "major", from: "1", to: "2", pr: 9 }]; } },
      mergeClient: { async merge() {} },
    });

    // All three maintenance kinds present on the one shared queue, all notified.
    const present = new Set(listProposals(stateDir).map((p) => p.kind));
    expect(present.has("cert_expiry")).toBe(true);
    expect(present.has("platform_deadline")).toBe(true);
    expect(present.has("dependency_update")).toBe(true);
    expect(notifier.sent.length).toBe(listProposals(stateDir).length);
  });
});
