import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { FlagClient, FlagState } from "./types.js";

/**
 * A git-backed flag provider: flag state lives as JSON under `state/flags/`, consistent
 * with the git-backed coordinator. This is the default/local provider and the one the
 * tests + `halyard flip` exercise. For a real remote-config provider (LaunchDarkly,
 * etc.) the same `FlagClient` port is implemented against the provider's API with creds
 * from the secret store — swapped in via config without touching the poll logic.
 */
export class FlagFileClient implements FlagClient {
  constructor(
    private readonly stateDir: string,
    private readonly now: () => string = () => new Date().toISOString(),
  ) {}

  private path(flagKey: string): string {
    return join(this.stateDir, "flags", `${flagKey}.json`);
  }

  private read(flagKey: string): { key: string; on: boolean; created_at: string } | null {
    const p = this.path(flagKey);
    if (!existsSync(p)) return null;
    return JSON.parse(readFileSync(p, "utf8"));
  }

  private write(flagKey: string, on: boolean, createdAt: string): void {
    const p = this.path(flagKey);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(
      p,
      JSON.stringify({ key: flagKey, on, created_at: createdAt, updated_at: this.now() }, null, 2) + "\n",
      "utf8",
    );
  }

  async getState(flagKey: string): Promise<FlagState> {
    const f = this.read(flagKey);
    if (!f) return "absent";
    return f.on ? "on" : "off";
  }

  async ensureFlag(flagKey: string): Promise<void> {
    if (this.read(flagKey)) return; // idempotent
    this.write(flagKey, false, this.now()); // born OFF
  }

  async setState(flagKey: string, on: boolean): Promise<void> {
    const existing = this.read(flagKey);
    this.write(flagKey, on, existing?.created_at ?? this.now());
  }
}
