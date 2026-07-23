import type { Surface } from "../config/primitives.js";
import type { ChannelClass } from "../config/org-config.schema.js";
import type { Launch } from "../contracts/launch.schema.js";

/**
 * Drafting port. An agent (or a deterministic template) drafts channel variants from
 * the launch's narrative_seed. Per invariant #2 the drafter only ever produces text —
 * it never decides whether to publish; the deterministic gate does that.
 */

export interface DraftRequest {
  launch: Launch;
  channel: string;
  channelClass: ChannelClass;
  surface?: Surface | undefined;
  /** Approved-post corpus (the voice canon) used to steer style. Empty until M8 fills it. */
  voiceCanon: string[];
}

export interface ChannelDraft {
  channel: string;
  surface?: Surface | undefined;
  title: string;
  body: string;
}

export interface Drafter {
  draft(request: DraftRequest): Promise<ChannelDraft>;
}
