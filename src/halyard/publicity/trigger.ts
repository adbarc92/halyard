import type { AppConfig } from "../config/app-config.schema.js";
import type { OrgConfig } from "../config/org-config.schema.js";
import type { Backend } from "../coordinator/ports.js";
import type { Release } from "../contracts/release.schema.js";
import { pendingAnnouncements, scopeKey } from "./announce-policy.js";
import type { Drafter } from "./drafter.js";
import { fanOutAnnouncement, type FanoutResult } from "./fanout.js";
import type { Notifier } from "./notify.js";
import type { Publisher } from "./publishers.js";

/**
 * Publicity trigger. Runs after the reconcile sweep: for every launch with live
 * releases, it evaluates the announce policy against the idempotency ledger and fans
 * out any pending announcements. This is the one place publicity fires — on `live`,
 * never on tag or store approval.
 */
export interface PublicityDeps {
  org: OrgConfig;
  apps: AppConfig[];
  drafter: Drafter;
  publisher: Publisher;
  notifier: Notifier;
  voiceCanon: string[];
  backend: Backend;
  now: () => string;
  log?: (message: string) => void;
}

export async function firePublicity(deps: PublicityDeps): Promise<FanoutResult[]> {
  const results: FanoutResult[] = [];

  for (const launchId of await deps.backend.launches.scanIds()) {
    const launch = await deps.backend.launches.read(launchId);
    if (!launch) continue;

    const releases = (
      await Promise.all(launch.releases.map((rid) => deps.backend.records.read(rid)))
    ).filter((r): r is Release => r !== null);

    const announced = await deps.backend.ledger.readAnnounced(launchId);
    const pending = pendingAnnouncements(launch, releases, announced);
    if (pending.length === 0) continue;

    const app = deps.apps.find((a) => a.app.slug === launch.app);
    const enabledChannels = app ? app.channels.enabled : [];

    for (const announcement of pending) {
      const result = await fanOutAnnouncement(announcement, launch, {
        org: deps.org,
        enabledChannels,
        drafter: deps.drafter,
        publisher: deps.publisher,
        notifier: deps.notifier,
        voiceCanon: deps.voiceCanon,
        backend: deps.backend,
        now: deps.now,
        alreadyAnnounced: announced,
        ...(deps.log ? { log: deps.log } : {}),
      });
      // Mark the scope announced only when the fan-out completed (no retryable skip), so a
      // channel that was transiently unavailable is retried on a later pass instead of
      // being silently dropped. Per-channel dedup is handled inside fanOutAnnouncement.
      if (result.complete) await deps.backend.ledger.markAnnounced(launchId, scopeKey(announcement));
      results.push(result);
    }
  }

  return results;
}
