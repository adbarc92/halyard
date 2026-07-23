/**
 * Live smoke test — flag provider WRITE access (preflight only *reads*). Against the
 * configured live provider for an app, it flips a sentinel flag ON then OFF and confirms each
 * read-back, leaving it OFF. Run once real flag credentials are in the environment. It only
 * ever touches a `smoke.<slug>.__roundtrip__` sentinel — never a launch flag.
 *
 *   AURORA_FLAG_PROVIDER_KEY=... npm run smoke:flags -- --app aurora
 *
 * Exit 0 = the round-trip reflected the writes. (The provider has no delete in the generic
 * client, so remove the sentinel flag in the provider UI afterwards.)
 */
import { resolve } from "node:path";
import { parseFlags, requireFlag } from "../../src/halyard/cli-args.js";
import { loadAppConfig } from "../../src/halyard/config/loader.js";
import { HttpFlagClient } from "../../src/halyard/flags/http-client.js";
import { tryResolveSecret } from "../../src/halyard/secrets/resolve.js";

async function main(): Promise<number> {
  const flags = parseFlags(process.argv.slice(2));
  const slug = requireFlag(flags, "app");
  const app = loadAppConfig(resolve(`apps/${slug}/app.yml`));

  const baseUrl = app.flags.api_url;
  const token = tryResolveSecret(app.flags.api_key_ref);
  if (!baseUrl || !token) {
    console.error(`flags not configured for ${slug} (need flags.api_url + the api_key_ref secret in env)`);
    return 2;
  }

  const client = new HttpFlagClient({ baseUrl, token });
  const key = `smoke.${slug}.__roundtrip__`;
  console.error(`probing ${key} against ${baseUrl} ...`);

  await client.ensureFlag(key);
  await client.setState(key, true);
  const on = await client.getState(key);
  await client.setState(key, false);
  const off = await client.getState(key);

  const ok = on === "on" && off === "off";
  console.log(JSON.stringify({ app: slug, key, on, off, ok }, null, 2));
  if (!ok) {
    console.error("FAIL: the round-trip did not reflect the writes");
    return 1;
  }
  console.error("PASS: flag write+read round-trip works (sentinel left OFF; delete it in the provider UI)");
  return 0;
}

main()
  .then((code) => process.exit(code))
  .catch((err) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
