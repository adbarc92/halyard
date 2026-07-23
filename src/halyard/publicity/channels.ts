import type { Tier } from "../config/org-config.schema.js";
import { z } from "zod";
import { OrgConfigSchema } from "../config/org-config.schema.js";

/** A single channel entry from the org registry (class + gate + publish + requires_tier). */
export type ChannelConfig = z.infer<typeof OrgConfigSchema>["channels"][string];

/**
 * The publicity safety boundary (invariant #5), as a pure deterministic gate. Only an
 * OWNED channel with an `auto` gate and an `http` publish target may auto-publish.
 * Everything else — every third-party channel, always — only STAGES into the approval
 * queue. There is no path here that auto-posts to a third-party API. A model is never
 * consulted.
 */
export type ChannelAction =
  | { kind: "auto_publish" }
  | { kind: "stage" }
  | { kind: "skip"; reason: string };

export function channelAction(channel: ChannelConfig, launchTier: Tier): ChannelAction {
  if (channel.requires_tier && channel.requires_tier !== launchTier) {
    return { kind: "skip", reason: `requires tier "${channel.requires_tier}" (launch is "${launchTier}")` };
  }

  const isOwnedAuto =
    channel.class === "owned" && channel.gate === "auto" && channel.publish.type === "http";

  // Defense in depth: even if config somehow slipped a third_party channel past the
  // schema, this gate refuses to auto-publish it.
  if (isOwnedAuto && channel.class === "owned") {
    return { kind: "auto_publish" };
  }
  return { kind: "stage" };
}
