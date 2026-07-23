import type { DraftRequest } from "./drafter.js";

/**
 * Builds the drafting prompt. Extracted as a pure function so the voice-canon feedback
 * loop (M8) is verifiable: approved posts passed in `request.voiceCanon` are injected
 * into the system prompt as style exemplars, which is what stops fresh drafts from
 * reading like generic AI launch copy.
 */
export function buildDraftPrompts(request: DraftRequest): { system: string; user: string } {
  const { launch, channel, channelClass, surface, voiceCanon } = request;

  const canon = voiceCanon.length
    ? `Match the brand voice in these APPROVED posts (these are the canon — emulate their ` +
      `rhythm, concreteness, and restraint; do not copy them verbatim):\n\n` +
      voiceCanon.map((p, i) => `[${i + 1}]\n${p}`).join("\n---\n")
    : "No prior approved posts yet — write in a crisp, concrete, non-hype developer-tool voice.";

  const system =
    `You draft launch announcements for Example. ${canon}\n` +
    `Owned channels (blog, email) can be longer; third-party social must be tight. ` +
    `Never invent facts beyond the narrative seed.`;

  const user =
    `Channel: ${channel} (${channelClass})\n` +
    (surface ? `Surface: ${surface}\n` : "") +
    `Launch: ${launch.title}\n` +
    `Narrative seed (why it matters): ${launch.narrative_seed}\n\n` +
    `Write a title and body for this channel.`;

  return { system, user };
}
