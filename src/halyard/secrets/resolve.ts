import { secretName, type SecretRef } from "../config/secret-ref.js";

/**
 * The secret store: the single collaborator that turns a `SECRET:NAME` reference into a
 * value (invariant #4). It is a port so an embedding hub can supply its own backend
 * (Vault, 1Password, AWS Secrets Manager) instead of the process environment — values
 * still live only in memory, never on disk or in logs.
 */
export interface SecretStore {
  /** Return the secret value for `name`, or undefined/empty if absent. */
  get(name: string): string | undefined;
}

/** Default store: the process environment (populated from GitHub Actions secrets / env). */
export const envSecretStore: SecretStore = {
  get: (name) => process.env[name],
};

let activeStore: SecretStore = envSecretStore;

/**
 * Install a custom secret store. Affects every subsequent resolveSecret/tryResolveSecret
 * call; call once at startup. A library consumer that keeps secrets in its own vault wires
 * it here instead of populating process.env.
 */
export function setSecretStore(store: SecretStore): void {
  activeStore = store;
}

/**
 * Resolve a `SECRET:NAME` reference to its value at runtime, from the active secret store.
 * This is the single chokepoint where a reference becomes a value (invariant #4).
 */
export function resolveSecret(ref: SecretRef): string {
  const name = secretName(ref);
  const value = activeStore.get(name);
  if (value === undefined || value === "") {
    throw new Error(`secret ${name} is not set in the secret store`);
  }
  return value;
}

/** Resolve if present; return undefined instead of throwing (for optional integrations). */
export function tryResolveSecret(ref: SecretRef): string | undefined {
  const value = activeStore.get(secretName(ref));
  return value === undefined || value === "" ? undefined : value;
}
