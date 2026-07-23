import type { Release } from "../../contracts/release.schema.js";
import type { FlagClient } from "../../flags/types.js";
import type { ReconcileSource } from "../reconcile.js";

/**
 * Flag poll (M4): the launch moment. The coordinator projects flag truth into state —
 * when a build that shipped dark has its flag flipped ON, the feature exists for users,
 * so the release goes `live` (publicity fires here at M5). Flipping the flag back OFF on
 * a live release is the only rollback mobile gives you → `rolled_back`.
 *
 * The flag flip itself is always a human action (`halyard flip`); this source only
 * *observes* the resulting truth and reconciles it — never flips anything.
 *
 * A re-flip ON after a rollback returns the release to `live`. Publicity does NOT
 * re-announce: M5's per-launch announce ledger has already recorded the scope, so a
 * re-enabled feature won't re-fire the fan-out.
 */
export function flagPollSource(client: FlagClient): ReconcileSource {
  // States from which flag ON projects to `live`. iOS rests at shipped_dark (post-review);
  // web, desktop, and non-production Android have no store review gate so they rest at
  // uploaded; rolled_back is the post-rollback resting state.
  //
  // Production-track Android is the exception: it goes through a Play review poll (the
  // mirror of the iOS ASC poll) before shipped_dark, so it must NOT rest at uploaded —
  // otherwise an early flag flip would shortcut it straight to live, bypassing review.
  // play_track is absent on legacy/non-Android records, and `undefined !== "production"`
  // correctly treats those as resting.
  const isAtRest = (release: Pick<Release, "state" | "surface" | "external_refs">) =>
    release.state === "shipped_dark" ||
    release.state === "rolled_back" ||
    ((release.surface === "web" ||
      release.surface === "desktop" ||
      (release.surface === "android" && release.external_refs?.play_track !== "production")) &&
      release.state === "uploaded");

  return {
    name: "flag-poll",
    appliesTo: (release) =>
      release.flag !== null && (isAtRest(release) || release.state === "live"),
    poll: async (release, ctx) => {
      const flagKey = release.flag!;
      const state = await client.getState(flagKey);
      ctx.log(`[flag] ${release.release_id}: ${flagKey}=${state}`);

      if (isAtRest(release) && state === "on") {
        return [{ to: "live", by: "flag-poll", externalRefs: { flag_state: "on" } }];
      }
      if (release.state === "live" && state === "off") {
        return [{ to: "rolled_back", by: "flag-poll", externalRefs: { flag_state: "off" } }];
      }
      return [];
    },
  };
}
