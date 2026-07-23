import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

/**
 * Per-launch publicity ledger: which announcement scopes have already fired. This is
 * what makes the publicity trigger idempotent across reconcile passes — a surface (or a
 * launch) is announced exactly once.
 */
interface Ledger {
  launch_id: string;
  announced: string[];
}

function ledgerPath(stateDir: string, launchId: string): string {
  return join(stateDir, "publicity", "ledgers", `${launchId}.json`);
}

export function readAnnounced(stateDir: string, launchId: string): Set<string> {
  const path = ledgerPath(stateDir, launchId);
  if (!existsSync(path)) return new Set();
  const ledger = JSON.parse(readFileSync(path, "utf8")) as Ledger;
  return new Set(ledger.announced);
}

export function markAnnounced(stateDir: string, launchId: string, scopeKey: string): void {
  const announced = readAnnounced(stateDir, launchId);
  if (announced.has(scopeKey)) return;
  announced.add(scopeKey);
  const path = ledgerPath(stateDir, launchId);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(
    path,
    JSON.stringify({ launch_id: launchId, announced: [...announced] }, null, 2) + "\n",
    "utf8",
  );
}
