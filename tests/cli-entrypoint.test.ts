import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isEntrypoint } from "../src/halyard/cli.js";

// GAP-S12: reached through `npm link`, argv[1] is the link path while import.meta.url is the
// real path, so a plain path comparison skipped dispatch and the CLI exited 0 with no output.

const SRC = resolve("src/halyard");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "halyard-entry-"));
});
afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

describe("isEntrypoint", () => {
  it("is false when there is no argv[1]", () => {
    expect(isEntrypoint(undefined, pathToFileURL(join(SRC, "cli.ts")).href)).toBe(false);
  });

  it("is false for a different script", () => {
    expect(isEntrypoint(join(SRC, "index.ts"), pathToFileURL(join(SRC, "cli.ts")).href)).toBe(false);
  });

  it("is true when argv[1] reaches the module through a linked directory", () => {
    const link = join(tmp, "linked");
    symlinkSync(SRC, link, "junction");
    expect(isEntrypoint(join(link, "cli.ts"), pathToFileURL(join(SRC, "cli.ts")).href)).toBe(true);
  });
});

describe("CLI run through a linked directory (the npm link shape)", () => {
  it("dispatches and prints output instead of exiting silently", () => {
    const link = join(tmp, "linked");
    symlinkSync(SRC, link, "junction");
    const stateDir = join(tmp, "state");
    const run = spawnSync(process.execPath, ["--import", "tsx", join(link, "cli.ts"), "status", "--state-dir", stateDir], {
      encoding: "utf8",
    });
    expect(run.status).toBe(0);
    // An empty string would also "parse" in some callers; assert real output first.
    expect(run.stdout.trim()).not.toBe("");
  });
});
