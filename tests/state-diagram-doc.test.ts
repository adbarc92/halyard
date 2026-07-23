import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { LEGAL_TRANSITIONS } from "../src/halyard/coordinator/state-machine.js";
import { RELEASE_STATES, type ReleaseState } from "../src/halyard/contracts/state.js";

/**
 * The README carries a Mermaid state diagram of the release machine. A diagram that can drift
 * from the code is worse than no diagram — so this test parses the diagram out of the README
 * and asserts, edge for edge, that it is exactly `LEGAL_TRANSITIONS`. If someone adds or removes
 * a legal edge in code without updating the picture (or vice-versa), CI goes red.
 */

const here = dirname(fileURLToPath(import.meta.url));
const README = readFileSync(resolve(here, "..", "README.md"), "utf8");

/** Pull the single ```mermaid stateDiagram-v2 fenced block out of the README. */
function extractMermaidStateDiagram(md: string): string {
  const blocks = [...md.matchAll(/```mermaid\s*([\s\S]*?)```/g)].map((m) => m[1]!);
  const stateBlocks = blocks.filter((b) => /stateDiagram/.test(b));
  if (stateBlocks.length !== 1) {
    throw new Error(`expected exactly one mermaid stateDiagram block in README, found ${stateBlocks.length}`);
  }
  return stateBlocks[0]!;
}

/** Parse `a --> b` edges (ignoring the `[*]` start/terminal pseudo-states and any `: label`). */
function parseEdges(diagram: string): Array<[string, string]> {
  const edges: Array<[string, string]> = [];
  for (const line of diagram.split("\n")) {
    const m = line.match(/^\s*(\S+)\s*-->\s*(\S+?)(?:\s*:.*)?\s*$/);
    if (!m) continue;
    const [, from, to] = m;
    if (from === "[*]" || to === "[*]") continue; // start / terminal markers, not real states
    edges.push([from!, to!]);
  }
  return edges;
}

/** Turn the parsed edges into the same shape as LEGAL_TRANSITIONS (sorted, deduped). */
function edgesToMap(edges: Array<[string, string]>): Record<string, string[]> {
  const map: Record<string, Set<string>> = {};
  for (const s of RELEASE_STATES) map[s] = new Set(); // every state present, even terminal `dead`
  for (const [from, to] of edges) {
    if (!map[from]) throw new Error(`diagram references unknown source state: ${from}`);
    if (!(RELEASE_STATES as readonly string[]).includes(to)) {
      throw new Error(`diagram references unknown target state: ${to}`);
    }
    map[from]!.add(to);
  }
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [k, [...v].sort()]));
}

function legalTransitionsAsSortedMap(): Record<string, string[]> {
  return Object.fromEntries(
    (Object.keys(LEGAL_TRANSITIONS) as ReleaseState[]).map((from) => [from, [...LEGAL_TRANSITIONS[from]].sort()]),
  );
}

describe("README state diagram matches the code", () => {
  it("every Mermaid edge is a legal transition, and every legal transition is drawn", () => {
    const diagram = extractMermaidStateDiagram(README);
    const fromDiagram = edgesToMap(parseEdges(diagram));
    const fromCode = legalTransitionsAsSortedMap();
    expect(fromDiagram).toEqual(fromCode);
  });

  it("the diagram covers every release state (start + terminal markers present)", () => {
    const diagram = extractMermaidStateDiagram(README);
    for (const state of RELEASE_STATES) {
      expect(diagram).toContain(state);
    }
    expect(diagram).toMatch(/\[\*\]\s*-->\s*tagged/); // documents the entry state
    expect(diagram).toMatch(/dead\s*-->\s*\[\*\]/); // documents the terminal state
  });
});
