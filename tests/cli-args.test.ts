import { describe, expect, it } from "vitest";
import { parseFlags, requireFlag } from "../src/halyard/cli-args.js";

describe("§E: CLI flag parsing", () => {
  it("parses --key value pairs", () => {
    expect(parseFlags(["--app", "aurora", "--surface", "web"])).toEqual({ app: "aurora", surface: "web" });
  });

  it("treats a bare trailing flag as a boolean", () => {
    expect(parseFlags(["--dry-run"])).toEqual({ "dry-run": "true" });
  });

  it("treats a flag whose 'value' is itself a flag as a boolean", () => {
    expect(parseFlags(["--verbose", "--app", "aurora"])).toEqual({ verbose: "true", app: "aurora" });
  });

  it("ignores non-flag leading tokens (e.g. subcommands handled by the dispatcher)", () => {
    expect(parseFlags(["run", "--app", "aurora"])).toEqual({ app: "aurora" });
  });

  it("requireFlag returns a present value and throws on a missing one", () => {
    expect(requireFlag({ app: "aurora" }, "app")).toBe("aurora");
    expect(() => requireFlag({}, "app")).toThrow(/--app/);
  });
});
