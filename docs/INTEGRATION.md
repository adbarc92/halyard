# Embedding Halyard (using it as a library)

Halyard is usable two ways: as the **CLI / GitHub Actions** workflows described in the
[README](../README.md), or as a **library** imported by another Node/TypeScript project (a
"central hub"). This guide is the second path.

The engine is dependency-injected throughout: every external collaborator is a port with a
default implementation, and the public barrel (`src/halyard/index.ts`) exports the whole
feature matrix. A hub can run releases, reconcile, fire publicity, read state, and manage the
approval queue **without shelling out to the CLI**.

---

## Install

Halyard ships compiled `dist/` (built on install via the `prepare` script) with type
declarations. Install from git (or a registry, if you publish it):

```bash
npm install github:adbarc92/halyard
```

It's ESM (`"type": "module"`) and targets Node ≥ 20. Import from the package root:

```ts
import { runRelease, reconcile, firePublicity, readRelease } from "halyard";
```

> Only the package root (`"halyard"`) is exported — it is comprehensive, so there is no need
> for deep imports.

---

## The public surface

| You want to… | Use |
|---|---|
| Run a release (build → test → deploy → record) | `runRelease({ app, surface, version, commit, stateDir, workdir, runner, now })` |
| Reconcile external truth into state | `reconcile({ stateDir, sources, now })` + `buildReconcileSources(org, apps, { flagClient })` |
| Create / link a launch | `newLaunch(...)`, `writeLaunch`, `linkRelease`, `bindReleaseToLaunch` |
| Flip a flag (the launch moment) | a `FlagClient` (`FlagFileClient` or your own) `.setState(key, on)` |
| Fire publicity on `live` | `firePublicity({ org, apps, drafter, publisher, notifier, voiceCanon, stateDir, now })` |
| Read state | `readRelease`, `readLaunch`, `listProposals`, `scanReleaseIds`, `scanLaunchIds` |
| Operator view ("why is this stuck?") | `summarizeRelease(release, nowIso)` |
| Approve a proposal | `approveProposal({ stateDir, canonDir, proposalId, finalText?, now })` |
| Validate config | `validateOrgConfig`, `validateAppConfig`, `loadOrgConfig(path)`, `loadAppConfig(path)` |

All of the above are exported from `"halyard"`, along with the Zod schemas
(`ReleaseSchema`, `LaunchSchema`, `ProposalSchema`, …) and their inferred types.

---

## Dependency injection — supply your own backends

Every integration is a port. Pass your own implementation, or use the bundled default.

| Port | Default | Swap in when… |
|---|---|---|
| `FlagClient` | `FlagFileClient` (git-backed) | you have a real provider (`HttpFlagClient`, or your own) |
| `Drafter` | `TemplateDrafter` | you want LLM drafts (`AnthropicDrafter`) |
| `Publisher` | `FilePublisher` | you publish owned channels over HTTP (`HttpPublisher`) |
| `Notifier` | `FileNotifier` | you push approvals to a real surface (`WebhookNotifier`, or your own) |
| `ReconcileSource` | built by `buildReconcileSources` | you add a custom poller |
| `AscClient` / `SentryClient` / `MergeClient` / `TriageClassifier` | live clients + rule/template variants | you wrap a different vendor |

Because the ports are injected, **a model is never in a decision path** and **third-party
posts are never auto-published** regardless of what you wire — those are deterministic gates
inside the engine, not behaviors of the adapters.

### Secrets — inject your own store

By default secrets resolve from `process.env`. To use your own vault, install a `SecretStore`
once at startup:

```ts
import { setSecretStore } from "halyard";

setSecretStore({
  get: (name) => myVault.lookup(name), // string | undefined
});
```

