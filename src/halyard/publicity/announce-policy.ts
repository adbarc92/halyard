import type { Surface } from "../config/primitives.js";
import type { Launch } from "../contracts/launch.schema.js";
import type { Release } from "../contracts/release.schema.js";

/**
 * Announce policy (§3/§5), as a pure deterministic function. Publicity fires on the
 * `live` transition (invariant: never on tag/store approval), and *which* live events
 * trigger an announcement depends on the launch's announce_policy:
 *
 *   per_surface  → announce each surface as it goes live
 *   first_surface→ announce once, when the first surface goes live
 *   all_surfaces → announce once, only when every release is live
 *
 * The `announced` set is the idempotency ledger (scope keys already fired), so this is
 * safe to call every reconcile pass.
 */
export interface Announcement {
  scope: "surface" | "launch";
  surface?: Surface;
  reason: string;
}

export function scopeKey(a: Announcement): string {
  return a.scope === "surface" ? `surface:${a.surface}` : "launch";
}

export function pendingAnnouncements(
  launch: Launch,
  releases: Release[],
  announced: ReadonlySet<string>,
): Announcement[] {
  const live = releases.filter((r) => r.state === "live");
  if (live.length === 0) return [];

  switch (launch.announce_policy) {
    case "per_surface":
      return live
        .filter((r) => !announced.has(`surface:${r.surface}`))
        .map((r) => ({ scope: "surface", surface: r.surface, reason: `${r.surface} live` }));

    case "first_surface": {
      if (announced.has("launch")) return [];
      const first = live[0]!;
      return [{ scope: "launch", surface: first.surface, reason: "first surface live" }];
    }

    case "all_surfaces": {
      if (announced.has("launch")) return [];
      // Compare against the launch's *declared* releases, not just the records that
      // happen to exist on disk — otherwise a launch whose other releases aren't created
      // yet would announce "all surfaces" with only a subset actually live.
      const declared = launch.releases.length;
      const allLive =
        declared > 0 && releases.length === declared && releases.every((r) => r.state === "live");
      return allLive ? [{ scope: "launch", reason: "all surfaces live" }] : [];
    }
  }
}
