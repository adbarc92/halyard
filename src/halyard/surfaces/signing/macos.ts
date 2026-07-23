import type { SigningStep } from "./index.js";
import type { BuildResult, ReleaseContext } from "../types.js";

/**
 * macOS Developer ID **notarize + staple** (Lane L8). Runs now — macOS notarization is
 * enabled per the 2026-07-08 portfolio decision.
 *
 * Notarization credentials (Apple ID / team ID / app-specific password, all `SECRET:` refs)
 * are NEVER expanded into an argv or a log line (invariant #4). Instead they are supplied to
 * the runtime out-of-band via a **notarytool keychain profile** — a non-secret profile NAME
 * (`cfg.notary_profile`, default `"halyard-notary"`). The profile is created once on the
 * runner (`xcrun notarytool store-credentials`); only its name crosses the seam here.
 *
 * Everything runs through `runArgv` (NO shell) because `build.outputDir` is a runtime value
 * and must not be interpretable as shell. Notarize/staple happen in place, so `outputDir`
 * is unchanged; `ok` reflects the last command's exit code.
 */
export const macosSigningStep: SigningStep = {
  platform: "macos",

  async sign(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<BuildResult> {
    const profile = (cfg as { notary_profile?: string }).notary_profile ?? "halyard-notary";

    ctx.log(`[desktop] sign(macos): notarize ${build.outputDir} (profile: ${profile})`);
    const notarize = await ctx.runner.runArgv(
      "xcrun",
      ["notarytool", "submit", build.outputDir, "--keychain-profile", profile, "--wait"],
      { cwd: ctx.workdir },
    );

    if (notarize.exitCode !== 0) {
      ctx.log(`[desktop] sign(macos): notarize failed (exit ${notarize.exitCode}); skipping staple`);
      return { ...build, ok: false, command: notarize };
    }

    ctx.log(`[desktop] sign(macos): staple ${build.outputDir}`);
    const staple = await ctx.runner.runArgv(
      "xcrun",
      ["stapler", "staple", build.outputDir],
      { cwd: ctx.workdir },
    );

    return { ...build, ok: staple.exitCode === 0, command: staple };
  },
};
