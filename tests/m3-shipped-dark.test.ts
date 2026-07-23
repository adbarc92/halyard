import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { validateAppConfig } from "../src/halyard/config/loader.js";
import { runRelease } from "../src/halyard/coordinator/release-runner.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { readRelease } from "../src/halyard/coordinator/record-store.js";
import {
  ascReviewSource,
  type AscClient,
  type ReviewStatus,
} from "../src/halyard/coordinator/sources/asc-review.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

const here = dirname(fileURLToPath(import.meta.url));
const app = validateAppConfig(parseYaml(readFileSync(resolve(here, "..", "apps/aurora/app.yml"), "utf8")));

let stateDir: string;
let backend: ReturnType<typeof makeGitBackend>;
let clock = 0;
const now = () => `2025-06-05T04:00:${String(clock++).padStart(2, "0")}.000Z`;

/** ASC truth that advances one step per poll: the review's natural lifecycle. */
class ScriptedAscClient implements AscClient {
  private i = 0;
  constructor(private readonly sequence: ReviewStatus[]) {}
  async getReviewStatus(): Promise<ReviewStatus> {
    const status = this.sequence[Math.min(this.i, this.sequence.length - 1)]!;
    this.i++;
    return status;
  }
}

beforeEach(() => {
  stateDir = mkdtempSync(join(tmpdir(), "halyard-m3-"));
  backend = makeGitBackend({ stateDir });
  clock = 0;
});
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

describe("M3 verify: a tag reaches shipped_dark hands-off and waits", () => {
  it("CI uploads, then the review poll drives it to shipped_dark with no human action", async () => {
    // 1. The release workflow (CI) builds + tests + uploads to TestFlight → `uploaded`.
    const runner = new FakeCommandRunner([
      { match: "fastlane ios build", exitCode: 0 },
      { match: "fastlane ios test", exitCode: 0 },
      { match: "fastlane ios upload", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=4242\n" },
    ]);
    const afterCi = await runRelease({
      app,
      surface: "ios",
      version: "1.4.0",
      commit: "abc1234",
      backend,
      workdir: "/tmp/aurora",
      runner,
      now,
    });
    expect(afterCi.state).toBe("uploaded");
    expect(afterCi.external_refs.asc_build_id).toBe("4242");

    // 2. The scheduled reconcile loop polls ASC. Review walks its lifecycle.
    const client = new ScriptedAscClient([
      "processing", // pass 1: still processing → stays uploaded
      "waiting_for_review", // pass 2: → in_review
      "in_review", // pass 3: still in review → no-op (duplicate)
      "approved", // pass 4: → shipped_dark
    ]);
    const sources = [ascReviewSource(client)];

    let passes = 0;
    let current = afterCi.state;
    while (current !== "shipped_dark" && passes < 10) {
      await reconcile({ backend, sources, now });
      current = readRelease(stateDir, "rel_aurora_ios_1.4.0")!.state;
      passes++;
    }

    const record = readRelease(stateDir, "rel_aurora_ios_1.4.0")!;

    // Reached shipped_dark hands-off.
    expect(record.state).toBe("shipped_dark");
    expect(record.transitions.map((t) => t.to)).toEqual([
      "tagged",
      "built",
      "tested",
      "uploaded",
      "in_review",
      "shipped_dark",
    ]);

    // "Hands-off": every transition was made by CI or the poll — no human actor.
    const actors = new Set(record.transitions.map((t) => t.by));
    expect([...actors].sort()).toEqual(["asc-review-poll", "ci"]);

    // It did NOT advance to live — it waits for the human flag-flip (M4).
    expect(record.state).not.toBe("live");
  });

  it("once at shipped_dark, further reconcile passes are no-ops (it parks)", async () => {
    const runner = new FakeCommandRunner([
      { match: "fastlane ios", exitCode: 0, stdout: "HALYARD_ASC_BUILD_ID=7\n" },
    ]);
    await runRelease({
      app,
      surface: "ios",
      version: "1.5.0",
      commit: "c0ffee0",
      backend,
      workdir: "/tmp/aurora",
      runner,
      now,
    });
    const client = new ScriptedAscClient(["approved"]);
    const sources = [ascReviewSource(client)];

    // Drive to shipped_dark.
    await reconcile({ backend, sources, now }); // uploaded → shipped_dark
    const parked = readRelease(stateDir, "rel_aurora_ios_1.5.0")!;
    expect(parked.state).toBe("shipped_dark");

    // Three more passes: nothing changes, nothing is polled (appliesTo is false now).
    for (let i = 0; i < 3; i++) {
      const report = await reconcile({ backend, sources, now });
      expect(report.applied).toHaveLength(0);
    }
    expect(readRelease(stateDir, "rel_aurora_ios_1.5.0")!).toEqual(parked);
  });
});
