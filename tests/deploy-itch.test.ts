import { describe, expect, it } from "vitest";
import { itchProvider } from "../src/halyard/surfaces/deploy/itch.js";
import { validateDeployConfig } from "../src/halyard/surfaces/index.js";
import type {
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";

/** Records each call so a test can assert the shell (`run`) vs no-shell (`runArgv`) path
 * and the exact argv — no real `butler` is on the test machine. */
interface RunCall {
  via: "run" | "runArgv";
  command?: string;
  file?: string;
  args?: string[];
  cwd: string;
}

class FakeCommandRunner implements CommandRunner {
  readonly calls: RunCall[] = [];
  constructor(private readonly exitCode = 0) {}
  async run(command: string, opts: { cwd: string }): Promise<CommandResult> {
    this.calls.push({ via: "run", command, cwd: opts.cwd });
    return { command, exitCode: this.exitCode, stdout: "", stderr: "" };
  }
  async runArgv(file: string, args: string[], opts: { cwd: string }): Promise<CommandResult> {
    this.calls.push({ via: "runArgv", file, args, cwd: opts.cwd });
    return { command: [file, ...args].join(" "), exitCode: this.exitCode, stdout: "", stderr: "" };
  }
}

function ctx(runner: CommandRunner): ReleaseContext {
  return {
    app: {} as AppConfig,
    surface: "desktop",
    releaseId: "rel_itch_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir: "/tmp/work",
    runner,
    log: () => {},
  };
}

const build = { ok: true, outputDir: "/tmp/work/bundle", command: {} as CommandResult };
const cfg = { target: "itch", user: "user", game: "game", channel: "channel" };

describe("itch provider: deploy pushes via butler using runArgv (NO shell)", () => {
  it("invokes `butler push <outputDir> user/game:channel` with the captured argv", async () => {
    const runner = new FakeCommandRunner(0);
    const result = await itchProvider.deploy(ctx(runner), build, cfg);

    const call = runner.calls.find((c) => c.via === "runArgv");
    expect(call).toBeDefined();
    expect(call!.via).toBe("runArgv"); // NO shell for runtime values
    expect(call!.file).toBe("butler");
    expect(call!.args).toEqual(["push", "/tmp/work/bundle", "user/game:channel"]);
    // The deploy path used ONLY runArgv (no shell `run`).
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);

    expect(result.ok).toBe(true);
    expect(result.previewUrl).toBe("https://user.itch.io/game");
    expect(result.details).toMatchObject({
      target: "itch",
      channel: "user/game:channel",
      exitCode: 0,
    });
    expect(result.externalRefs).toEqual({ itch_channel: "user/game:channel" });
  });

  it("a non-zero butler exit code yields ok:false with no external refs", async () => {
    const runner = new FakeCommandRunner(1);
    const result = await itchProvider.deploy(ctx(runner), build, cfg);
    expect(result.ok).toBe(false);
    expect(result.externalRefs).toEqual({});
    expect(result.details).toMatchObject({ exitCode: 1 });
  });
});

describe("itch provider: config validation (desktop-only, strict)", () => {
  it("accepts a valid desktop itch config", () => {
    expect(() =>
      validateDeployConfig("desktop", { target: "itch", user: "u", game: "g", channel: "win" }),
    ).not.toThrow();
  });

  it("rejects itch on the web surface (desktop-only)", () => {
    expect(() =>
      validateDeployConfig("web", { target: "itch", user: "u", game: "g", channel: "win" }),
    ).toThrow();
  });

  it("rejects a config missing the required channel field", () => {
    expect(() =>
      validateDeployConfig("desktop", { target: "itch", user: "u", game: "g" }),
    ).toThrow();
  });
});
