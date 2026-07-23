import { describe, expect, it } from "vitest";
import { vercelProvider, extractVercelUrl } from "../src/halyard/surfaces/deploy/vercel.js";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import type {
  BuildResult,
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv — no real `vercel` CLI is on the test machine. */
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

const buildOf = (outputDir: string): BuildResult => ({
  ok: true,
  outputDir,
  command: {} as CommandResult,
});

function ctxFor(runner: CommandRunner, workdir = "/tmp/work"): ReleaseContext {
  return {
    app: {} as AppConfig,
    surface: "web",
    releaseId: "rel_aurora_web_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir,
    runner,
    log: () => {},
  };
}

describe("vercel deploy provider", () => {
  it("deploys via runArgv (NO shell), parses the vercel.app URL, ok:true", async () => {
    const prodUrl = "https://aurora-web-abc123.vercel.app";
    const runner = new FakeCommandRunner({
      "vercel deploy --prod --yes --cwd /tmp/work/dist": { stdout: `Deploying...\n${prodUrl}\n` },
    });
    const deploy = await vercelProvider.deploy(
      ctxFor(runner),
      buildOf("/tmp/work/dist"),
      { target: "vercel" },
    );

    const call = runner.calls.find((c) => c.via === "runArgv");
    expect(call).toBeDefined();
    expect(call!.via).toBe("runArgv"); // NO shell was used for runtime values
    expect(call!.file).toBe("vercel");
    expect(call!.args!.slice(0, 3)).toEqual(["deploy", "--prod", "--yes"]);
    expect(call!.args).toContain("--cwd");
    expect(call!.args).toContain("/tmp/work/dist");
    // Token is never passed as a flag (relies on VERCEL_TOKEN in env).
    expect(call!.args).not.toContain("--token");
    // The deploy path used ONLY runArgv (no shell `run`).
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);

    expect(deploy.ok).toBe(true);
    expect(deploy.previewUrl).toBe(prodUrl);
    expect(deploy.details).toMatchObject({ target: "vercel", exitCode: 0 });
  });

  it("passes --project when config supplies one", async () => {
    const runner = new FakeCommandRunner({
      "vercel deploy --prod --yes --cwd /tmp/work/dist --project aurora-web": {
        stdout: "https://aurora-web.vercel.app\n",
      },
    });
    await vercelProvider.deploy(ctxFor(runner), buildOf("/tmp/work/dist"), {
      target: "vercel",
      project: "aurora-web",
    });
    const call = runner.calls.find((c) => c.via === "runArgv")!;
    expect(call.args).toContain("--project");
    expect(call.args).toContain("aurora-web");
  });

  it("a non-zero exit code yields ok:false", async () => {
    const runner = new FakeCommandRunner({
      "vercel deploy --prod --yes --cwd /tmp/work/dist": {
        exitCode: 1,
        stdout: "https://aurora-web.vercel.app\n",
      },
    });
    const deploy = await vercelProvider.deploy(
      ctxFor(runner),
      buildOf("/tmp/work/dist"),
      { target: "vercel" },
    );
    expect(deploy.ok).toBe(false);
  });

  it("no URL in stdout yields ok:false with an empty previewUrl", async () => {
    const runner = new FakeCommandRunner({
      "vercel deploy --prod --yes --cwd /tmp/work/dist": { stdout: "Deploying...\nDone.\n" },
    });
    const deploy = await vercelProvider.deploy(
      ctxFor(runner),
      buildOf("/tmp/work/dist"),
      { target: "vercel" },
    );
    expect(deploy.ok).toBe(false);
    expect(deploy.previewUrl).toBe("");
  });
});

describe("extractVercelUrl helper", () => {
  it("prefers a *.vercel.app URL over other https URLs", () => {
    const out = "Inspect: https://vercel.com/foo/bar\nProduction: https://x.vercel.app\n";
    expect(extractVercelUrl(out)).toBe("https://x.vercel.app");
  });

  it("falls back to the first https URL when no vercel.app URL is present", () => {
    expect(extractVercelUrl("Preview: https://custom.example.com/deploy")).toBe(
      "https://custom.example.com/deploy",
    );
  });

  it("returns \"\" when no URL is present", () => {
    expect(extractVercelUrl("no url here")).toBe("");
  });
});

describe("vercel deploy config validation (registry surface guard + strict schema)", () => {
  it("validates for the web surface (its only surface)", () => {
    expect(() => validateDeployConfig("web", { target: "vercel" })).not.toThrow();
    expect(() => validateDeployConfig("web", { target: "vercel", project: "aurora-web" })).not.toThrow();
  });

  it("rejects vercel on a non-web surface (web-only guard)", () => {
    expect(() => validateDeployConfig("desktop", { target: "vercel" })).toThrow(
      /not valid for the desktop surface/,
    );
  });

  it("rejects an unknown extra field (strict schema)", () => {
    expect(() => validateDeployConfig("web", { target: "vercel", extra: 1 })).toThrow();
  });
});
