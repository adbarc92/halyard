import type { Proposal } from "../contracts/proposal.schema.js";
import { AUTO_PROMOTE_PREFIX } from "../flags/naming.js";
import { proposeOnce } from "./proposals.js";
import type { Backend } from "./ports.js";

const DAY_MS = 86_400_000;

/**
 * Flag graduation (M4). A launch flag is a short-lived kill-switch: once a release has
 * been `live` and stable past the app's `graduate_after_days`, the flag is dead weight.
 * This surfaces a *removal proposal* into the approval queue — it never removes the flag
 * itself (human approval required). Idempotent: one open proposal per release.
 */
export async function proposeFlagGraduations(opts: {
  backend: Backend;
  now: () => string;
  thresholdDaysByApp: Record<string, number>;
  // Per-app static prefix of the launch-flag naming pattern (e.g. "launch."). Only flags
  // matching it graduate; a permanent operational flag (region/tier gate) is left alone.
  launchFlagPrefixByApp?: Record<string, string>;
  log?: (message: string) => void;
}): Promise<Proposal[]> {
  const created: Proposal[] = [];
  const nowMs = Date.parse(opts.now());

  for (const id of await opts.backend.records.scanIds()) {
    const release = await opts.backend.records.read(id);
    if (!release || release.state !== "live" || !release.flag) continue;

    // Reserved auto-promote flags are operational continuous-deploy kill-switches, not launch
    // flags — never propose removing them (they govern the currently-live web version).
    if (release.flag.startsWith(AUTO_PROMOTE_PREFIX)) continue;

    // Graduate launch kill-switches only — never a permanent operational flag.
    const prefix = opts.launchFlagPrefixByApp?.[release.app];
    if (prefix && !release.flag.startsWith(prefix)) continue;

    // Use the LATEST live transition: after a rollback + re-flip (`live#2`) the stable
    // window is measured from the current live cycle, not the original go-live.
    const liveTransitions = release.transitions.filter((t) => t.to === "live");
    const liveTransition = liveTransitions[liveTransitions.length - 1];
    if (!liveTransition) continue;

    const threshold = opts.thresholdDaysByApp[release.app];
    if (threshold === undefined) continue;

    const ageDays = (nowMs - Date.parse(liveTransition.at)) / DAY_MS;
    if (ageDays < threshold) continue;

    const proposal: Proposal = {
      proposal_id: `prop_flagrm_${release.release_id}`,
      kind: "flag_removal",
      app: release.app,
      release_id: release.release_id,
      launch_id: release.launch_id,
      flag: release.flag,
      title: `Remove stale launch flag: ${release.flag}`,
      body:
        `${release.flag} has been live ${Math.floor(ageDays)} days ` +
        `(≥ ${threshold}-day graduation window). The launch is stable — propose removing ` +
        `the kill-switch and graduating the feature. Human approval required.`,
      status: "open",
      created_at: opts.now(),
    };

    const result = await proposeOnce(opts.backend.proposals, proposal);
    if (result.created) {
      created.push(result.proposal);
      opts.log?.(`[graduate] proposed removal of stale flag ${release.flag}`);
    }
  }

  return created;
}
