import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { awsProvider } from "../src/halyard/surfaces/deploy/aws.js";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import type {
  BuildResult,
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv — no real `terraform` is on the test machine. */
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

const build: BuildResult = { ok: true, outputDir: "/tmp/work/dist", command: {} as CommandResult };

// The provider resolves terraform_dir against ctx.workdir; compute the same expected path
// here (platform-aware — Windows uses backslashes + a drive letter).
const resolvedDir = resolve("/tmp/work", "infra");

function ctxFor(runner: CommandRunner, workdir = "/tmp/work"): ReleaseContext {
  return {
    app: {} as AppConfig,
    surface: "web",
    releaseId: "rel_x_web_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir,
    runner,
    log: () => {},
  };
}

describe("aws deploy provider", () => {
  it("runs terraform apply via runArgv (NO shell) and ok on exit 0", async () => {
    const runner = new FakeCommandRunner();
    const result = await awsProvider.deploy(ctxFor(runner), build, {
      target: "aws",
      terraform_dir: "infra",
    });

    const applyCall = runner.calls[0]!;
    expect(applyCall.via).toBe("runArgv"); // runtime path, no shell
    expect(applyCall.file).toBe("terraform");
    expect(applyCall.args).toContain("apply");
    expect(applyCall.args).toContain("-auto-approve");
    // terraform_dir resolved against workdir
    expect(applyCall.args).toContain(resolvedDir);

    expect(result.ok).toBe(true);
    expect(result.details).toMatchObject({ target: "aws", exitCode: 0 });
    expect(result.externalRefs).toMatchObject({ terraform_dir: "infra" });
    // deploy path used ONLY runArgv (never shell `run`)
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);
  });

  it("with output_url_var, a second `terraform output -raw <var>` sets previewUrl", async () => {
    const url = "https://aurora.example.com";
    const runner = new FakeCommandRunner({
      // second call — trimmed stdout becomes previewUrl
      [`terraform -chdir ${resolvedDir} output -raw site_url`]: {
        stdout: `${url}\n`,
      },
    });
    const result = await awsProvider.deploy(ctxFor(runner), build, {
      target: "aws",
      terraform_dir: "infra",
      output_url_var: "site_url",
    });

    expect(runner.calls).toHaveLength(2);
    const outputCall = runner.calls[1]!;
    expect(outputCall.via).toBe("runArgv");
    expect(outputCall.file).toBe("terraform");
    expect(outputCall.args).toEqual(["-chdir", resolvedDir, "output", "-raw", "site_url"]);
    expect(result.previewUrl).toBe(url);
    expect(result.ok).toBe(true);
  });

  it("non-zero apply exit → ok:false, no output call, empty externalRefs", async () => {
    const runner = new FakeCommandRunner({
      [`terraform -chdir ${resolvedDir} apply -auto-approve -input=false`]: { exitCode: 1 },
    });
    const result = await awsProvider.deploy(ctxFor(runner), build, {
      target: "aws",
      terraform_dir: "infra",
      output_url_var: "site_url",
    });

    expect(result.ok).toBe(false);
    expect(result.previewUrl).toBe("");
    expect(result.externalRefs).toEqual({});
    // only the apply ran; the output call was skipped
    expect(runner.calls).toHaveLength(1);
  });

  it("config: web accepts aws; desktop rejects it; missing terraform_dir throws", () => {
    expect(() => validateDeployConfig("web", { target: "aws", terraform_dir: "infra" })).not.toThrow();
    expect(() => validateDeployConfig("desktop", { target: "aws", terraform_dir: "infra" })).toThrow();
    expect(() => validateDeployConfig("web", { target: "aws" })).toThrow();
  });
});
