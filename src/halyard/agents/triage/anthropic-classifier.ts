import Anthropic from "@anthropic-ai/sdk";
import { z } from "zod";
import { RECOMMENDATIONS, SEVERITIES } from "../../contracts/proposal.schema.js";
import type { CrashSignal, TriageClassification, TriageClassifier } from "./types.js";

/**
 * Production triage classifier — the agent. Judgment under structure: it reads the crash
 * signal and returns a severity + recommended action + rationale. It is explicitly told
 * its output is a *proposal*, never an action (invariant #2). Model id from config
 * (claude-opus-4-8, verified).
 *
 * Live API call → not exercised by the test suite; the triage *flow* is verified with
 * the RuleTriageClassifier.
 */
const ClassificationOutput = z.object({
  severity: z.enum(SEVERITIES),
  recommendation: z.enum(RECOMMENDATIONS),
  rationale: z.string(),
});

const CLASSIFICATION_JSON_SCHEMA = {
  type: "object",
  properties: {
    severity: { type: "string", enum: [...SEVERITIES] },
    recommendation: { type: "string", enum: [...RECOMMENDATIONS] },
    rationale: { type: "string" },
  },
  required: ["severity", "recommendation", "rationale"],
  additionalProperties: false,
} as const;

export class AnthropicTriageClassifier implements TriageClassifier {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async classify(signal: CrashSignal): Promise<TriageClassification> {
    const system =
      "You triage mobile/web crash spikes for a release coordinator. Classify severity " +
      "and recommend exactly one action: flag_kill (only if a kill-switch flag exists), " +
      "hotfix, or ignore. You PROPOSE; a human decides and executes. Never imply you took " +
      "an action.";

    const user =
      `App: ${signal.app} / ${signal.surface} ${signal.version}\n` +
      `Crash-free users: ${signal.stats.crashFreePct}% (threshold ${signal.thresholdPct}%)\n` +
      `Events: ${signal.stats.eventCount}\n` +
      `Top issue: ${signal.stats.topIssueTitle}\n` +
      `Kill-switch flag available: ${signal.flag ? signal.flag : "none"}\n\n` +
      `Classify severity + recommended action with a one-line rationale.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 512,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { format: { type: "json_schema", schema: CLASSIFICATION_JSON_SCHEMA }, effort: "low" },
    });

    const textBlock = response.content.find((b) => b.type === "text");
    if (!textBlock || textBlock.type !== "text") {
      throw new Error("triage classification failed (no text output)");
    }
    return ClassificationOutput.parse(JSON.parse(textBlock.text));
  }
}
