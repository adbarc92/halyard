import type { CommandResult, CommandRunner } from "../../src/halyard/surfaces/types.js";

export interface FakeStep {
  /** Substring matched against the command to decide this scripted result. */
  match: string;
  exitCode?: number;
  stdout?: string;
  stderr?: string;
}

/**
 * A scripted CommandRunner for adapter tests — no real shell. Records every command it
 * was asked to run (and the env it was given) so tests can assert on invocation.
 */
export class FakeCommandRunner implements CommandRunner {
  readonly calls: Array<{ command: string; cwd: string; env?: Record<string, string> }> = [];

  constructor(private readonly steps: FakeStep[]) {}

  run(
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    return this.record(command, opts);
  }

  runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    // Record the argv joined for matching/assertions; the real runner does NOT shell it.
    return this.record([file, ...args].join(" "), opts);
  }

  private record(
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ command, cwd: opts.cwd, ...(opts.env ? { env: opts.env } : {}) });
    const step = this.steps.find((s) => command.includes(s.match));
    return Promise.resolve({
      command,
      exitCode: step?.exitCode ?? 0,
      stdout: step?.stdout ?? "",
      stderr: step?.stderr ?? "",
    });
  }
}
