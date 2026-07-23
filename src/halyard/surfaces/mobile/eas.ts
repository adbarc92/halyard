import type { MobileToolchain } from "./toolchain.js";
import type { BuildResult, DeployResult, ReleaseContext, TestResult } from "../types.js";

/**
 * `eas` — the Expo Application Services toolchain. `eas build` runs the build in Expo's
 * cloud (there is no local artifact dir, so `outputDir` is `ctx.workdir`, mirroring the
 * `match` path); `eas submit` uploads to TestFlight (iOS) / a Play track (android). Deploy
 * lands at `uploaded`; the ASC/Play review poll drives uploaded → in_review → shipped_dark.
 *
 * Every runtime value goes through `runArgv` (NO shell — invariant #1). The EAS CLI reads
 * `EXPO_TOKEN` from the environment automatically, and the ASC API key / Play service
 * account JSON come from the environment too (Gate #2 resolves the `SECRET:` refs). Tokens
 * are never passed from config and this toolchain never reads or logs a credential
 * (invariant #4). A toolchain never decides pass/fail (invariant #2) — it reports the exit
 * codes and the gates adjudicate.
 */

interface IosCfg {
  asc_app_id: string;
}
interface AndroidCfg {
  package: string;
  track: string;
}

export const easToolchain: MobileToolchain = {
  name: "eas",

  async build(ctx: ReleaseContext, _cfg: unknown): Promise<BuildResult> {
    const platform = ctx.surface === "ios" ? "ios" : "android";
    ctx.log(`[${platform}] eas build (${ctx.version})`);
    const command = await ctx.runner.runArgv(
      "eas",
      ["build", "--platform", platform, "--profile", "production", "--non-interactive", "--json"],
      { cwd: ctx.workdir },
    );
    return { ok: command.exitCode === 0, outputDir: ctx.workdir, command };
  },

  async test(ctx: ReleaseContext, _cfg: unknown): Promise<TestResult> {
    const platform = ctx.surface === "ios" ? "ios" : "android";
    ctx.log(`[${platform}] eas test (npm test)`);
    const command = await ctx.runner.runArgv("npm", ["test"], { cwd: ctx.workdir });
    return { exitCode: command.exitCode, command };
  },

  async submit(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    if (ctx.surface === "ios") {
      const ios = cfg as IosCfg;
      ctx.log(`[ios] eas submit to TestFlight (app: ${ios.asc_app_id})`);
      const command = await ctx.runner.runArgv(
        "eas",
        ["submit", "--platform", "ios", "--non-interactive", "--profile", "production"],
        { cwd: ctx.workdir },
      );
      const ascBuildId = parseAscBuildId(command.stdout);
      const ok = command.exitCode === 0 && ascBuildId !== undefined;
      const previewUrl = ascBuildId
        ? `https://appstoreconnect.apple.com/apps/${ios.asc_app_id}/testflight/ios/${ascBuildId}`
        : "";
      return {
        ok,
        previewUrl,
        details: { target: "eas", surface: ctx.surface, exitCode: command.exitCode },
        externalRefs: ascBuildId ? { asc_build_id: ascBuildId, testflight_url: previewUrl } : {},
      };
    }

    const android = cfg as AndroidCfg;
    ctx.log(`[android] eas submit to Play (track: ${android.track})`);
    const command = await ctx.runner.runArgv(
      "eas",
      ["submit", "--platform", "android", "--non-interactive", "--profile", "production"],
      { cwd: ctx.workdir },
    );
    const versionCode = parsePlayVersionCode(command.stdout);
    const ok = command.exitCode === 0 && versionCode !== undefined;
    const previewUrl = versionCode
      ? `https://play.google.com/console/u/0/developers/app/${android.package}/tracks/${android.track}`
      : "";
    return {
      ok,
      previewUrl,
      details: { target: "eas", surface: ctx.surface, exitCode: command.exitCode },
      externalRefs: versionCode
        ? { play_version_code: versionCode, play_track: android.track }
        : {},
    };
  },
};

/** `eas submit` echoes `HALYARD_ASC_BUILD_ID=<id>` once ASC has the build number. */
function parseAscBuildId(stdout: string): string | undefined {
  const match = stdout.match(/HALYARD_ASC_BUILD_ID=(\S+)/);
  return match?.[1];
}

/** `eas submit` echoes `HALYARD_PLAY_VERSION_CODE=<n>` once Play has the version code. */
function parsePlayVersionCode(stdout: string): string | undefined {
  const match = stdout.match(/HALYARD_PLAY_VERSION_CODE=(\S+)/);
  return match?.[1];
}
