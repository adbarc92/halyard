import { afterEach, describe, expect, it } from "vitest";
import { envSecretStore, resolveSecret, setSecretStore, tryResolveSecret } from "../src/halyard/secrets/resolve.js";
import { SecretRefSchema } from "../src/halyard/config/secret-ref.js";

afterEach(() => setSecretStore(envSecretStore)); // restore the default for any later test

describe("SecretStore port (a hub can inject its own backend)", () => {
  it("resolveSecret reads from the injected store instead of the environment", () => {
    setSecretStore({ get: (n) => (n === "VAULT_KEY" ? "from-vault" : undefined) });
    expect(resolveSecret(SecretRefSchema.parse("SECRET:VAULT_KEY"))).toBe("from-vault");
    expect(tryResolveSecret(SecretRefSchema.parse("SECRET:MISSING"))).toBeUndefined();
    expect(() => resolveSecret(SecretRefSchema.parse("SECRET:MISSING"))).toThrow(/secret store/);
  });
});
