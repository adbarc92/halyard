import type { Release } from "../contracts/release.schema.js";

/**
 * A human-readable status projection for a release — what state it's in, what it's waiting
 * on, and how long it's been there. Pure (no I/O) so it's trivially testable and reusable:
 * the `halyard status` command and any embedding hub both render from this.
 */
export interface ReleaseStatus {
  release_id: string;
  app: string;
  surface: string;
  version: string;
  state: Release["state"];
  /** Plain-English account of which gate/actor the release is currently blocked on. */
  waiting_on: string;
  last_transition: { to: string; by: string; at: string } | null;
  age_hours: number | null;
  flag: string | null;
  review_status: string | null;
  flag_state: string | null;
  /** In-flight or rolled back — i.e. not a settled `live`/`dead`. Drives `status --stuck`. */
  stuck: boolean;
}

/** Which gate or actor a release is currently blocked on, by state. */
export function waitingOn(release: Release): string {
  switch (release.state) {
    case "tagged":
    case "built":
    case "tested":
      return "CI (build → test → deploy)";
    case "uploaded":
      return release.surface === "ios"
        ? "App Store review (asc-review-poll)"
        : "flag flip — the launch moment (human)";
    case "in_review":
      return "App Store review (asc-review-poll)";
    case "rejected":
      return "developer fix + resubmit";
    case "shipped_dark":
      return "flag flip — the launch moment (human)";
    case "live":
      return "— (live)";
    case "rolled_back":
      return "re-flip ON, or mark dead (human)";
    case "dead":
      return "— (terminal: failed)";
  }
}

function strRef(refs: Record<string, unknown>, key: string): string | null {
  const v = refs[key];
  return typeof v === "string" ? v : null;
}

export function summarizeRelease(release: Release, now: string): ReleaseStatus {
  const last = release.transitions.length > 0 ? release.transitions[release.transitions.length - 1]! : null;
  const ageHours = last ? Math.round(((Date.parse(now) - Date.parse(last.at)) / 3_600_000) * 10) / 10 : null;
  return {
    release_id: release.release_id,
    app: release.app,
    surface: release.surface,
    version: release.version,
    state: release.state,
    waiting_on: waitingOn(release),
    last_transition: last ? { to: last.to, by: last.by, at: last.at } : null,
    age_hours: ageHours,
    flag: release.flag,
    review_status: strRef(release.external_refs, "review_status"),
    flag_state: strRef(release.external_refs, "flag_state"),
    stuck: release.state !== "live" && release.state !== "dead",
  };
}
