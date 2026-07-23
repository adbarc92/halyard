/**
 * `npm run demo` — a full, hands-on local end-to-end run with NO accounts and nothing
 * published. It drives the REAL spine (real web build → local_dir deploy → reconcile → live →
 * publicity) in a throwaway temp dir, using a demo app config that lives outside apps/ (so the
 * example repo stays single-app). Each step prints the equivalent `halyard` CLI command, so it
 * doubles as a guided tour. `--keep` leaves the temp dirs for inspection.
 *
 * This is the "as close to a real launch as you can get on your machine" check — distinct from
 * `npm run verify:launch` (which fakes the build/ASC); here the web adapter, flag client,
 * publisher, notifier, and reconcile are all the real implementations, writing real artifacts.
 */
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AppConfig, CommandResult, CommandRunner } from "../src/halyard/index.js";
import {
  loadOrgConfig,
  loadAppConfig,
  runRelease,
  ShellCommandRunner,
  newLaunch,
  writeLaunch,
  linkRelease,
  bindReleaseToLaunch,
  writeRelease,
  readRelease,
  reconcile,
  flagPollSource,
  FlagFileClient,
  flagKeyFor,
  firePublicity,
  TemplateDrafter,
  FilePublisher,
  readPublished,
  FileNotifier,
  summarizeRelease,
  listProposals,
  makeGitBackend,
} from "../src/halyard/index.js";

const keep = process.argv.includes("--keep");
const now = () => new Date().toISOString();
let n = 0;
function step(title: string, cli: string): void {
  console.log(`\n${++n}. ${title}\n   $ ${cli}`);
}

