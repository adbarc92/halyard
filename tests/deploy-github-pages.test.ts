import { describe, expect, it } from "vitest";
import { githubPagesProvider, pagesUrl } from "../src/halyard/surfaces/deploy/github-pages.js";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import type { CommandResult, CommandRunner, ReleaseContext } from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv — no real `gh` is on the test machine. */
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

const build: BuildLike = { ok: true, outputDir: "/tmp/work/build", command: {} as CommandResult };
type BuildLike = { ok: boolean; outputDir: string; command: CommandResult };

describe("github_pages deploy: uses gh via runArgv (NO shell)", () => {
  it("triggers a Pages build with the captured argv and computes owner.github.io/repo", async () => {
    const runner = new FakeCommandRunner();
    const result = await githubPagesProvider.deploy(ctxFor(runner), build, {
      target: "github_pages",
      repo: "owner/repo",
    });

    const ghCall = runner.calls.find((c) => c.via === "runArgv");
    expect(ghCall).toBeDefined();
    expect(ghCall!.via).toBe("runArgv"); // NO shell was used for runtime values
    expect(ghCall!.file).toBe("gh");
    expect(ghCall!.args).toEqual(["api", "--method", "POST", "repos/owner/repo/pages/builds"]);
    expect(ghCall!.cwd).toBe("/tmp/work");

    // The deploy path used ONLY runArgv (no shell `run`).
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);

    expect(result.ok).toBe(true);
    expect(result.previewUrl).toBe("https://owner.github.io/repo");
    expect(result.details).toMatchObject({ target: "github_pages", repo: "owner/repo", exitCode: 0 });
    expect(result.externalRefs).toEqual({ github_pages_repo: "owner/repo" });
  });

  it("owner/owner.github.io → root url with no trailing repo", async () => {
    const runner = new FakeCommandRunner();
    const result = await githubPagesProvider.deploy(ctxFor(runner), build, {
      target: "github_pages",
      repo: "owner/owner.github.io",
    });
    expect(result.previewUrl).toBe("https://owner.github.io");
    expect(pagesUrl("owner/owner.github.io")).toBe("https://owner.github.io");
    expect(pagesUrl("owner/repo")).toBe("https://owner.github.io/repo");
  });

  it("a non-zero gh exit code yields ok:false with no external refs", async () => {
    const runner = new FakeCommandRunner({
      "gh api --method POST repos/owner/repo/pages/builds": { exitCode: 1 },
    });
    const result = await githubPagesProvider.deploy(ctxFor(runner), build, {
      target: "github_pages",
      repo: "owner/repo",
    });
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toEqual({});
    expect(result.details).toMatchObject({ exitCode: 1 });
  });
});

describe("github_pages config: strict, web-only", () => {
  it("validates for the web surface", () => {
    expect(() =>
      validateDeployConfig("web", { target: "github_pages", repo: "o/r" }),
    ).not.toThrow();
  });

  it("is not valid for the desktop surface", () => {
    expect(() =>
      validateDeployConfig("desktop", { target: "github_pages", repo: "o/r" }),
    ).toThrow();
  });

  it("rejects a missing repo", () => {
    expect(() => validateDeployConfig("web", { target: "github_pages" })).toThrow();
  });

  it("rejects an unknown field (strict)", () => {
    expect(() =>
      validateDeployConfig("web", { target: "github_pages", repo: "o/r", extra: 1 }),
    ).toThrow();
  });
});
