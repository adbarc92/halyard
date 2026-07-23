# Observability configuration (Sentry or equivalent)

Crash/health signal is how a live release tells you it's in trouble. Halyard consumes it two
ways, and both run through one port (`SentryClient`) so the vendor is swappable:

1. **In-loop triage** — every reconcile pass checks each live release's crash-free % against
   the app's threshold; a genuine spike opens a `crash_triage` **proposal** (severity +
   recommended action). Deterministic gate, agent classifies, human decides (invariant #2).
2. **Out-of-band alert** — the latency-sensitive path (design §5): a provider alert fires
   `repository_dispatch(sentry-alert)` → `.github/workflows/sentry-alert.yml` → `halyard
   triage` immediately, so a spike pages you in seconds instead of waiting for the cron.

This runbook wires both. Halyard never creates the provider project for you — that's operator
setup; everything below is the config + secrets it then reads.

---

## A. Provider setup (Sentry)

1. **Project**: create/choose the Sentry project for the app and note its **org slug** and
   **project slug/id**.
2. **Auth token**: create an internal integration / auth token with `project:read` (and
   `org:read`) scope. This is `SENTRY_AUTH_TOKEN`.
3. **Release health**: ensure the app's SDK reports **sessions** (crash-free rate is computed
   from session health), and that releases are tagged `"{app}-{surface}@{version}"` — the
   shape `LiveSentryClient` queries (`getReleaseHealth`).

> Using Crashlytics / Bugsnag / Datadog instead? Implement the `SentryClient` port
> (`getReleaseHealth(app, surface, version) → { crashFreePct, eventCount, topIssueTitle }`)
> and inject it; the triage flow, threshold gate, and alert workflow are unchanged.

---

## B. Halyard config

In `apps/<slug>/app.yml`:

```yaml
triage:
  sentry:
    project_ref: SECRET:SENTRY_DSN_AURORA   # reference, resolved at runtime — never the value
    org: example                        # your Sentry org slug
  severity_thresholds:
    crash_free_users_pct: 99.5              # the deterministic spike gate
  classify: agent                           # agent proposes severity + {flag_kill|hotfix|ignore}
```

- `project_ref` is a **secret reference** (the project identifier/DSN lives in the secret
  store, not in git). `LiveSentryClient` is constructed with the resolved `project_ref` —
  there is no hardcoded project.
- `crash_free_users_pct` is the boolean gate: triage only runs when crash-free drops below it.
  Tune per app risk tolerance.

Secrets to provide (env / your `SecretStore`):

| Secret | Read by | Where injected |
|---|---|---|
| `SENTRY_AUTH_TOKEN` | `LiveSentryClient` | `reconcile.yml`, `sentry-alert.yml` |
| the secret named by `project_ref` (e.g. `SENTRY_DSN_AURORA`) | `LiveSentryClient` (project) | same |
| `ANTHROPIC_API_KEY` | the triage classifier (optional) | falls back to the rule classifier |
| `HALYARD_APPROVAL_WEBHOOK` | the notifier | so the proposal reaches your phone |

---

## C. The out-of-band alert wiring

Halyard ships `.github/workflows/sentry-alert.yml`, triggered by
`repository_dispatch: { types: [sentry-alert] }` (and `workflow_dispatch` for manual runs).
You connect the provider to it:

1. **Create a GitHub trigger credential** — a fine-grained PAT (or GitHub App token) with
   `contents: write` on this repo (enough to POST the dispatch and let the job commit state).
2. **Relay** — Sentry alert rules post their own JSON, not a GitHub `repository_dispatch`
   envelope, so point the alert at a tiny relay (a Cloudflare Worker / Lambda) that:
   - verifies the Sentry signature,
   - POSTs `https://api.github.com/repos/<owner>/<repo>/dispatches` with
     `{"event_type":"sentry-alert"}` and the PAT.
   (If your provider can post a raw GitHub dispatch with a bearer token, skip the relay.)
3. **Alert rule** — in Sentry, fire on the condition that matters (e.g. crash-free rate below
   threshold, or error volume spike on a release) → webhook → the relay.

Result: spike → Sentry alert → relay → `repository_dispatch(sentry-alert)` → `halyard triage`
→ a `crash_triage` proposal on your phone, in seconds. The in-loop reconcile triage remains
the backstop if the alert path is down.

### Verify it

```bash
# Manual end-to-end of the alert path (no real spike needed):
gh workflow run sentry-alert.yml          # or the Actions “Run workflow” button
# Seed a live release first, then confirm a proposal appears:
halyard queue
```

Locally, the triage flow itself is covered offline by the rule classifier and a fake Sentry
client (`tests/`), and `LiveSentryClient`'s parsing/error paths by `tests/live-clients.test.ts`.

---

## D. What "good" looks like

- A reconcile pass over live releases is silent when healthy, opens a `crash_triage` proposal
  on a real dip, and **auto-resolves** it when crash-free recovers (re-opens on recurrence).
- A failing poller (expired `SENTRY_AUTH_TOKEN`) does **not** pass silently — it opens a
  `coordinator_error` proposal and turns the scheduled run red.
- No triage outcome ever flips a flag or ships a hotfix on its own — it proposes; you act.
