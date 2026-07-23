import Anthropic from "@anthropic-ai/sdk";
import type { CommandRunner } from "../../surfaces/types.js";

/**
 * Narrative-seed drafting agent (design §3). A changelog says *what changed*; the
 * narrative seed says *why it matters*. An agent drafts a first seed from the recent
 * changes and a human edits it — the seed is the single highest-value human input, so
 * this only ever produces a starting draft, never the final word.
 *
 * As elsewhere: a deterministic template implementation backs local/test use; the
 * Anthropic implementation (live API) is the production agent and isn't exercised by the
 * suite.
 */
export interface NarrativeInput {
  app: string;
  feature: string;
  title: string;
  /** Recent change summaries (Conventional Commit subjects) — the "diff" we draft from. */
  changes: string[];
}

export interface NarrativeDrafter {
  draft(input: NarrativeInput): Promise<string>;
}

// `type(scope)!: summary` → `summary`.
const CONVENTIONAL = /^[a-z]+(\([^)]+\))?!?:\s/;
function stripType(subject: string): string {
  return subject.replace(CONVENTIONAL, "").trim();
}

/** Gather recent Conventional Commit subjects from the working tree (best-effort). */
export async function collectRecentCommits(
  runner: CommandRunner,
  workdir: string,
  limit = 20,
): Promise<string[]> {
  const res = await runner.run(`git log -n ${limit} --no-merges --pretty=format:%s`, { cwd: workdir });
  if (res.exitCode !== 0) return [];
  return res.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => CONVENTIONAL.test(s));
}

/** Deterministic drafter — the default for local runs and tests. */
export class TemplateNarrativeDrafter implements NarrativeDrafter {
  async draft(input: NarrativeInput): Promise<string> {
    const highlights = input.changes.filter((c) => /^feat/.test(c));
    const picks = (highlights.length > 0 ? highlights : input.changes).slice(0, 3).map(stripType);
    if (picks.length === 0) return `${input.title} ships for ${input.app}.`;
    return `${input.title}: ${picks.join("; ")}.`;
  }
}

/** Production drafter — the agent. Live API call; not exercised by the suite. */
export class AnthropicNarrativeDrafter implements NarrativeDrafter {
  private readonly client: Anthropic;

  constructor(
    private readonly model: string,
    apiKey: string,
  ) {
    this.client = new Anthropic({ apiKey });
  }

  async draft(input: NarrativeInput): Promise<string> {
    const system =
      "You draft the one-sentence 'narrative seed' for a product launch — WHY this matters " +
      "to users, not a changelog of what changed. Concrete, specific, no hype. Output the " +
      "seed sentence only, nothing else. A human will edit it.";
    const user =
      `App: ${input.app}\nLaunch: ${input.title} (feature: ${input.feature})\n` +
      `Recent changes:\n${input.changes.map((c) => `- ${c}`).join("\n") || "(none)"}\n\n` +
      `Write the narrative seed.`;

    const response = await this.client.messages.create({
      model: this.model,
      max_tokens: 256,
      system,
      messages: [{ role: "user", content: user }],
      output_config: { effort: "low" },
    });
    const text = response.content.find((b) => b.type === "text");
    if (!text || text.type !== "text") {
      throw new Error("narrative drafting failed (no text output)");
    }
    return text.text.trim();
  }
}
