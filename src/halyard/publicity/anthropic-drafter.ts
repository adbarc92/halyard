import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { ChannelDraft, DraftRequest, Drafter } from "./drafter.js";
import { buildDraftPrompts } from "./draft-prompt.js";

/**
 * Production drafter using the Anthropic SDK. Model id comes from config
 * (drafting.model — verified as `claude-opus-4-8`, the current Opus 4.8 id). The voice
 * canon (approved posts) steers style; M8 closes the loop by feeding approved posts
 * back in here.
 *
 * NOTE: this makes a live API call and is therefore not exercised by the test suite —
 * the publicity *logic* (gating, fan-out, staging) is verified with TemplateDrafter.
 * The drafter only ever returns text; it never publishes (invariant #2).
 */

const DraftOutput = z.object({ title: z.string(), body: z.string() });

// Structured-output schema (raw JSON Schema — avoids coupling to a zod major version).
const DRAFT_JSON_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

export class AnthropicDrafter implements Drafter {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async draft(request: DraftRequest): Promise<ChannelDraft> {
    const { channel, surface } = request;
    const { system, user } = buildDraftPrompts(request);

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      // Simple short-copy task → low effort keeps cost down; json_schema guarantees shape.
      output_config: { format: { type: "json_schema", schema: DRAFT_JSON_SCHEMA }, effort: "low" },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error(`drafting failed for channel ${channel} (no text output)`);
    }
    const parsed = DraftOutput.parse(JSON.parse(textBlock.text));
    return { channel, surface, title: parsed.title, body: parsed.body };
  }
}
