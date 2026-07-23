import { describe, expect, it } from "vitest";
import {
  TemplateNarrativeDrafter,
  collectRecentCommits,
} from "../src/halyard/agents/narrative/narrative-drafter.js";
import { FakeCommandRunner } from "./helpers/fake-runner.js";

describe("narrative-seed agent: deterministic drafter", () => {
  const drafter = new TemplateNarrativeDrafter();
  const ctx = { app: "aurora", feature: "offline_sync", title: "Offline sync" };

  it("drafts a seed from the feature highlights (strips conventional types)", async () => {
    const seed = await drafter.draft({
      ...ctx,
      changes: ["feat: full offline read/write", "feat(sync): reconnect merge", "fix: token refresh race", "chore: bump deps"],
    });
    // Only feat changes are used (the "why it matters" highlights), types stripped.
    expect(seed).toBe("Offline sync: full offline read/write; reconnect merge.");
  });

  it("prefers feat: changes but falls back to whatever changes exist", async () => {
    const seed = await drafter.draft({ ...ctx, changes: ["fix: a", "fix: b"] });
    expect(seed).toBe("Offline sync: a; b.");
  });

  it("produces a sane seed with no changes", async () => {
    expect(await drafter.draft({ ...ctx, changes: [] })).toBe("Offline sync ships for aurora.");
  });
});

describe("narrative-seed agent: collectRecentCommits", () => {
  it("returns conventional commit subjects, filtering the rest", async () => {
    const runner = new FakeCommandRunner([
      { match: "git log", stdout: "feat: offline sync\nfix: race\nWIP scratch\nMerge pull request #1\nchore: deps\n" },
    ]);
    expect(await collectRecentCommits(runner, "/tmp/aurora")).toEqual(["feat: offline sync", "fix: race", "chore: deps"]);
  });

  it("returns [] when git is unavailable", async () => {
    const runner = new FakeCommandRunner([{ match: "git log", exitCode: 128, stderr: "not a git repo" }]);
    expect(await collectRecentCommits(runner, "/tmp/aurora")).toEqual([]);
  });
});
