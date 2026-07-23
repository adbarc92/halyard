import { describe, expect, it } from "vitest";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import { commandProvider } from "../src/halyard/surfaces/deploy/command.js";
import type {
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";
import type { Surface } from "../src/halyard/config/primitives.js";

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv/command — no real deploy runs on the test machine. */
interface RunCall {
  via: "run" | "runArgv";
  command?: string;
  file?: string;
  args?: string[];
  cwd: string;
}

class FakeCommandRunner implements CommandRunner {
  readonly calls: RunCall[] = [];
  constructor(private readonly results: Record<string, Partial<CommandResult>> = {}) {}

  async run(
    command: string,
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "run", command, cwd: opts.cwd });
    return this.result(command);
  }

  async runArgv(
    file: string,
    args: string[],
    opts: { cwd: string; env?: Record<string, string> },
  ): Promise<CommandResult> {
    this.calls.push({ via: "runArgv", file, args, cwd: opts.cwd });
    return this.result([file, ...args].join(" "));
  }

  private result(label: string): CommandResult {
    const override = this.results[label] ?? {};
    return {
      command: label,
      exitCode: override.exitCode ?? 0,
      stdout: override.stdout ?? "",
      stderr: override.stderr ?? "",
    };
  }
}

function ctxFor(
  runner: CommandRunner,
  surface: Surface,
  workdir: string,
): ReleaseContext {
  return {
    app: {} as AppConfig,
    surface,
    releaseId: "rel_x_web_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir,
    runner,
    log: () => {},
  };
}

const buildResult = (): { ok: boolean; outputDir: string; command: CommandResult } => ({
  ok: true,
  outputDir: "/tmp/work/dist",
  command: {} as CommandResult,
});

describe("command deploy provider: runs the configured command via run (SHELL)", () => {
  it("invokes the operator command through `run` and returns ok on exit 0", async () => {
    const runner = new FakeCommandRunner();
    const cfg = { target: "command", command: "deploy.sh --prod", url: "https://x.dev" };
    const result = await commandProvider.deploy(ctxFor(runner, "web", "/tmp/work"), buildResult(), cfg);

    const call = runner.calls.find((c) => c.via === "run");
    expect(call).toBeDefined();
    expect(call!.via).toBe("run"); // shell IS correct here (operator-trusted config string)
    expect(call!.command).toBe("deploy.sh --prod");
    expect(call!.cwd).toBe("/tmp/work");

    // No runtime value ever went through the shell as an argv program — only the config string.
    expect(runner.calls.every((c) => c.via === "run")).toBe(true);

    expect(result.ok).toBe(true);
    expect(result.previewUrl).toBe("https://x.dev");
    expect(result.details).toMatchObject({ target: "command", exitCode: 0 });
  });

  it("a non-zero exit code yields ok:false (the gate decides, not the provider)", async () => {
    const runner = new FakeCommandRunner({ "deploy.sh --prod": { exitCode: 2 } });
    const cfg = { target: "command", command: "deploy.sh --prod", url: "https://x.dev" };
    const result = await commandProvider.deploy(ctxFor(runner, "web", "/tmp/work"), buildResult(), cfg);
    expect(result.ok).toBe(false);
    expect(result.details).toMatchObject({ exitCode: 2 });
  });

  it("no url → previewUrl is the empty string", async () => {
    const runner = new FakeCommandRunner();
    const cfg = { target: "command", command: "make deploy" };
    const result = await commandProvider.deploy(ctxFor(runner, "desktop", "/tmp/work"), buildResult(), cfg);
    expect(result.ok).toBe(true);
    expect(result.previewUrl).toBe("");
  });
});

describe("command deploy provider: config validation (surface-agnostic, strict)", () => {
  it("is valid on any surface (web and desktop) and does not throw", () => {
    const cfg = { target: "command", command: "deploy.sh", url: "https://x.dev" };
    expect(() => validateDeployConfig("web", cfg)).not.toThrow();
    expect(() => validateDeployConfig("desktop", cfg)).not.toThrow();
  });

  it("url is optional — a command without a url validates", () => {
    expect(() =>
      validateDeployConfig("web", { target: "command", command: "make deploy" }),
    ).not.toThrow();
  });

  it("a missing command field throws", () => {
    expect(() => validateDeployConfig("web", { target: "command" })).toThrow();
  });

  it("an unknown field is rejected by the strict schema", () => {
    expect(() =>
      validateDeployConfig("web", { target: "command", command: "deploy.sh", extra: 1 }),
    ).toThrow();
  });
});
