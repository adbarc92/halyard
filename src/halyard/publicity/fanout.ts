import type { OrgConfig } from "../config/org-config.schema.js";
import type { Launch } from "../contracts/launch.schema.js";
import type { Proposal } from "../contracts/proposal.schema.js";
import { proposeOnce } from "../coordinator/proposals.js";
import type { Backend } from "../coordinator/ports.js";
import type { Announcement } from "./announce-policy.js";
import { scopeKey } from "./announce-policy.js";
import { channelAction } from "./channels.js";
import type { Drafter } from "./drafter.js";
import type { Notifier } from "./notify.js";
import type { Publisher } from "./publishers.js";

/**
 * Fan a single announcement out across the launch's enabled channels. Owned channels
 * that pass the gate auto-publish; third-party channels stage a proposal into the
 * approval queue and push a notification to the mobile surface. The owned-vs-third-party
 * boundary (invariant #5) lives entirely in `channelAction` — this orchestrator just
 * routes on its verdict and never calls a publisher for a staged channel.
 */
export interface ChannelOutcome {
  channel: string;
  action: "published" | "staged" | "skipped";
  detail?: string | undefined;
  proposal_id?: string | undefined;
  /** A skip that may succeed on a later pass (e.g. a channel temporarily missing from the
   *  org registry). It keeps the scope pending so the channel is retried, not dropped. A
   *  permanent skip (tier gate) and an already-announced no-op are NOT retryable. */
  retryable?: boolean | undefined;
}

export interface FanoutResult {
  launch_id: string;
  scope: string;
  outcomes: ChannelOutcome[];
  /** True when no channel was left in a retryable-skip state; the trigger marks the scope
   *  announced only then, so a transient failure doesn't permanently suppress a channel. */
  complete: boolean;
}

export interface FanoutDeps {
  org: OrgConfig;
  enabledChannels: string[];
  drafter: Drafter;
  publisher: Publisher;
  notifier: Notifier;
  voiceCanon: string[];
  backend: Backend;
  now: () => string;
  /** Per-(scope, channel) keys already announced — the replay guard. Each successful
   *  channel writes its key through immediately so a re-run never re-publishes/re-stages. */
  alreadyAnnounced: Set<string>;
  log?: (message: string) => void;
}

export async function fanOutAnnouncement(
  announcement: Announcement,
  launch: Launch,
  deps: FanoutDeps,
): Promise<FanoutResult> {
  const log = deps.log ?? (() => {});
  const outcomes: ChannelOutcome[] = [];
  const sk = scopeKey(announcement);
  const channelKey = (c: string) => `${sk}::${c}`;
  // Write a channel's key the instant it succeeds, so a crash (or a later channel throwing)
  // mid-fan-out never re-publishes/re-stages the channels that already fired on replay. The
  // scope-level key is written separately by the trigger once the whole fan-out completes.
  const markChannel = async (c: string): Promise<void> => {
    const key = channelKey(c);
    await deps.backend.ledger.markAnnounced(launch.launch_id, key);
    deps.alreadyAnnounced.add(key);
  };

  for (const channelName of deps.enabledChannels) {
    // Replay guard: this (scope, channel) already fired on a prior pass → no-op.
    if (deps.alreadyAnnounced.has(channelKey(channelName))) {
      outcomes.push({ channel: channelName, action: "skipped", detail: "already announced" });
      continue;
    }

    const channel = deps.org.channels[channelName];
    if (!channel) {
      // Config error that may be fixed → retryable; keeps the scope pending.
      outcomes.push({ channel: channelName, action: "skipped", detail: "not in org registry", retryable: true });
      continue;
    }

    const action = channelAction(channel, launch.tier);
    if (action.kind === "skip") {
      // Permanent (e.g. tier gate) — not retryable; doesn't block scope completion.
      outcomes.push({ channel: channelName, action: "skipped", detail: action.reason });
      continue;
    }

    // Isolate per-channel failures the way the reconcile engine isolates per-source: a drafter
    // or live-publisher throw (LLM hiccup, 5xx, timeout) becomes a RETRYABLE skip — the channel
    // isn't marked announced, the scope stays incomplete, and the sibling channels plus the rest
    // of the cycle (triage, rejections, self-heal) still run. The channel is retried next pass.
    try {
      const draft = await deps.drafter.draft({
        launch,
        channel: channelName,
        channelClass: channel.class,
        surface: announcement.surface,
        voiceCanon: deps.voiceCanon,
      });

      if (action.kind === "auto_publish") {
        // Reachable only for owned http channels (enforced by channelAction).
        if (channel.publish.type !== "http") {
          throw new Error(`internal: auto_publish for non-http channel ${channelName}`);
        }
        const result = await deps.publisher.publish(channelName, draft, channel.publish.endpoint_ref);
        await markChannel(channelName);
        outcomes.push({ channel: channelName, action: "published", detail: result.url });
        log(`[publicity] ${launch.launch_id}: auto-published ${channelName}`);
      } else {
        // Third-party (or any non-auto): stage a proposal + notify. NEVER auto-posted.
        const proposal = socialProposal(launch, channelName, announcement, draft.title, draft.body, deps.now());
        const { created, proposal: stored } = await proposeOnce(deps.backend.proposals, proposal);
        if (created) await deps.notifier.notify(stored);
        await markChannel(channelName);
        outcomes.push({ channel: channelName, action: "staged", proposal_id: stored.proposal_id });
        log(`[publicity] ${launch.launch_id}: staged ${channelName} → ${stored.proposal_id}`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      outcomes.push({ channel: channelName, action: "skipped", detail: `failed: ${detail}`, retryable: true });
      log(`[publicity] ${launch.launch_id}: ${channelName} failed (retryable) — ${detail}`);
    }
  }

  const complete = !outcomes.some((o) => o.retryable === true);
  return { launch_id: launch.launch_id, scope: announcement.scope, outcomes, complete };
}

function socialProposal(
  launch: Launch,
  channel: string,
  announcement: Announcement,
  title: string,
  body: string,
  createdAt: string,
): Proposal {
  const scope = announcement.surface ?? "launch";
  return {
    proposal_id: `prop_post_${launch.launch_id}_${channel}_${scope}`,
    kind: "social_post",
    app: launch.app,
    launch_id: launch.launch_id,
    channel,
    ...(announcement.surface ? { surface: announcement.surface } : {}),
    title: `Post to ${channel}: ${title}`,
    body,
    status: "open",
    created_at: createdAt,
  };
}
