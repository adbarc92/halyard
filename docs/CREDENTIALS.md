# Credential matrix — Gate #2 creds → `SECRET:` ref / env var

This is the map from each provider / toolchain / surface to the credential(s) it needs and
the exact environment variable that carries it at runtime. It complements
[PROVIDERS.md](PROVIDERS.md) (what each provider *runs*) and
[LAUNCH-READINESS.md](LAUNCH-READINESS.md) (the armed-vs-safe-default runbook).

## Two kinds of credential — and the rule that separates them

Invariant #4: **config holds secret *references* (`SECRET:NAME`), never values.** But not
every credential even appears in config — deploy tokens don't. The dividing line:

- **Deploy / build tokens are env-only.** The deploy CLIs (`wrangler`, `vercel`, `flyctl`,
  `gh`, `butler`, `terraform`) and the EAS toolchain read their token straight from the
  **environment** at runtime. Halyard never names these in `app.yml`, never passes them as a
  flag, and never logs them. The CI workflow injects them from the Actions secret store.
- **Everything else is a `SECRET:NAME` ref in config.** Flag-provider tokens, payments keys,
  Sentry, mobile store/signing creds, calendar — these are named in `app.yml` /
  `halyard.config.yml` as `SECRET:NAME` and resolved from the env var `NAME` at runtime.

So: a deploy token has **no `SECRET:` ref** (it's ambient env); a flag/payments/Sentry/store
credential **is** a `SECRET:` ref that resolves to its env var.

## Deploy targets (web + desktop) — env-only, no `SECRET:` ref

| Target | Surface | Credential | Env var(s) read at runtime | In config? |
|---|---|---|---|---|
| `cloudflare_pages` | web | Cloudflare API token + account | `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` | no — env-only |
| `vercel` | web | Vercel token | `VERCEL_TOKEN` | no — env-only |
| `fly` | web | Fly API token | `FLY_API_TOKEN` | no — env-only |
| `github_pages` | web | GitHub token | `GITHUB_TOKEN` / `GH_TOKEN` | no — env-only |
| `aws` | web | AWS keys (+ TF remote state) | `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY` | no — env-only |
| `command` | any | whatever the command reads | (command-defined) | no |
| `local_dir` | any | none | — | no |
| `github_releases` | desktop | GitHub token | `GITHUB_TOKEN` / `GH_TOKEN` | no — env-only |
| `itch` | desktop | itch.io butler key | `BUTLER_API_KEY` | no — env-only |

> The generic `command` target runs an operator-trusted shell string; any credential it needs
> is whatever that command reads from the environment. Halyard neither injects nor logs it.

## Mobile toolchains — mixed

| Toolchain | Surface | Credential | Env var / `SECRET:` ref | In config? |
|---|---|---|---|---|
| `match` (fastlane) | ios | match repo + password | `MATCH_REPO` (`SECRET:` via `signing.match_repo_ref`), `MATCH_PASSWORD` | ref + env |
| `match` (fastlane) | ios | ASC API key | `ASC_KEY_ID`, `ASC_ISSUER_ID`, `ASC_PRIVATE_KEY` (`SECRET:` via `signing.asc_api_key_ref`) | ref + env |
| `match` (fastlane) | android | Play service-account JSON | `SUPPLY_JSON_KEY_DATA` (`SECRET:` via `service_account_ref`) | ref + env |
| `eas` (Expo) | ios | Expo token + ASC key | `EXPO_TOKEN` (env-only, read by EAS CLI) + the ASC key above | mixed |
| `eas` (Expo) | android | Expo token + Play JSON | `EXPO_TOKEN` (env-only) + `SUPPLY_JSON_KEY_DATA` (`SECRET:` ref) | mixed |

`EXPO_TOKEN` is env-only (the EAS CLI reads it like `wrangler` reads its token). The store
credentials (`ASC_*`, `SUPPLY_JSON_KEY_DATA`) are `SECRET:` refs in `app.yml` for both
toolchains — they identify *your app on the store*, not the deploy transport.

## Desktop signing

| Platform | State | Credential | `SECRET:` ref → env | Notes |
|---|---|---|---|---|
| macOS | **enabled** | Apple ID / team / app-specific password | `apple_id_ref`, `apple_team_id_ref`, `apple_password_ref` → `APPLE_ID`, `APPLE_TEAM_ID`, `APPLE_APP_PASSWORD` | Used **once** to create the notarytool keychain profile; at sign time only the non-secret profile *name* (`notary_profile`, default `halyard-notary`) crosses config — the creds never enter an argv or log |
| Windows | **deferred / off** | Authenticode cert (+ password) | `windows_certificate_ref`, `windows_certificate_password_ref` → `WINDOWS_CERTIFICATE`, `WINDOWS_CERTIFICATE_PASSWORD` | Built but disabled; the cert is referenced from the machine cert store at runtime (`signtool` auto-selects). Do not enable without the portfolio decision changing |

## Non-deploy platform creds (the rest of Gate #2) — `SECRET:` refs in config

| Concern | `SECRET:` ref in config | Resolves to env var |
|---|---|---|
| Flag provider (live) | `flags.api_key_ref` | e.g. `AURORA_FLAG_PROVIDER_KEY` (per-app) |
| Payments (verify-only) | `payments.api_key_ref` | e.g. `STRIPE_API_KEY` |
| Sentry (triage) | `triage.sentry.project_ref` | `SENTRY_AUTH_TOKEN` |
| Drafting / agents | org `api_key_ref` | `ANTHROPIC_API_KEY` |
| Platform deadlines | `maintenance.platform_deadlines.calendar_ref` | calendar token |
| Owned publish | (org channel config) | `BLOG_PUBLISH_URL`, `EMAIL_SEND_URL` |
| Approval surface | (org) | `HALYARD_APPROVAL_WEBHOOK` |

Opt-in toggles (`HALYARD_LIVE_PUBLISH`, `HALYARD_LIVE_MERGE`, `HALYARD_LIVE_FLAGS`) arm the
real clients; unset, each degrades to a safe local default. Resolution is fail-safe: a
missing `SECRET:` value surfaces at `halyard preflight`, not as a silent wrong-credential run.

## How to set them

- **Locally / self-host:** export the env vars for the deploy tokens directly; set the
  `SECRET:NAME` env vars for the rest. `halyard preflight --probe off` checks config; `halyard
  preflight` probes reachability.
- **CI (GitHub Actions):** store each name in the Actions secret store; the release/reconcile
  workflows inject them into the step environment. The deploy CLIs pick their token up from
  there; the `SECRET:NAME` refs resolve from the same env.
