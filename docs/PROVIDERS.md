# Deploy providers, mobile toolchains & desktop signing

Halyard's `deploy` step is a **provider registry**, not a fixed pair of targets. Each app
picks a deploy target per surface via `surfaces.<surface>.deploy.target`; the registry
(`src/halyard/surfaces/deploy/registry.ts`) maps that discriminator to a provider module and
validates the block against that provider's `configSchema` at config-load time. Adding a
target = adding a provider module — never editing another provider.

The same shape holds for mobile: `surfaces.<ios|android>.toolchain` selects a **mobile
toolchain** (`match` or `eas`), and desktop has an optional pre-deploy **signing** step.

## Invariants every provider holds

- **No provider decides ship/flip (invariant #2).** A provider runs a command and returns a
  `DeployResult` (`ok`, `previewUrl`, `details`); the deterministic gates + the human flag
  flip adjudicate. Deploy lands the release at `uploaded`; the flag flip projects it to `live`.
- **Runtime values go through `runArgv` (no shell).** Anything derived at runtime (commit ref,
  project name, output dir, tag) is passed as an explicit argv with **no shell**, so it can
  never be interpreted as shell metacharacters. The generic **`command`** target is the ONE
  provider that uses the shell — because `deploy.command` is an operator-trusted config string,
  not a runtime value.
- **Credentials are env-only, never config.** Deploy tokens are read from the environment at
  runtime by the underlying CLI (`wrangler`, `vercel`, `flyctl`, `gh`, `butler`, `terraform`);
  they are never written to config, passed as a flag, or logged (invariant #4). See
  [CREDENTIALS.md](CREDENTIALS.md) for the full env-var matrix.
- **Third-party social is draft-only (#5); payments are verify-only.** Publicity to owned
  channels auto-publishes on `live`; third-party posts only stage for human approval. Payments
  config is checked, never charged.

`local_dir` and `command` are **surface-agnostic** (valid for any surface). Every other target
declares the surface(s) it is valid for, and the registry rejects a mismatch at load time
(e.g. `cloudflare_pages` on desktop).

---

# Web deploy targets

## `cloudflare_pages`
- **Runs:** `npx --yes wrangler pages deploy <outputDir> --project-name <project> --branch <commit> --commit-hash <commit>` (via `runArgv`, no shell). Parses the `*.pages.dev` URL from stdout for `previewUrl`.
- **Valid for:** web.
- **Env at runtime:** `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (read by `wrangler`).
- **Config:**
  ```yaml
  deploy:
    target: cloudflare_pages
    project: aurora-web        # Cloudflare Pages project name
  ```

## `vercel`
- **Runs:** `vercel deploy --prod --yes --cwd <outputDir> [--project <project>]` (via `runArgv`, no shell). Parses the `*.vercel.app` URL (falling back to the first https URL) from stdout.
- **Valid for:** web.
- **Env at runtime:** `VERCEL_TOKEN` (read by the `vercel` CLI; never passed as a flag).
- **Config:**
  ```yaml
  deploy:
    target: vercel
    project: aurora-web        # optional — Vercel infers it from the linked dir
  ```

## `fly`
- **Runs:** `flyctl deploy --app <app> [--config <config>]` (via `runArgv`, no shell). Uses the URL flyctl prints, else falls back to `https://<app>.fly.dev`.
- **Valid for:** web.
- **Env at runtime:** `FLY_API_TOKEN` (read by `flyctl`).
- **Config:**
  ```yaml
  deploy:
    target: fly
    app: aurora-web            # Fly app name
    config: fly.toml           # optional path to a fly config
  ```

## `github_pages`
- **Runs:** `gh api --method POST repos/<repo>/pages/builds` (via `runArgv`, no shell) to trigger a Pages build; the site content is assumed uploaded by the build step. `previewUrl` is computed from the repo (`https://<owner>.github.io/<name>`, or the root site for `owner/owner.github.io`).
- **Valid for:** web.
- **Env at runtime:** `GITHUB_TOKEN` / `GH_TOKEN` (read by `gh`).
- **Config:**
  ```yaml
  deploy:
    target: github_pages
    repo: example/aurora-web   # "owner/name" the Pages site is published from
    branch: gh-pages               # optional publishing branch (default gh-pages)
  ```

## `aws`
- **Runs:** `terraform -chdir <dir> apply -auto-approve -input=false`, then (if `output_url_var` set) `terraform -chdir <dir> output -raw <var>` for the `previewUrl` (both via `runArgv`, no shell).
- **Valid for:** web.
- **Env at runtime:** `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` (read automatically by Terraform). Terraform remote-state backend config/creds are likewise environmental.
- **Config:**
  ```yaml
  deploy:
    target: aws
    terraform_dir: infra           # dir holding the TF config (relative to workdir or absolute)
    output_url_var: site_url       # optional TF output name to read the public URL from
  ```

## `command` (web) — the generic escape hatch
- **Runs:** the operator-configured `deploy.command` string **through the shell** (`runner.run`), because it is an operator-trusted config string. `previewUrl` is the optional `deploy.url`. This is the ONE provider that uses the shell.
- **Valid for:** any surface (surface-agnostic) — gives an app a launch path before its specific provider lands.
- **Env at runtime:** whatever the command itself reads. Halyard never logs or interpolates a secret into the command.
- **Config:**
  ```yaml
  deploy:
    target: command
    command: "rsync -a dist/ deploy@host:/var/www/aurora"   # operator-trusted; may use shell features
    url: https://aurora.example                             # optional; reported as previewUrl
  ```

## `local_dir` (web) — local verification
- **Runs:** copies the build output to `<dir>/<release_id>` (real filesystem copy, no external service, no credentials). On web, `previewUrl` points at the copied `index.html`.
- **Valid for:** any surface (surface-agnostic).
- **Env at runtime:** none.
- **Config:**
  ```yaml
  deploy:
    target: local_dir
    dir: preview               # copies build output → preview/<release_id>
  ```

---

# Desktop deploy targets

## `github_releases`
- **Runs:** `gh release create <tag> <outputDir> --repo <repo> --title <tag> --notes "…"` (via `runArgv`, no shell). `<tag>` is rendered from `tag_pattern` (`{version}`/`{surface}` substitution). Records `github_release_tag` / `github_repo` external refs on success.
- **Valid for:** desktop.
- **Env at runtime:** `GITHUB_TOKEN` / `GH_TOKEN` (read by `gh`).
- **Config:**
  ```yaml
  deploy:
    target: github_releases
    repo: example/aurora-desktop    # "owner/name" the release is published to
    tag_pattern: "desktop-v{version}"   # e.g. desktop-v1.4.0
  ```

## `itch`
- **Runs:** `butler push <outputDir> <user>/<game>:<channel>` (via `runArgv`, no shell). `previewUrl` is `https://<user>.itch.io/<game>`; records the `itch_channel` external ref on success.
- **Valid for:** desktop.
- **Env at runtime:** `BUTLER_API_KEY` (read by `butler`).
- **Config:**
  ```yaml
  deploy:
    target: itch
    user: example          # itch.io account
    game: aurora               # project slug under that account
    channel: win               # e.g. win / osx / linux
  ```

## `command` (desktop)
Same provider as web `command` above (surface-agnostic): the operator `deploy.command` runs
through the shell, `previewUrl` from `deploy.url`. Use it to package + upload a desktop
installer to any target before a dedicated provider exists.

## `local_dir` (desktop)
Same provider as web `local_dir` (surface-agnostic): copies the bundle to `<dir>/<release_id>`
for inspection; on non-web surfaces `previewUrl` points at the copied directory.

---

# Mobile toolchains (`surfaces.<ios|android>.toolchain`)

The iOS/Android adapters' build/test/submit are pluggable behind a **mobile toolchain**. An
app selects one per surface with `toolchain:` (default `match`). Both land the release at
`uploaded`; the ASC/Play review poll then drives `uploaded → in_review → shipped_dark`.

## `match` (default) — fastlane
- **iOS:** fastlane `match` (signing) + `gym` (archive) + `pilot` (TestFlight upload). **Android:** gradle bundle + `supply` (upload to the Play track). Lane commands are operator-trusted, so they run through the shell `run`.
- **Config:**
  ```yaml
  surfaces:
    ios:
      enabled: true
      toolchain: match            # default; can be omitted
      bundle_id: com.acme.aurora
      asc_app_id: "6478…"
      team_id: "ABCDE12345"
      signing: { method: match, match_repo_ref: SECRET:MATCH_REPO, asc_api_key_ref: SECRET:ASC_PRIVATE_KEY }
      testflight_group: Beta
      review_poll_cron: "0 */2 * * *"
  ```

## `eas` — Expo Application Services
- **iOS/Android:** `eas build --platform <p> --profile production --non-interactive --json` (cloud build; no local artifact dir), then `eas submit --platform <p> --non-interactive --profile production`. Every runtime value goes through `runArgv` (no shell).
- **Config:** set `toolchain: eas` on the surface. The fastlane identity fields are not used by EAS; instead the EAS CLI reads `EXPO_TOKEN`, and the ASC API key (iOS) / Play service-account JSON (Android) come from the environment.
  ```yaml
  surfaces:
    android:
      enabled: true
      toolchain: eas
      package: com.acme.aurora
      track: internal
      service_account_ref: SECRET:SUPPLY_JSON_KEY_DATA
  ```

Neither toolchain decides pass/fail (invariant #2) — each reports exit codes and the gates
adjudicate; neither reads or logs a credential (invariant #4).

---

# Desktop signing (`surfaces.desktop.signing`)

Optional **pre-deploy** step that runs between build and deploy when
`surfaces.desktop.signing.enabled` is true. Defaults **off** — no signing runs unless an app
opts in. Credentials are `SECRET:` refs resolved to env at runtime; a signer never writes or
logs a credential (invariant #4).

## macOS — Developer ID **notarize + staple** (enabled)
- **Runs now** (2026-07-08 portfolio decision). `xcrun notarytool submit <outputDir> --keychain-profile <profile> --wait`, then `xcrun stapler staple <outputDir>` (both via `runArgv`, no shell). Signing is in place, so `outputDir` is unchanged.
- Apple credentials are **never** expanded into an argv or log line. They are supplied out-of-band via a **notarytool keychain profile** — only the non-secret profile *name* (`notary_profile`, default `halyard-notary`) crosses config. Create it once on the runner: `xcrun notarytool store-credentials`.
  ```yaml
  surfaces:
    desktop:
      enabled: true
      build: { command: "npm run tauri build", output_dir: "src-tauri/target/release/bundle" }
      test:  { command: "npm test" }
      deploy: { target: github_releases, repo: example/aurora-desktop, tag_pattern: "desktop-v{version}" }
      signing:
        enabled: true
        platform: macos
        notary_profile: halyard-notary          # non-secret keychain profile name
        apple_id_ref: SECRET:APPLE_ID            # refs (see CREDENTIALS.md); used to create the profile
        apple_team_id_ref: SECRET:APPLE_TEAM_ID
        apple_password_ref: SECRET:APPLE_APP_PASSWORD
  ```

## Windows — Authenticode (**built but deferred / off by default**)
- Fully implemented (`signtool sign /fd sha256 /tr <timestamp> /td sha256 <outputDir>` via `runArgv`) but **ships disabled** per the 2026-07-08 portfolio decision. It runs only if an app sets `platform: windows` **and** `enabled: true` — which no app does yet. The certificate is referenced by the machine cert store at runtime (`signtool` auto-selects it); it is never passed as a `SECRET:` argv or logged.
  ```yaml
  # Deferred — off by default. Do not enable without the portfolio decision changing.
  signing:
    enabled: true
    platform: windows
    windows_certificate_ref: SECRET:WINDOWS_CERTIFICATE
    windows_certificate_password_ref: SECRET:WINDOWS_CERTIFICATE_PASSWORD
  ```

---

See it end-to-end offline: `npm run demo` walks build → (sign) → deploy for a representative
app in every provider family using a fake runner (no CLI, no account, nothing published), and
prints the exact argv each provider would run. See [DEMO.md](DEMO.md).
