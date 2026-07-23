// tests/flags-naming-refine.test.ts
import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "../src/halyard/config/app-config.schema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const auroraRaw = parseYaml(readFileSync(resolve(here, "..", "apps", "aurora", "app.yml"), "utf8"));

describe("flags.naming reserved namespace", () => {
  it("rejects a naming pattern using the reserved 'halyard.' prefix", () => {
    const bad = { ...auroraRaw, flags: { ...auroraRaw.flags, naming: "halyard.{slug}.{feature}" } };
    expect(() => AppConfigSchema.parse(bad)).toThrow(/reserved 'halyard\.' namespace/);
  });

  it("still accepts the existing aurora fixture (launch.* naming)", () => {
    expect(() => AppConfigSchema.parse(auroraRaw)).not.toThrow();
  });
});
