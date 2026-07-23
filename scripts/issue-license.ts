/**
 * Issue a Halyard Pro license (vendor side). Requires the Ed25519 private key that matches
 * the verifier in src/halyard/licensing/license.ts (or whatever HALYARD_LICENSE_PUBKEY is
 * set to in the deployment). The private key is NEVER committed — keep it offline.
 *
 *   HALYARD_LICENSE_PRIVATE_KEY="$(cat halyard-license.key)" \
 *     npm run issue:license -- --licensee "Acme Inc" [--features ai-agents,auto-merge,multi-app] [--expires 2027-01-01]
 *   # or: npm run issue:license -- --licensee "Acme Inc" --key-file ./halyard-license.key
 *
 * Prints the license token (stdout) — the customer sets it as HALYARD_LICENSE_KEY.
 */
import { readFileSync } from "node:fs";
import { parseFlags, requireFlag } from "../src/halyard/cli-args.js";
import { issueLicense, PRO_FEATURES, type LicensePayload } from "../src/halyard/licensing/index.js";

function main(): number {
  const flags = parseFlags(process.argv.slice(2));
  const licensee = requireFlag(flags, "licensee");
  const features = flags.features
    ? flags.features.split(",").map((s) => s.trim()).filter(Boolean)
    : [...PRO_FEATURES];

  const privateKeyPem = flags["key-file"]
    ? readFileSync(flags["key-file"], "utf8")
    : process.env.HALYARD_LICENSE_PRIVATE_KEY;
  if (!privateKeyPem) {
    console.error("provide the signing key via --key-file <path> or HALYARD_LICENSE_PRIVATE_KEY");
    return 2;
  }

  const payload: LicensePayload = {
    licensee,
    tier: "pro",
    features,
    issued: new Date().toISOString(),
    ...(flags.expires ? { expires: new Date(flags.expires).toISOString() } : {}),
  };

  const token = issueLicense(payload, privateKeyPem);
  console.error(
    `issued Pro license for "${licensee}" — features: ${features.join(", ")}; ` +
      `${payload.expires ? `expires ${payload.expires}` : "perpetual"}`,
  );
  console.log(token);
  return 0;
}

try {
  process.exit(main());
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
