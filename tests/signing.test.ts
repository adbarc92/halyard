import { describe, expect, it } from "vitest";
import { getSigningStep } from "../src/halyard/surfaces/index.js";
import { macosSigningStep } from "../src/halyard/surfaces/signing/macos.js";
import { windowsSigningStep } from "../src/halyard/surfaces/signing/windows.js";
import type {
  BuildResult,
  CommandResult,
  CommandRunner,
  ReleaseContext,
} from "../src/halyard/surfaces/types.js";

/** Records every call so a test can assert WHICH path (shell `run` vs no-shell `runArgv`)
 * was used and with exactly which argv — mirrors surface-desktop.test.ts. */
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

function ctxFor(runner: CommandRunner, workdir = "/tmp/work"): ReleaseContext {
  return {
    app: {} as ReleaseContext["app"],
    surface: "desktop",
    releaseId: "rel_test_desktop_1.0.0",
    version: "1.0.0",
    commit: "abc1234",
    workdir,
    runner,
    log: () => {},
  };
}

function buildResult(): BuildResult {
  return { ok: true, outputDir: "/tmp/work/bundle", command: {} as CommandResult };
}

describe("macOS signing: notarize + staple via runArgv (NO shell)", () => {
  it("notarizes then staples on success, returning ok:true", async () => {
    const runner = new FakeCommandRunner();
    const build = await macosSigningStep.sign(ctxFor(runner), buildResult(), {});

    // No shell was used anywhere in the signing path.
    expect(runner.calls.every((c) => c.via === "runArgv")).toBe(true);

    const notarize = runner.calls[0]!;
    const staple = runner.calls[1]!;
    expect(notarize.via).toBe("runArgv");
    expect(notarize.file).toBe("xcrun");
    expect(notarize.args).toEqual([
      "notarytool",
      "submit",
      "/tmp/work/bundle",
      "--keychain-profile",
      "halyard-notary",
      "--wait",
    ]);

    expect(staple).toBeDefined();
    expect(staple.file).toBe("xcrun");
    expect(staple.args).toEqual(["stapler", "staple", "/tmp/work/bundle"]);

    expect(build.ok).toBe(true);
    expect(build.outputDir).toBe("/tmp/work/bundle"); // in-place, unchanged
  });

  it("a non-zero notarytool exit yields ok:false and skips staple", async () => {
    const runner = new FakeCommandRunner({
      "xcrun notarytool submit /tmp/work/bundle --keychain-profile halyard-notary --wait": {
        exitCode: 1,
      },
    });
    const build = await macosSigningStep.sign(ctxFor(runner), buildResult(), {});

    expect(build.ok).toBe(false);
    expect(runner.calls).toHaveLength(1); // only notarize ran — no stapler call
    expect(runner.calls.some((c) => c.args?.includes("staple"))).toBe(false);
  });

  it("uses a custom notary_profile from cfg", async () => {
    const runner = new FakeCommandRunner();
    await macosSigningStep.sign(ctxFor(runner), buildResult(), { notary_profile: "acme-notary" });

    const notarize = runner.calls[0]!;
    expect(notarize.args).toContain("--keychain-profile");
    expect(notarize.args).toContain("acme-notary");
    expect(notarize.args).not.toContain("halyard-notary");
  });
});

describe("Windows signing: signtool via runArgv (built-but-deferred)", () => {
  it("signs with signtool, no secret in any argv, ok from exit code", async () => {
    const runner = new FakeCommandRunner();
    const build = await windowsSigningStep.sign(ctxFor(runner), buildResult(), {
      windows_certificate_ref: "SECRET:WINDOWS_CERTIFICATE",
      windows_certificate_password_ref: "SECRET:WINDOWS_CERTIFICATE_PASSWORD",
    });

    const call = runner.calls[0]!;
    expect(call.via).toBe("runArgv"); // NO shell
    expect(call.file).toBe("signtool");
    expect(call.args).toContain("sign");
    expect(call.args).toContain("/tmp/work/bundle");

    // No secret ref leaks into any recorded argv.
    for (const c of runner.calls) {
      for (const arg of c.args ?? []) {
        expect(arg).not.toContain("SECRET:");
      }
    }

    expect(build.ok).toBe(true);
  });

  it("propagates a non-zero signtool exit as ok:false", async () => {
    const runner = new FakeCommandRunner({
      "signtool sign /fd sha256 /tr http://timestamp.digicert.com /td sha256 /tmp/work/bundle": {
        exitCode: 2,
      },
    });
    const build = await windowsSigningStep.sign(ctxFor(runner), buildResult(), {});
    expect(build.ok).toBe(false);
  });
});

describe("signing registry resolves by platform", () => {
  it("getSigningStep returns the platform-matched signer", () => {
    expect(getSigningStep("macos").platform).toBe("macos");
    expect(getSigningStep("windows").platform).toBe("windows");
  });
});
