import type { SigningStep } from "./index.js";
import type { BuildResult, ReleaseContext } from "../types.js";

/**
 * Windows Authenticode (`signtool sign …`) — Lane L8.
 *
 * **BUILT-BUT-DEFERRED (off by default).** Per the 2026-07-08 portfolio decision this code
 * is fully implemented but ships DISABLED: an app must set `desktop.signing.platform:
 * "windows"` AND `enabled: true` for it to run, which no app does yet. Do not change that
 * default.
 *
 * The signing certificate is loaded into the machine certificate store (or otherwise
 * referenced) by the runtime — it is NEVER passed as a `SECRET:` argv or logged
 * (invariant #4). `signtool` selects it automatically (best certificate) at runtime.
 *
 * Runs through `runArgv` (NO shell) because `build.outputDir` is a runtime value; signing
 * is in place so `outputDir` is unchanged and `ok` reflects `signtool`'s exit code.
 */
export const windowsSigningStep: SigningStep = {
  platform: "windows",

  async sign(ctx: ReleaseContext, build: BuildResult, _cfg: unknown): Promise<BuildResult> {
    ctx.log(`[desktop] sign(windows): authenticode ${build.outputDir}`);
    const signed = await ctx.runner.runArgv(
      "signtool",
      [
        "sign",
        "/fd", "sha256",
        "/tr", "http://timestamp.digicert.com",
        "/td", "sha256",
        build.outputDir,
      ],
      { cwd: ctx.workdir },
    );

    return { ...build, ok: signed.exitCode === 0, command: signed };
  },
};
