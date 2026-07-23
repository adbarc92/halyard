import type { AppConfig } from "../config/app-config.schema.js";
import type { Surface } from "../config/primitives.js";

/**
 * The surface-agnostic adapter contract (working style: surfaces implement a common
 * interface so the coordinator is surface-agnostic; differences live in config).
 * Web is implemented at M1; ios/android arrive at M3 behind this same interface.
 *
 * All shell/external interaction goes through a `CommandRunner` so the adapter logic
 * stays pure and testable, and so the auditable surface (what command ran, with what
 * exit code) is uniform across surfaces.
 */

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface CommandRunner {
  /** Run an operator-configured command string through a shell (build/test commands use
   *  shell features like `&&`). Only ever pass operator-trusted config here. */
  run(command: string, opts: { cwd: string; env?: Record<string, string> }): Promise<CommandResult>;
  /** Run a program with an explicit argv and NO shell — use this whenever any argument is
   *  a runtime value (commit ref, project name) so it can't be interpreted as shell. */
  runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult>;
}

/** Everything an adapter needs for one release run. The adapter reads its own surface block. */
export interface ReleaseContext {
  app: AppConfig;
  surface: Surface;
  releaseId: string;
  version: string;
  commit: string;
  workdir: string;
  runner: CommandRunner;
  log: (message: string) => void;
}

export interface BuildResult {
  ok: boolean;
  outputDir: string;
  command: CommandResult;
}

export interface TestResult {
  /** The deterministic gate keys off this exit code and nothing else. */
  exitCode: number;
  command: CommandResult;
}

export interface DeployResult {
  ok: boolean;
  previewUrl: string;
  details: Record<string, unknown>;
  /** Surface-specific projection fields to record (e.g. iOS asc_build_id). */
  externalRefs?: Record<string, unknown>;
}

export interface SurfaceAdapter {
  readonly surface: Surface;
  build(ctx: ReleaseContext): Promise<BuildResult>;
  test(ctx: ReleaseContext): Promise<TestResult>;
  deploy(ctx: ReleaseContext, build: BuildResult): Promise<DeployResult>;
}
