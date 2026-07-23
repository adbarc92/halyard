import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { describe, expect, it } from "vitest";
import { validateOrgConfig } from "../src/halyard/config/loader.js";
import { channelAction } from "../src/halyard/publicity/channels.js";

const here = dirname(fileURLToPath(import.meta.url));
const org = validateOrgConfig(parseYaml(readFileSync(resolve(here, "..", "halyard.config.yml"), "utf8")));

describe("M5: channel gate enforces the owned/third-party boundary (invariant #5)", () => {
  it("owned + auto + http auto-publishes", () => {
    expect(channelAction(org.channels.blog!, "standard")).toEqual({ kind: "auto_publish" });
    expect(channelAction(org.channels.waitlist_email!, "standard")).toEqual({ kind: "auto_publish" });
  });

  it("third-party always stages — never auto-publishes", () => {
    expect(channelAction(org.channels.x!, "standard")).toEqual({ kind: "stage" });
    expect(channelAction(org.channels.linkedin!, "standard")).toEqual({ kind: "stage" });
  });

  it("requires_tier gates a channel to launch-tier launches", () => {
    // hn requires_tier: launch
    expect(channelAction(org.channels.hn!, "standard").kind).toBe("skip");
    expect(channelAction(org.channels.hn!, "launch").kind).toBe("stage"); // still human, never auto
  });

  it("there is no input that makes a third-party channel auto-publish", () => {
    for (const name of ["x", "linkedin", "hn"] as const) {
      for (const tier of ["standard", "launch"] as const) {
        expect(channelAction(org.channels[name]!, tier).kind).not.toBe("auto_publish");
      }
    }
  });
});
