import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The voice canon (M8): the accreting corpus of APPROVED posts that is the brand-voice
 * moat. When a third-party draft is approved, its final copy is appended here; the
 * drafter reads it back on the next launch. Closing this loop is what makes successive
 * drafts stop reading like generic AI launch copy.
 */
export interface CanonEntry {
  id: string;
  channel?: string | undefined;
  text: string;
  approvedAt: string;
}

export function canonEntryPath(canonDir: string, id: string): string {
  return join(canonDir, `${id}.md`);
}

/** Append an approved post to the canon. Idempotent on the entry id. */
export function appendToCanon(canonDir: string, entry: CanonEntry): boolean {
  const path = canonEntryPath(canonDir, entry.id);
  if (existsSync(path)) return false;
  mkdirSync(canonDir, { recursive: true });
  const header = `<!-- approved post${entry.channel ? ` · ${entry.channel}` : ""} · ${entry.approvedAt} -->\n`;
  writeFileSync(path, header + entry.text.trim() + "\n", "utf8");
  return true;
}
