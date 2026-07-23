import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { ShellCommandRunner } from "../src/halyard/surfaces/command-runner.js";

const node = process.execPath;
const cwd = tmpdir();
const runner = new ShellCommandRunner();

describe("ShellCommandRunner.runArgv (no shell — the safe path for runtime values)", () => {
  it("passes args literally; shell metacharacters are NOT interpreted", async () => {
    // If runArgv used a shell, "; echo HACKED" would run a second command. With shell:false
    // it is a single literal argument echoed back verbatim.
    const payload = "; echo HACKED && rm -rf /";
    const res = await runner.runArgv(node, ["-e", "process.stdout.write(process.argv[1]||'')", payload], { cwd });
    expect(res.exitCode).toBe(0);
    expect(res.stdout).toBe(payload); // exactly the literal arg, nothing executed
    expect(res.stdout).not.toContain("HACKED\n");
  });

  it("returns the child's non-zero exit code", async () => {
    const res = await runner.runArgv(node, ["-e", "process.exit(3)"], { cwd });
    expect(res.exitCode).toBe(3);
  });

  it("resolves exitCode 1 with the error captured when the binary can't be spawned", async () => {
    const res = await runner.runArgv("halyard-definitely-not-a-real-binary-xyz", [], { cwd });
    expect(res.exitCode).toBe(1);
    expect(res.stderr.length).toBeGreaterThan(0);
  });
});
