# @halyard/web — operator console

A SvelteKit browser console for Halyard (`@halyard/web`). Point a browser at it to view
release status, work the approval queue, flip feature flags, and browse launches — without
touching the CLI.

It imports the `halyard` library directly; the library itself is not modified.

---

## Start

**Production** (build once, then serve):

```bash
# from the Halyard project root
npm run web:build
npm run web:start
```

**Development** (Vite dev server, hot-reload):

```bash
npm run web:dev
```

Both commands are non-interactive.

---

## Auth and bind address

The console is gated by one shared secret, `HALYARD_CONSOLE_TOKEN` (env; never logged, never a
config-file value — generate with `openssl rand -hex 32`).

| Env var | Default | Notes |
|---|---|---|
| `HALYARD_CONSOLE_TOKEN` | unset | Required to serve on any non-loopback host or behind a proxy. |
| `HOST` | `127.0.0.1` | Set by `web:start`. |
| `PORT` | `3000` | Listening port. |
| `ORIGIN` | `http://$HOST:$PORT` | Set automatically by `web:start` for standalone; set to the public origin behind a proxy. |

Behavior:
- **No token + loopback** → open, zero-config (local dev), exactly as before.
- **No token + non-loopback host, or any proxy env, or any `x-forwarded-*` request** → refused
  (the bind guard exits; the request hook returns 403). You cannot expose it without auth.
- **Token set** → a browser is redirected to `/login` (token → opaque session cookie); machines and
  reverse proxies send `Authorization: Bearer $HALYARD_CONSOLE_TOKEN`. Sign out clears the session.

`web:start` runs `node web/server.js`, which guards then hands off to the adapter server (it
presupposes a prior `web:build`). Running `node web/build` directly skips the fail-fast guard, but
the request hook still rejects non-loopback / proxied requests when no token is set.

### Login rate limiting

The `/login` token form is throttled per client address to blunt brute-force guessing. After
**5** failed attempts the address is locked out for **15 minutes**; while locked, even a request
carrying the correct token is refused with `429 Too many attempts` (and no session is issued). A
successful login clears the counter, and the lockout self-expires once the window elapses.

The limiter is **in-memory and per-process** (no datastore, no extra dependency) — fitting the
single-instance, loopback-by-default console. It clears on restart. Only the browser `/login`
path is throttled; `Authorization: Bearer` requests from a proxy/machine are not (the upstream is
trusted). Time comes from the injectable clock (`src/lib/server/clock.ts`), so the lockout is
deterministic under test.

### Rotating `HALYARD_CONSOLE_TOKEN` (no redeploy outage)

`HALYARD_CONSOLE_TOKEN` is read once at process start. To rotate it without a window of exposure:

1. Generate a new high-entropy value: `openssl rand -hex 32`.
2. Update the env/secret source the console reads from (the supervisor unit, container env,
   proxy config, etc.).
3. **Restart the console process** (e.g. `npm run web:start` again, or restart the unit/container).
   The new token takes effect on the next start; in-memory sessions and rate-limit counters reset,
   so any signed-in browser is bounced to `/login` and re-authenticates with the new token —
   expected, and the safe outcome for a rotation.

Because the console is single-instance there is no rolling-restart coordination: stop, swap the env
value, start. The only "outage" is bounded by process start time (sub-second), not a redeploy. For
an **embedded / behind-a-proxy** deployment, rotate the value the proxy sends as
`Authorization: Bearer $HALYARD_CONSOLE_TOKEN` in lockstep with the console env so the two never
disagree. There is intentionally no in-app rotation UI — rotation is an operator env action,
matching the single-shared-token model.

---

## Sub-path embedding (`HALYARD_BASE_PATH`)

To mount the console under a URL sub-path (e.g. `/halyard/*`) for embedding behind a reverse
proxy or inside a larger dashboard, set `HALYARD_BASE_PATH` **at build time**:

```bash
HALYARD_BASE_PATH=/halyard npm run web:build
npm run web:start
# now served under /halyard (e.g. http://127.0.0.1:3000/halyard)
```

| Env var | Default | Notes |
|---|---|---|
| `HALYARD_BASE_PATH` | `""` (root) | Build-time only. Leading slash optional (added if missing); trailing slash stripped. |

This wires SvelteKit's `kit.paths.base`, which is **baked into the bundle** — it is *not* a
runtime setting. Changing the sub-path requires a rebuild. With the var unset the console serves
at the root exactly as before. All nav, internal links, and API `fetch` calls are prefixed with
the configured base, so they resolve correctly under the sub-path.

---

## Service backend (`coordinator.backend: service`)

When `halyard.config.yml` sets `coordinator.backend: service`, the console routes persistence
reads/writes through the remote Halyard state service instead of the local filesystem. The
service token (`coordinator.service.api_key_ref`) **must be resolvable from the secret store at
startup** (typically via an environment variable, e.g. `HALYARD_SERVICE_TOKEN=...`).

If the token is absent or unresolvable the console starts in a **degraded state** — `GET /health`
returns `{ status: "degraded", backendWarning: "…" }` with the secret-ref name (never the
token value, invariant #4), and the approval / reconcile operations fail with that message.
Read-only operations (status board, queue, launches, releases) continue to work against
whatever local `stateDir` is configured (which may be empty for a pure service project).

The service token is resolved at runtime and never logged. To confirm the backend is live
check `GET /health` before using the console.

---

## Live flag provider

By default the console flips the git-backed file client (offline, credential-free). When an app
declares a flag provider (`apps/<slug>/app.yml → flags.api_url`) **and** live flags are enabled
(`HALYARD_LIVE_FLAGS=1`) **and** the token named by that app's `flags.api_key_ref` resolves from
the secret store, the console flips the real remote-config provider (`HttpFlagClient`) instead —
the same selection the CLI / reconcile workflow makes. The token is resolved at runtime and never
logged (invariant #4). A missing token or unreachable provider degrades gracefully back to the
file client; the console always loads.

---

## Health endpoint

```
GET /health
```

- **200** `{ status: "ok", root, stateDir, apps }` — valid config found.
- **503** `{ status: "error", … }` — config missing or invalid (not a warm-up window).

---

## Config root and stateDir

The console resolves config the same way the CLI does:

- **Config root:** current working directory, or an absolute path in `HALYARD_CONFIG_ROOT`.
- **Reads:** `halyard.config.yml` (org) and `apps/<slug>/app.yml` (per-app) from that root.
- **stateDir:** read from `coordinator.state_dir` in `halyard.config.yml` (a required field;
  there is no system default — the example config uses `./state`), resolved relative to the
  project root.

The head reads state continuously. It writes to `stateDir` only via approve, flag-flip, and
"Reconcile now". It never git-commits — committing state records is the operator's or CI's job.

---

## Scope

Five screens: status board, approval queue (with inline approve), flags (flag flip), releases
(read-only browse), and launches (read-only browse). Raised `coordinator_error` proposals
surface as an alert banner on the board and in the approval queue — there is no separate
notifications screen.

**"Reconcile now"** is transitions-only (flag poll, offline) — publicity fan-out stays with
`halyard reconcile` (CLI/cron). The console runs credential-free offline. The multi-app Pro
gate is enforced on the acting path; reads and single-flag/single-proposal human gates are free.

**Single-operator:** do not run the console alongside a reconcile cron writing the same
`stateDir`.

---

For full integration details see [docs/INTEGRATION.md](../docs/INTEGRATION.md#web-console-head).