async function main(): Promise<void> {
  const stateDir = mkdtempSync(join(tmpdir(), "halyard-demo-state-"));
  const workdir = mkdtempSync(join(tmpdir(), "halyard-demo-work-"));
  // The no-op web "build": emit a single file into dist/ (stands in for a real build).
  writeFileSync(
    join(workdir, "build.mjs"),
    'import{mkdirSync,writeFileSync}from"node:fs";mkdirSync("dist",{recursive:true});' +
      'writeFileSync("dist/index.html","<!doctype html><meta charset=utf-8><h1>Halyard demo</h1>\\n");' +
      'console.log("built dist/index.html");\n',
  );

  console.log(`Halyard demo — full local end-to-end (no accounts, nothing published)`);
  console.log(`  state: ${stateDir}\n  work:  ${workdir}`);

  const org = loadOrgConfig(resolve("halyard.config.yml"));
  const app = loadAppConfig(resolve("scripts/demo-app.yml"));
  const flag = flagKeyFor(app.flags.naming, app.app.slug, "beta");
  const backend = makeGitBackend({ stateDir });

  // 1. Release run — the real web adapter: build (node build.mjs) → test gate → local_dir deploy.
  step("Release: build → test gate → deploy (lands at `uploaded`)",
    "halyard release run --app demo --surface web --version 1.0.0 --commit 0000000 --workdir <dir>");
  let release = await runRelease({
    app, surface: "web", version: "1.0.0", commit: "0000000",
    backend, workdir, runner: new ShellCommandRunner(), now,
  });
  console.log(`   → ${release.release_id}: ${release.state}  (preview ${release.external_refs.preview_url})`);

  // 2. Create the launch — the flag is born OFF.
  step("Create the launch (flag born OFF)",
    'halyard launch create --app demo --feature beta --title "Beta launch"');
  const launch = newLaunch({
    app: app.app.slug, feature: "beta", title: "Beta launch", narrativeSeed: "Works offline.",
    announcePolicy: "per_surface", tier: "standard", flag, createdBy: "demo", createdAt: now(),
  });
  writeLaunch(stateDir, launch);
  const flagClient = new FlagFileClient(stateDir, now);
  await flagClient.ensureFlag(flag);
  console.log(`   → ${launch.launch_id}: flag ${flag} = ${await flagClient.getState(flag)}`);

  // 3. Link the release to the launch.
  step("Link the release to the launch",
    `halyard launch link --launch ${launch.launch_id} --release ${release.release_id}`);
  release = bindReleaseToLaunch(release, launch);
  writeRelease(stateDir, release);
  writeLaunch(stateDir, linkRelease(launch, release.release_id));
  console.log(`   → linked; waiting on the flag flip`);

  // 4. The launch moment — flip the flag ON.
  step("Flip the flag ON (the launch moment)",
    `halyard flip --flag ${flag} --state on --app demo`);
  await flagClient.setState(flag, true);
  console.log(`   → ${flag} = on`);

  // 5. Reconcile — projects the flip to `live`.
  step("Reconcile — projects the flip to `live`", "halyard reconcile --apps demo");
  await reconcile({ backend, sources: [flagPollSource(flagClient)], now });
  const live = readRelease(stateDir, release.release_id)!;
  console.log(`   → ${live.release_id}: ${live.state}`);

  // 6. Publicity fires on `live`: owned auto-publishes, third-party stages.
  step("Publicity fan-out (fires on `live`)", "(runs inside `halyard reconcile`)");
  const fanout = await firePublicity({
    org, apps: [app], drafter: new TemplateDrafter(),
    publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
    voiceCanon: [], backend, now,
  });
  console.log(`   → ${fanout.length} announcement(s) fanned out`);

  // 7. Inspect the result.
  step("Status + approval queue", "halyard status   /   halyard queue");
  const s = summarizeRelease(readRelease(stateDir, release.release_id)!, now());
  console.log(`   status:    ${s.release_id} → ${s.state} | waiting_on: ${s.waiting_on}`);
  const published = readPublished(stateDir);
  console.log(`   published: ${published.join(", ") || "(none)"}  (owned, auto)`);
  const staged = listProposals(stateDir).filter((p) => p.kind === "social_post");
  for (const p of staged) console.log(`   queued:    ${p.proposal_id} → review & post to ${p.channel} (third-party, human)`);
  console.log(`   preview:   ${live.external_refs.preview_url}`);

  console.log(`\n✅ Main walk done — release went tagged → … → uploaded → live, publicity fired, nothing left the machine.`);

  // ---------------------------------------------------------------------------
  // Provider-family walk — build → (sign) → deploy for a representative app per
  // deploy-provider family, ALL offline. The main walk above already showed the
  // provider-agnostic tail (flip → live → publicity); every family below lands at
  // `uploaded`, and from there the flip → live → publicity path is identical.
  //
  // No external CLI is installed here (no wrangler/vercel/flyctl/gh/butler/terraform/
  // xcrun), so each family runs through a FAKE CommandRunner: exit 0 + canned stdout
  // containing a plausible URL. That drives the provider's real code path — it prints
  // the exact argv it would run and parses the URL out of the canned output — without
  // an account, a network call, or anything published. Runtime values still go through
  // runArgv (no shell); the generic `command` target is the ONE that uses the shell.
  // ---------------------------------------------------------------------------
  console.log(`\n── Provider-family walk (offline, fake runner — the real local_dir/web walk is above) ──`);
  const familyState = mkdtempSync(join(tmpdir(), "halyard-demo-family-"));
  const familyBackend = makeGitBackend({ stateDir: familyState });

  const webApp = (deploy: Record<string, unknown>): AppConfig =>
    ({ ...app, surfaces: { ...app.surfaces, web: { ...app.surfaces.web!, deploy } } }) as AppConfig;
  const desktopApp = (
    deploy: Record<string, unknown>,
    signing?: Record<string, unknown>,
  ): AppConfig =>
    ({
      ...app,
      surfaces: {
        ...app.surfaces,
        web: { ...app.surfaces.web!, enabled: false },
        desktop: {
          enabled: true,
          build: { command: "npm run tauri build", output_dir: "dist-desktop" },
          test: { command: "node -e 0" },
          deploy,
          ...(signing ? { signing } : {}),
        },
      },
    }) as AppConfig;

  // A fake runner never touches a subprocess or the filesystem — it just echoes canned
  // stdout with exit 0, so the provider code path runs offline with no CLI present.
  const fakeRunner = (stdout: string): CommandRunner => {
    const done = (command: string): CommandResult => ({ command, exitCode: 0, stdout, stderr: "" });
    return {
      async run(command) { return done(command); },
      async runArgv(file, args) { return done([file, ...args].join(" ")); },
    };
  };

  interface Family {
    label: string;
    surface: "web" | "desktop";
    target: string;
    cli: string;
    app: AppConfig;
    canned: string;
  }
  const families: Family[] = [
    {
      label: "Cloudflare Pages (web) — wrangler",
      surface: "web", target: "cloudflare_pages", cli: "npx wrangler pages deploy",
      app: webApp({ target: "cloudflare_pages", project: "demo-web" }),
      canned: "Deployment complete! https://a1b2c3d4.demo-web.pages.dev",
    },
    {
      label: "Vercel (web) — vercel deploy --prod",
      surface: "web", target: "vercel", cli: "vercel deploy --prod --yes",
      app: webApp({ target: "vercel", project: "demo-web" }),
      canned: "Production: https://demo-web-a1b2c3d4.vercel.app [2s]",
    },
    {
      label: "Fly.io (web) — flyctl deploy",
      surface: "web", target: "fly", cli: "flyctl deploy --app demo-web",
      app: webApp({ target: "fly", app: "demo-web" }),
      canned: "Visit your newly deployed app at https://demo-web.fly.dev/",
    },
    {
      label: "GitHub Pages (web) — gh api pages/builds",
      surface: "web", target: "github_pages", cli: "gh api --method POST repos/<owner/name>/pages/builds",
      app: webApp({ target: "github_pages", repo: "example/demo-web" }),
      canned: '{"status":"queued"}',
    },
    {
      label: "AWS (web) — terraform apply",
      surface: "web", target: "aws", cli: "terraform -chdir <dir> apply -auto-approve",
      app: webApp({ target: "aws", terraform_dir: "infra", output_url_var: "site_url" }),
      canned: "https://d111abcdef8.cloudfront.net",
    },
    {
      label: "Generic command (web) — operator shell string (the ONE shell target)",
      surface: "web", target: "command", cli: "sh -c '<deploy.command>'",
      app: webApp({ target: "command", command: "echo deploying demo-web", url: "https://demo.example" }),
      canned: "deploying demo-web",
    },
    {
      label: "GitHub Releases + macOS signing (desktop) — notarize/staple → gh release create",
      surface: "desktop", target: "github_releases",
      cli: "xcrun notarytool submit … && gh release create",
      app: desktopApp(
        { target: "github_releases", repo: "example/demo-desktop", tag_pattern: "desktop-v{version}" },
        { enabled: true, platform: "macos", notary_profile: "halyard-notary" },
      ),
      canned: "https://github.com/example/demo-desktop/releases/tag/desktop-v1",
    },
    {
      label: "itch.io (desktop) — butler push",
      surface: "desktop", target: "itch", cli: "butler push <dir> example/demo:win",
      app: desktopApp({ target: "itch", user: "example", game: "demo", channel: "win" }),
      canned: "Pushing to example/demo:win — done.",
    },
    {
      label: "Generic command (desktop) — operator shell string",
      surface: "desktop", target: "command", cli: "sh -c '<deploy.command>'",
      app: desktopApp({ target: "command", command: "echo packaging installer", url: "https://example.itch.io/demo" }),
      canned: "packaging installer",
    },
  ];

  for (let i = 0; i < families.length; i++) {
    const fam = families[i]!;
    step(`${fam.label}`,
      `halyard release run --app demo --surface ${fam.surface} --version 1.0.${i}  # target: ${fam.target} → ${fam.cli}`);
    const rel = await runRelease({
      app: fam.app, surface: fam.surface, version: `1.0.${i}`, commit: "0000000",
      backend: familyBackend, workdir, runner: fakeRunner(fam.canned), now,
      log: (m) => console.log(`      ${m}`),
    });
    console.log(`   → ${fam.surface}/${fam.target}: ${rel.state}  (preview ${rel.external_refs.preview_url || "(none)"})`);
  }

  console.log(`\n✅ Provider-family walk done — every deploy target exercised offline, no CLI, no account, nothing published.`);
  if (keep) {
    console.log(`(kept: ${stateDir} , ${workdir} , ${familyState})`);
  } else {
    rmSync(stateDir, { recursive: true, force: true });
    rmSync(workdir, { recursive: true, force: true });
    rmSync(familyState, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? (err.stack ?? err.message) : String(err));
  process.exit(1);
});
