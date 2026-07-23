import type { OrgConfig } from "../../config/org-config.schema.js";
import type { AppConfig } from "../../config/app-config.schema.js";
import type { FlagClient } from "../../flags/types.js";
import type { ReconcileSource } from "../reconcile.js";
import { ascReviewSource, type AscClient } from "./asc-review.js";
import { LiveAscClient } from "./asc-client.js";
import { playReviewSource } from "./play-review.js";
import { LivePlayClient, type PlayClient } from "./play-client.js";
import { flagPollSource } from "./flag-poll.js";

/**
 * Registry of real external pollers, assembled from config + injected clients. The
 * reconcile *engine* (M2) doesn't know about any of these; milestones add pollers here:
 *
 *   - App Store Connect review poll  → uploaded → in_review → shipped_dark  (M3) ✓
 *   - Play (production) review poll   → uploaded → in_review → shipped_dark  (mirrors ASC; production track only) ✓
 *   - Flag provider poll             → shipped_dark → live, live → rolled_back (M4) ✓
 *   - Sentry triage                  → proposes into the approval queue      (M6)
 *
 * Clients are injected so the wiring is testable and the provider is swappable. A poller
 * that errors at runtime is isolated by the engine, so registering one never breaks the
 * safe sweep when there's nothing to poll.
 */
export interface SourceDeps {
  flagClient: FlagClient;
  makeAscClient?: (app: AppConfig) => AscClient;
  makePlayClient?: (app: AppConfig) => PlayClient;
  /**
   * Per-surface review-poll schedule gate. Given a surface's `review_poll_cron`, returns
   * whether that review poll is DUE for the sweep ending now. Built from a clock + window
   * by `makeCronDuePredicate` (schedule.ts). When omitted, review polls are always due —
   * preserving the legacy "every sweep" behavior for callers that don't wire a clock.
   *
   * This gates ONLY the ASC (iOS) and Play (production Android) review polls. The flag
   * poll is the launch moment and must run every sweep, so it is never gated. A skipped
   * review poll is a pure no-op (Invariant #1): it proposes nothing, transitions nothing.
   */
  isReviewPollDue?: (reviewPollCron: string | undefined) => boolean;
}

export function defaultMakeAscClient(app: AppConfig): AscClient {
  return new LiveAscClient(app.surfaces.ios?.asc_app_id ?? "");
}

export function defaultMakePlayClient(app: AppConfig): PlayClient {
  return new LivePlayClient(app.surfaces.android?.package ?? "");
}

export function buildReconcileSources(
  _org: OrgConfig,
  apps: AppConfig[],
  deps: SourceDeps,
): ReconcileSource[] {
  const sources: ReconcileSource[] = [];
  const makeAsc = deps.makeAscClient ?? defaultMakeAscClient;
  const makePlay = deps.makePlayClient ?? defaultMakePlayClient;
  // Default: no schedule gate → every review poll is due (legacy "every sweep" behavior).
  const isReviewPollDue = deps.isReviewPollDue ?? (() => true);

  for (const app of apps) {
    // Each surface's review poll only joins this sweep when its `review_poll_cron` is due.
    // Gating happens here, at source-assembly time — the reconcile engine stays
    // surface-agnostic and never learns about cron. A surface with no review_poll_cron
    // (Android has none in config) is gated by its own rule below; iOS always has one.
    if (app.surfaces.ios?.enabled && isReviewPollDue(app.surfaces.ios.review_poll_cron)) {
      sources.push(ascReviewSource(makeAsc(app)));
    }
    // The Play review poll is the production-track mirror of the ASC poll. Only the
    // production track goes through a real Play review; internal/alpha/beta have no
    // review gate and rest at `uploaded` (flipped to live by the flag-poll). Android
    // config carries no review_poll_cron yet, so its review poll shares the iOS surface's
    // schedule when present, else defaults to due every sweep (predicate of undefined).
    if (
      app.surfaces.android?.enabled &&
      app.surfaces.android.track === "production" &&
      isReviewPollDue(app.surfaces.ios?.review_poll_cron)
    ) {
      sources.push(playReviewSource(makePlay(app)));
    }
  }

  // One flag poll serves every surface; the flag truth is the launch moment.
  sources.push(flagPollSource(deps.flagClient));

  return sources;
}
