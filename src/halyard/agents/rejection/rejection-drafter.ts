import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import type { Release } from "../../contracts/release.schema.js";

/**
 * Rejection-response drafter (M6). When a store rejects a build, an agent drafts a
 * response to the reviewer (what was addressed / why to reconsider). It only drafts into
 * the queue — a human edits and sends; nothing is submitted automatically (invariant #2).
 */
export interface RejectionResponse {
  title: string;
  body: string;
}

export interface RejectionDrafter {
  draft(release: Release): Promise<RejectionResponse>;
}

/** Deterministic template drafter — default for local/tests. */
export class TemplateRejectionDrafter implements RejectionDrafter {
  async draft(release: Release): Promise<RejectionResponse> {
    const reason = String(release.external_refs.review_status ?? "rejected");
    return {
      title: `Response to ${release.surface} review (${release.version})`,
      body:
        `Thank you for the review of ${release.app} ${release.version} (${release.surface}).\n\n` +
        `Re: ${reason}. We have reviewed the feedback and will address the cited items. ` +
        `[Draft — edit before sending. Halyard does not submit this for you.]`,
    };
  }
}

const ResponseOutput = z.object({ title: z.string(), body: z.string() });
const RESPONSE_JSON_SCHEMA = {
  type: "object",
  properties: { title: { type: "string" }, body: { type: "string" } },
  required: ["title", "body"],
  additionalProperties: false,
} as const;

/** Production drafter — the agent. Live API call; not exercised by the suite. */
export class AnthropicRejectionDrafter implements RejectionDrafter {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async draft(release: Release): Promise<RejectionResponse> {
    const reason = String(release.external_refs.review_status ?? "rejected");
    const system =
      "You draft professional, concise responses to App Store / Play review rejections " +
      "for a developer-tools shop. You draft only; a human edits and submits. Never claim " +
      "to have submitted anything.";
    const user =
      `App: ${release.app} ${release.version} (${release.surface})\n` +
      `Rejection context: ${reason}\n\n` +
      `Draft a title and body for a response to the reviewer.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: RESPONSE_JSON_SCHEMA }, effort: "low" },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("rejection draft failed (no text output)");
    }
    return ResponseOutput.parse(JSON.parse(textBlock.text));
  }
}
