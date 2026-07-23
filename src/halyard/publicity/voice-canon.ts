import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

/**
 * Read the approved-post corpus (the voice canon) that steers drafting. M5 reads it;
 * M8 closes the loop by appending approved posts back into this directory.
 */
export function readVoiceCanon(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".md") || f.endsWith(".txt"))
    .sort()
    .map((f) => readFileSync(join(dir, f), "utf8").trim())
    .filter(Boolean);
}
