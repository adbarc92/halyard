import { afterEach, describe, expect, it, vi } from "vitest";
import type { CrashSignal } from "../src/halyard/agents/triage/types.js";

// Mock the Anthropic SDK so we exercise the parse/throw contract without a network call.
const { create } = vi.hoisted(() => ({ create: vi.fn() }));
vi.mock("@anthropic-ai/sdk", () => ({
  default: class {
    messages = { create };
  },
}));

import { AnthropicTriageClassifier } from "../src/halyard/agents/triage/anthropic-classifier.js";

const signal: CrashSignal = {
  app: "aurora", surface: "ios", version: "1.4.0", flag: "launch.aurora.offline_sync",
  thresholdPct: 99.5, stats: { crashFreePct: 92, eventCount: 9000, topIssueTitle: "NPE" },
};
const textResponse = (text: string) => ({ content: [{ type: "text", text }] });

afterEach(() => create.mockReset());

describe("AnthropicTriageClassifier output handling (model output is validated, never trusted raw)", () => {
  it("returns the parsed classification for well-formed structured output", async () => {
    create.mockResolvedValue(textResponse(JSON.stringify({ severity: "critical", recommendation: "flag_kill", rationale: "spike" })));
    const out = await new AnthropicTriageClassifier("claude-opus-4-8", "key").classify(signal);
    expect(out).toEqual({ severity: "critical", recommendation: "flag_kill", rationale: "spike" });
  });

  it("throws when the response has no text block (fails loud, no silent default)", async () => {
    create.mockResolvedValue({ content: [] });
    await expect(new AnthropicTriageClassifier("claude-opus-4-8", "key").classify(signal)).rejects.toThrow(/no text output/);
  });

  it("throws when the model returns a value outside the allowed enum", async () => {
    create.mockResolvedValue(textResponse(JSON.stringify({ severity: "apocalyptic", recommendation: "nuke", rationale: "x" })));
    await expect(new AnthropicTriageClassifier("claude-opus-4-8", "key").classify(signal)).rejects.toThrow();
  });
});
