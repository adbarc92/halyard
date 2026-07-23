import { spawn, type SpawnOptions } from "node:child_process";
import type { CommandResult, CommandRunner } from "./types.js";

/**
 * The real runner: the only place in the surface layer that touches a subprocess, so the
 * adapters above it stay deterministic and unit-testable with a fake runner.
 *
 * `run` uses a shell (configured build/test commands need `&&` etc.) and must only be
 * given operator-trusted config. `runArgv` uses NO shell and is for any command that
 * interpolates a runtime value (a commit ref, a project name) so those can never be
 * interpreted as shell metacharacters.
 */
export class ShellCommandRunner implements CommandRunner {
  run(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<CommandResult> {
    return this.spawnCapture(command, command, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: true });
  }

  runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    const label = [file, ...args].join(" ");
    return this.spawnCapture(file, label, { cwd: opts.cwd, env: { ...process.env, ...opts.env }, shell: false }, args);
  }

  private spawnCapture(
    cmd: string,
    label: string,
    opts: SpawnOptions,
    args: string[] = [],
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      const child = spawn(cmd, args, opts);
      let stdout = "";
      let stderr = "";
      child.stdout?.on("data", (d) => (stdout += d.toString()));
      child.stderr?.on("data", (d) => (stderr += d.toString()));
      child.on("error", (err) => {
        resolve({ command: label, exitCode: 1, stdout, stderr: stderr + String(err) });
      });
      child.on("close", (code) => {
        resolve({ command: label, exitCode: code ?? 1, stdout, stderr });
      });
    });
  }
}
