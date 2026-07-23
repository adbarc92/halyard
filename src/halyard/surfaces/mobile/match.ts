import type { MobileToolchain } from "./toolchain.js";
import type { BuildResult, DeployResult, ReleaseContext, TestResult } from "../types.js";

/**
 * `match` — the fastlane toolchain (the pre-registry mobile path, ported here unchanged).
 * iOS: fastlane `match` (signing) + `gym` (archive) + `pilot`/`deliver` (TestFlight +
 * submit for review). Android: gradle bundle + `supply` (upload to the Play track). Deploy
 * lands at `uploaded`; the ASC/Play review poll drives uploaded → in_review → shipped_dark.
 *
 * Non-secret identity/distribution parameters are passed to the lanes via env; secrets
 * (match repo, ASC API key, Play service-account JSON) are read from the environment by
 * fastlane at runtime — the workflow resolves the `SECRET:` refs. This toolchain never logs
 * credentials (invariant #4). The lane commands are operator-trusted, so they run through
 * the shell `run` (unchanged from the original adapters).
 */

interface IosCfg {
  bundle_id: string;
  asc_app_id: string;
  team_id: string;
  testflight_group: string;
}
interface AndroidCfg {
  package: string;
  track: string;
}

/** Non-secret parameters passed to the fastlane lanes via env, per surface. */
function laneEnv(ctx: ReleaseContext, cfg: unknown): Record<string, string> {
  if (ctx.surface === "ios") {
    const ios = cfg as IosCfg;
    return {
      HALYARD_BUNDLE_ID: ios.bundle_id,
      HALYARD_ASC_APP_ID: ios.asc_app_id,
      HALYARD_TEAM_ID: ios.team_id,
      HALYARD_TESTFLIGHT_GROUP: ios.testflight_group,
      HALYARD_VERSION: ctx.version,
      HALYARD_COMMIT: ctx.commit,
    };
  }
  const android = cfg as AndroidCfg;
  return {
    HALYARD_PACKAGE: android.package,
    HALYARD_PLAY_TRACK: android.track,
    HALYARD_VERSION: ctx.version,
    HALYARD_COMMIT: ctx.commit,
  };
}

export const matchToolchain: MobileToolchain = {
  name: "match",

  async build(ctx: ReleaseContext, cfg: unknown): Promise<BuildResult> {
    if (ctx.surface === "ios") {
      ctx.log(`[ios] match + gym (build ${ctx.version})`);
      const command = await ctx.runner.run("bundle exec fastlane ios build", {
        cwd: ctx.workdir,
        env: laneEnv(ctx, cfg),
      });
      return { ok: command.exitCode === 0, outputDir: ctx.workdir, command };
    }
    ctx.log(`[android] gradle bundle (build ${ctx.version})`);
    const command = await ctx.runner.run("bundle exec fastlane android build", {
      cwd: ctx.workdir,
      env: laneEnv(ctx, cfg),
    });
    return { ok: command.exitCode === 0, outputDir: ctx.workdir, command };
  },

  async test(ctx: ReleaseContext, cfg: unknown): Promise<TestResult> {
    const lane = ctx.surface === "ios" ? "ios" : "android";
    ctx.log(`[${lane}] fastlane test`);
    const command = await ctx.runner.run(`bundle exec fastlane ${lane} test`, {
      cwd: ctx.workdir,
      env: laneEnv(ctx, cfg),
    });
    return { exitCode: command.exitCode, command };
  },

  async submit(ctx: ReleaseContext, _build: BuildResult, cfg: unknown): Promise<DeployResult> {
    if (ctx.surface === "ios") {
      const ios = cfg as IosCfg;
      ctx.log(`[ios] pilot upload to TestFlight (group: ${ios.testflight_group})`);
      const command = await ctx.runner.run("bundle exec fastlane ios upload", {
        cwd: ctx.workdir,
        env: laneEnv(ctx, cfg),
      });
      const ascBuildId = parseAscBuildId(command.stdout);
      const ok = command.exitCode === 0 && ascBuildId !== undefined;
      const previewUrl = ascBuildId
        ? `https://appstoreconnect.apple.com/apps/${ios.asc_app_id}/testflight/ios/${ascBuildId}`
        : "";
      return {
        ok,
        previewUrl,
        details: { target: "testflight", asc_app_id: ios.asc_app_id, exitCode: command.exitCode },
        externalRefs: ascBuildId ? { asc_build_id: ascBuildId, testflight_url: previewUrl } : {},
      };
    }

    const android = cfg as AndroidCfg;
    ctx.log(`[android] supply upload to Play (track: ${android.track})`);
    const command = await ctx.runner.run("bundle exec fastlane android upload", {
      cwd: ctx.workdir,
      env: laneEnv(ctx, cfg),
    });
    const versionCode = parsePlayVersionCode(command.stdout);
    const ok = command.exitCode === 0 && versionCode !== undefined;
    const previewUrl = versionCode
      ? `https://play.google.com/console/u/0/developers/app/${android.package}/tracks/${android.track}`
      : "";
    return {
      ok,
      previewUrl,
      details: { target: "play", track: android.track, exitCode: command.exitCode },
      externalRefs: versionCode
        ? { play_version_code: versionCode, play_track: android.track }
        : {},
    };
  },
};

/** The upload lane echoes `HALYARD_ASC_BUILD_ID=<id>` once pilot has the build number. */
function parseAscBuildId(stdout: string): string | undefined {
  const match = stdout.match(/HALYARD_ASC_BUILD_ID=(\S+)/);
  return match?.[1];
}

/** The upload lane echoes `HALYARD_PLAY_VERSION_CODE=<n>` once supply has the version code. */
function parsePlayVersionCode(stdout: string): string | undefined {
  const match = stdout.match(/HALYARD_PLAY_VERSION_CODE=(\S+)/);
  return match?.[1];
}