Config only ever holds `SECRET:NAME` references; the store turns a reference into a value at
runtime (invariant #4). Never pass raw credentials through config.

---

## The state model as a contract

State is git-backed JSON under `state/{releases,launches,proposals,...}`. Read it through the
exported readers (which validate against the schemas) rather than parsing files yourself:

```ts
import { readRelease, ReleaseSchema, dedupKey } from "halyard";

const release = readRelease(stateDir, "rel_aurora_ios_1.4.0"); // validated Release | null
```

The schemas (`ReleaseSchema` / `LaunchSchema` / `ProposalSchema`) and the `dedupKey` contract
are exported, so the hub gets the same validation and idempotency guarantees the engine uses.

---

## Minimal end-to-end example

```ts
import {
  loadOrgConfig, loadAppConfig, runRelease, reconcile, buildReconcileSources,
  firePublicity, FlagFileClient, TemplateDrafter, FilePublisher, FileNotifier,
} from "halyard";

const now = () => new Date().toISOString();
const stateDir = "/data/halyard/state";

const org = loadOrgConfig("/data/halyard/halyard.config.yml");
const app = loadAppConfig("/data/halyard/apps/aurora/app.yml");

// 1. Run a release (inject your own CommandRunner in production).
await runRelease({ app, surface: "web", version: "2.1.0", commit: "abc1234", stateDir, workdir: ".", runner, now });

// 2. Reconcile external truth (review poll, flag poll) into state.
const flagClient = new FlagFileClient(stateDir, now);
await reconcile({ stateDir, sources: buildReconcileSources(org, [app], { flagClient }), now });

// 3. After a flag flip projects a release to `live`, fan out publicity.
await firePublicity({
  org, apps: [app], drafter: new TemplateDrafter(),
  publisher: new FilePublisher(stateDir, now), notifier: new FileNotifier(stateDir, now),
  voiceCanon: [], stateDir, now,
});
```

---

## Web console (head)

`web/` is a standalone SvelteKit operator console (`@halyard/web`) that imports the `halyard`
library. It is a normal web app at a URL, so it can be used on its own (point a browser at it)
or surfaced inside a larger hub.

### Starting the console

**Production** (build once, then serve):

```bash
npm run web:build   # from the Halyard project root
npm run web:start
```

**Development** (Vite dev server with hot-reload):

```bash
npm run web:dev
```

Both are non-interactive — no prompts, no TTY required.

### Port and bind address

The server listens on `PORT` (default `3000`). The `web:start` script pins
`HOST=127.0.0.1` via `cross-env`, so the process binds loopback only and is not reachable
over the network without an explicit tunnel or reverse proxy.

### Health endpoint

```
GET /health
```

- **200** `{ status: "ok", root, stateDir, apps }` — a valid project config was found at the
  config root.
- **503** `{ status: "error", … }` — `halyard.config.yml` is missing, unreadable, or fails
  Zod validation. The 503 is a config-validity probe, not a warm-up window; it clears
  immediately once valid config is present.

### Config root and state directory

The console resolves its config root the same way the CLI does: it uses the **current working
directory** by default, or an absolute path supplied via the `HALYARD_CONFIG_ROOT` env var.
From that root it reads:

- `halyard.config.yml` (org config)
- `apps/<slug>/app.yml` (per-app config)

The head reads `stateDir` from `coordinator.state_dir` in `halyard.config.yml` (a required
field; there is no system default — the example config uses `./state`), resolved relative to
the project root.

The head reads state continuously. It writes to `stateDir` only via three explicit operator
actions — approve a proposal, flip a flag, trigger "Reconcile now". It **never git-commits**;
committing the resulting state records is the operator's or CI's job (same as with the CLI).

### Scope

The five screens are:

| Screen | Purpose |
|---|---|
| Status board | Live view of every release and its state |
| Approval queue | Pending proposals; inline approve action |
| Flags | Toggle a named feature flag (the launch moment) |
| Releases | Read-only browse of releases |
| Launches | Read-only browse of launches |

Raised `coordinator_error` proposals surface as an alert banner on the board and in the
approval queue — there is no separate notifications screen.

**"Reconcile now"** runs transitions only (flag poll, offline) — it does **not** fan out
publicity or auto-publish owned channels. Publicity fan-out stays with `halyard reconcile`
(CLI or cron).

The console runs **credential-free** offline by default (same defaults as the library). The
one acting command, "Reconcile now", enforces the multi-app Pro gate, matching the CLI; reads
and single-flag / single-proposal human gates are free.

### Security and operational notes

- **Single-operator.** Do not run the console alongside the reconcile cron writing the same
  `stateDir` — they would race on state files.
- **Credential-free.** No secrets are required by the head. Live flag providers, LLM agents,
  and publicity publishing are handled by the CLI / workflows.

#### Auth (embedding behind the hub / a reverse proxy)

The console requires `HALYARD_CONSOLE_TOKEN` to serve anything non-loopback. Behind a proxy:

- The proxy authenticates the operator and forwards `Authorization: Bearer $HALYARD_CONSOLE_TOKEN`
  on every request (the hook lets these straight through — the `/login` page is never shown).
- Set `ORIGIN` to the public origin and the forwarded-header vars (`PROTOCOL_HEADER`,
  `ADDRESS_HEADER`, `HOST_HEADER`) per adapter-node, so `url`/CSRF and the `Secure` cookie flag
  resolve correctly.
- **CSRF:** the session cookie is `SameSite=Lax`, the primary cross-site guard for every mutating
  route. The body-consuming routes (`/api/flip`, `/api/approve`) additionally accept
  `application/json` only — a non-simple content type a cross-site `<form>` can't send. Keep
  mutating routes JSON-only or bodyless; never accept a form-encoded body on a mutating `/api/*`
  route, which would weaken this.

---

## Known limitations / notes

- **CLI path helpers assume the process CWD.** The `halyard` CLI resolves `halyard.config.yml`
  and `apps/<slug>/app.yml` relative to the working directory. When embedding, prefer the
  library functions with **absolute** config paths (`loadOrgConfig`/`loadAppConfig` take them),
  or set the host process CWD to the Halyard config root.
- **`zod` is a regular dependency.** If your hub also uses Zod and passes schemas across the
  boundary, dedupe to a single `zod` instance (npm/pnpm dedupe, or pin one version) to avoid
  dual-instance type mismatches.
- **The CLI does not auto-run on import.** Importing the package (or `dist/cli.js`) has no side
  effects; the command loop runs only when the file is the process entrypoint. `dispatch(args)`
  is exported if you want to drive the CLI surface programmatically.
