import { describe, expect, it } from "vitest";
import { flyProvider } from "../src/halyard/surfaces/deploy/fly.js";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import type {
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

/** Records each call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * ran and with exactly which argv — no real `flyctl` is on the test machine. */
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

  async run(command: string, opts: { cwd: string }): Promise<CommandResult> {
    this.calls.push({ via: "run", command, cwd: opts.cwd });
    return this.result(command);
  }

  async runArgv(file: string, args: string[], opts: { cwd: string }): Promise<CommandResult> {
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

function ctxWith(runner: CommandRunner): ReleaseContext {
  return {
    app: {} as AppConfig,
    surface: "web",
    releaseId: "rel_x",
    version: "1.0.0",
    commit: "abc1234",
    workdir: "/tmp/work",
    runner,
    log: () => {},
  };
}

const build = { ok: true, outputDir: "/tmp/work/dist", command: {} as CommandResult };

describe("fly deploy provider: uses flyctl via runArgv (NO shell)", () => {
  it("invokes `flyctl deploy --app <app>` and is ok on exit 0 with a *.fly.dev preview", async () => {
    const runner = new FakeCommandRunner();
    const result = await flyProvider.deploy(ctxWith(runner), build, {
      target: "fly",
      app: "aurora-web",
    });

    const call = runner.calls.find((c) => c.via === "runArgv");
    expect(call).toBeDefined();
    expect(call!.via).toBe("runArgv"); // NO shell for runtime values
    expect(call!.file).toBe("flyctl");
    expect(call!.args).toEqual(["deploy", "--app", "aurora-web"]);
    expect(call!.cwd).toBe("/tmp/work");

    // Only runArgv was used — never the shell `run` path.
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);

    expect(result.ok).toBe(true);
    expect(result.previewUrl.endsWith(".fly.dev")).toBe(true);
    expect(result.previewUrl).toBe("https://aurora-web.fly.dev");
    expect(result.details).toMatchObject({ target: "fly", app: "aurora-web", exitCode: 0 });
    expect(result.externalRefs).toEqual({ fly_app: "aurora-web" });
  });

  it("passes --config when a non-default fly.toml path is configured", async () => {
    const runner = new FakeCommandRunner();
    await flyProvider.deploy(ctxWith(runner), build, {
      target: "fly",
      app: "aurora-web",
      config: "deploy/fly.toml",
    });
    const call = runner.calls.find((c) => c.via === "runArgv");
    expect(call!.args).toEqual([
      "deploy",
      "--app",
      "aurora-web",
      "--config",
      "deploy/fly.toml",
    ]);
  });

  it("prefers a *.fly.dev URL parsed from stdout over the default hostname", async () => {
    const runner = new FakeCommandRunner({
      "flyctl deploy --app aurora-web": {
        stdout: "Visit your newly deployed app at https://custom-name.fly.dev/\n",
      },
    });
    const result = await flyProvider.deploy(ctxWith(runner), build, {
      target: "fly",
      app: "aurora-web",
    });
    expect(result.previewUrl).toBe("https://custom-name.fly.dev/");
  });

  it("a non-zero flyctl exit code yields ok:false with no external refs", async () => {
    const runner = new FakeCommandRunner({
      "flyctl deploy --app aurora-web": { exitCode: 1 },
    });
    const result = await flyProvider.deploy(ctxWith(runner), build, {
      target: "fly",
      app: "aurora-web",
    });
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toEqual({});
    expect(result.details).toMatchObject({ target: "fly", app: "aurora-web", exitCode: 1 });
  });
});

describe("fly deploy provider: config validation (web-only, strict)", () => {
  it("validates on the web surface", () => {
    expect(() => validateDeployConfig("web", { target: "fly", app: "x" })).not.toThrow();
    expect(() =>
      validateDeployConfig("web", { target: "fly", app: "x", config: "fly.toml" }),
    ).not.toThrow();
  });

  it("is not valid for the desktop surface (web-only)", () => {
    expect(() => validateDeployConfig("desktop", { target: "fly", app: "x" })).toThrow(
      /not valid for the desktop surface/,
    );
  });

  it("rejects a missing app and unknown fields", () => {
    expect(() => validateDeployConfig("web", { target: "fly" })).toThrow();
    expect(() =>
      validateDeployConfig("web", { target: "fly", app: "x", extra: 1 }),
    ).toThrow();
  });
});
