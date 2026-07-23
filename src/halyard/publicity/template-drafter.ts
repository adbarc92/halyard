import type { ChannelDraft, DraftRequest, Drafter } from "./drafter.js";

/**
 * Deterministic, no-API drafter — the default for local runs and the one the tests
 * exercise. It produces a plausible variant from the narrative seed without a model
 * call, so the publicity spine is verifiable without network access. Production swaps
 * in the AnthropicDrafter behind the same port.
 */
export class TemplateDrafter implements Drafter {
  async draft(request: DraftRequest): Promise<ChannelDraft> {
    const { launch, channel, surface } = request;
    const where = surface ? ` (${surface})` : "";
    const title = `${launch.title}${where}`;
    const body =
      channel === "x"
        ? `${launch.narrative_seed} ${launch.title} is live.`
        : `${launch.title} is live.\n\n${launch.narrative_seed}`;
    return { channel, surface, title, body };
  }
}
