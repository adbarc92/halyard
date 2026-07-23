/**
 * Flag provider port. Truth about a flag lives in the provider (invariant #1); the
 * coordinator only ever reads it to project `live`/`rolled_back`, or writes it as the
 * explicit human flip. Launch flags are born OFF.
 */
export type FlagState = "on" | "off" | "absent";

export interface FlagClient {
  /** Current state, or `absent` if the flag does not exist yet. */
  getState(flagKey: string): Promise<FlagState>;
  /** Create the flag OFF if it does not exist (launch flags are born OFF). Idempotent. */
  ensureFlag(flagKey: string): Promise<void>;
  /** Flip the flag. This is the human gate action — never called by an agent. */
  setState(flagKey: string, on: boolean): Promise<void>;
}
