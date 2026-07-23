import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { discoverAppSlugs } from "../src/halyard/config/discover.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "halyard-apps-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("discoverAppSlugs: omitting --apps scans every app, not none", () => {
  it("finds directories containing app.yml, sorted, and ignores the rest", () => {
    for (const slug of ["aurora", "borealis"]) {
      mkdirSync(join(dir, slug));
      writeFileSync(join(dir, slug, "app.yml"), "version: 1\n");
    }
    mkdirSync(join(dir, "scratch")); // a dir without app.yml is not an app
    writeFileSync(join(dir, "loose.txt"), "x"); // a stray file is not an app
    expect(discoverAppSlugs(dir)).toEqual(["aurora", "borealis"]);
  });

  it("returns [] when the apps directory does not exist", () => {
    expect(discoverAppSlugs(join(dir, "missing"))).toEqual([]);
  });
});
