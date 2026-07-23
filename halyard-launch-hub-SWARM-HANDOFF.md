# Swarm Handoff — Halyard as the one-stop launch hub

> Date: 2026-07-08. Self-contained brief for a swarm. Turns Halyard (`D:\MajorProjects\INFRASTRUCTURE\halyard`,
> v0.1.0) from a coordinator with two real deploy targets into **the single control plane for every launch in
> the portfolio** — all surfaces (mobile/web/desktop), all the toolchains these apps actually use
> (EAS, Vercel, Fly, AWS, GitHub Pages, itch.io, a generic command escape-hatch), signing, and per-app onboarding.
>
> Companion docs: [`GATE-2-GUIDE.md`](../GATE-2-GUIDE.md) (the store/signing creds these providers consume),
> [`../RELEASE-PRIORITIES.md`](../RELEASE-PRIORITIES.md). Halyard's own capability baseline is in
> `D:\MajorProjects\CURRENT\command-center\docs\digests\halyard-digest.md`.

## The goal (definition of "one-stop-shop")

A launch of any app in the portfolio is driven end-to-end through Halyard: `halyard release run` builds → tests →
**signs (where needed)** → deploys/submits via that app's real toolchain; `halyard reconcile` polls external truth
(store review, flags) and projects state; `halyard flip` is the human launch moment; publicity drafts + stages on
`live`; `halyard maintenance`/`preflight`/`status` give one cross-portfolio operator view. Today Halyard can only
deploy to **Cloudflare Pages** (web) and **GitHub Releases** (desktop), and mobile is **fastlane-only** — which
matches almost none of the actual apps. This swarm closes that gap.

## Design boundaries — DO NOT "improve" these (they are load-bearing invariants)

These are Halyard's non-negotiable invariants. A "one-stop-shop" respects them; it does not automate around them.
- **Invariant #2 — no model ever decides ship/promote/flip.** Deterministic gates and a human flag-flip decide. Agents only draft/classify into the approval queue.
- **Invariant #5 — third-party social (X/LinkedIn/HN) is never auto-posted.** Halyard drafts + stages a proposal; a human posts. **Do not add X/LinkedIn/Reddit posting APIs** — that violates #5 and platform ToS. Owned channels (your blog/email) may auto-publish via generic HTTP POST; that's the line.
- **Payments stay verify-only.** Never move money.
- **Windows Authenticode signing stays deferred** (portfolio decision 2026-07-08 — see `GATE-2-GUIDE.md`). Build the signing code, but ship it **disabled by default**; only macOS notarization runs now.
- **All secrets are `SECRET:NAME` references** resolved at runtime; raw secrets in config are rejected at load. Keep it that way.
- **Runtime values go through `runner.runArgv` (no shell); only operator-config strings use `runner.run`.** Preserve this in every new provider.

---

## Ground truth — the extension seam (read before writing code)

The architecture is already built for this. Providers plug in behind one interface; the coordinator stays surface-agnostic.

- **Surfaces** = `"ios" | "android" | "web" | "desktop"` (`src/halyard/config/primitives.ts`). We are NOT adding surfaces — we are adding **providers within a surface**.
- **Adapter interface** (`src/halyard/surfaces/types.ts`): `SurfaceAdapter { build(ctx); test(ctx); deploy(ctx, build) }`, all shelling through `CommandRunner` (`run` = shell for config strings, `runArgv` = no-shell for runtime values). `DeployResult { ok, previewUrl, details, externalRefs? }`.
- **Dispatch** (`src/halyard/surfaces/index.ts`): `getAdapter(surface)` — a switch over the four surfaces.
- **The pluggable point that already exists**: each adapter's `deploy()` branches on a `deploy.target` **`z.discriminatedUnion("target", […])`** in `config/app-config.schema.ts` (`WebDeploySchema`: `cloudflare_pages | local_dir`; `DesktopDeploySchema`: `github_releases | local_dir`). Web deploy = `npx wrangler pages deploy` (`surfaces/web.ts`); desktop = `gh release create` (`surfaces/desktop.ts`).
- **Mobile** (`surfaces/ios.ts`, `android.ts`) is fastlane-shaped: iOS `signing.method: "match"` + `asc_api_key_ref`; Android `service_account_ref` + `track`. There is no toolchain abstraction yet — EAS needs one.
- **Release spine** (`coordinator/release-runner.ts`): `runRelease` calls `getAdapter().build → buildGate → test → testGate → deploy`, lands at `uploaded`, everything idempotent on a dedup key. Deterministic gates (`coordinator/gates.ts`) decide pass/fail — adapters never do.
- **State** = git-backed JSON in `state/` via schema-validated readers. **The offline spine is fully testable with no credentials** (76 test files, ~87% coverage); live provider paths are exercised only in CI/prod. Every new provider MUST keep the offline spine green and add offline-defaulted tests.

---

## Prerequisites / external gates (do not dispatch a blocked lane's *live* leg)

The **code** lanes below are all offline-testable and NOT blocked. Only the live deploy/submit leg of each is gated:

- **G-LICENSE — Pro entitlement for multi-app acting.** `reconcile`/`maintenance`/`triage` hard-gate on >1 app behind an Ed25519 `HALYARD_LICENSE_KEY` (read-only `status`/`preflight`/`payments` stay free). Running the portfolio through Halyard requires resolving this. → **Lane L12** provides a supported self-host path; operator sets the key. Blocks *portfolio-wide acting*, not development.
- **G-CI — GitHub Actions billing.** Halyard's ROADMAP says CI is billing-blocked; the portfolio's Gate #1 says billing was **restored account-wide 2026-07-07**. **Verify** it runs on this repo (Lane L15); if stale, unblock is the account-owner's.
- **G-CREDS — live provider credentials, per app.** Each provider's live leg needs its token(s), all as `SECRET:` refs. Most overlap Gate #2:
  - Mobile (EAS): `EXPO_TOKEN`; iOS reuses the **App Store Connect API key** (`.p8` → `ASC_*`) from Gate #2; Android reuses the **Play service-account JSON** (`SUPPLY_JSON_KEY_DATA`).
  - Web: Vercel `VERCEL_TOKEN`; Fly `FLY_API_TOKEN`; Cloudflare `CLOUDFLARE_API_TOKEN`/`_ACCOUNT_ID`; GitHub Pages `GITHUB_TOKEN`.
  - Desktop: itch.io `BUTLER_API_KEY`; macOS notarization `APPLE_*` (Gate #2); Windows `WINDOWS_CERTIFICATE*` (**deferred**).
  - AWS: `AWS_ACCESS_KEY_ID`/`_SECRET_ACCESS_KEY` (+ Terraform state).
  - Credential → `SECRET:` mapping is authored in **Lane L13** (`docs/CREDENTIALS.md`).

---

## Shared contract — Lane L0 (single owner, lands FIRST; everything depends on it)

**Goal:** replace the two closed deploy unions with a **provider registry**, add a **mobile-toolchain** port, and add an
optional **signing** hook — without breaking the existing Cloudflare/GitHub-Releases/fastlane paths (port them onto the new seam).

**Owns (exclusive):** `surfaces/deploy/provider.ts`, `surfaces/deploy/registry.ts`, `surfaces/mobile/toolchain.ts`,
`surfaces/mobile/registry.ts`, `surfaces/signing/index.ts` (interface only), `config/app-config.schema.ts`,
delegation edits in `surfaces/web.ts` · `desktop.ts` · `ios.ts` · `android.ts` · `index.ts`. Also **creates empty stub
files** for every provider lane at its expected path (each stub then owned exclusively by its lane).

**Recommended contract (settle exact shape here, then hold it stable — provider lanes build against this text):**

```ts
// surfaces/deploy/provider.ts
export interface DeployProvider {
  readonly target: string;                    // discriminator used in app.yml `deploy.target`
  readonly configSchema: z.ZodTypeAny;        // provider-specific fields (validated by the registry at load)
  deploy(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult>;
}
// surfaces/deploy/registry.ts — target → DeployProvider; getDeployProvider(target); validateDeployConfig(cfg)

// surfaces/mobile/toolchain.ts
export interface MobileToolchain {         // "match" (fastlane, exists) | "eas"
  readonly name: string;
  build(ctx: ReleaseContext, cfg: unknown): Promise<BuildResult>;
  test(ctx: ReleaseContext, cfg: unknown): Promise<TestResult>;
  submit(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<DeployResult>;
}

// surfaces/signing/index.ts  (desktop pre-deploy)
export interface SigningStep {             // runs between build and deploy when `desktop.signing.enabled`
  sign(ctx: ReleaseContext, build: BuildResult, cfg: unknown): Promise<BuildResult>;
}
```

**Schema changes (`app-config.schema.ts`):**
- Replace `WebDeploySchema`/`DesktopDeploySchema` closed unions with `DeployTargetSchema = z.object({ target: z.string().min(1) }).passthrough()`, validated against `registry.validateDeployConfig` (keep `cloudflare_pages`, `github_releases`, `local_dir` registered so nothing regresses).
- Add `toolchain: z.enum(["match","eas"]).default("match")` to `IosSurfaceSchema`/`AndroidSurfaceSchema`; keep existing fastlane fields optional-when-eas.
- Add optional `signing` block to `DesktopSurfaceSchema`: `{ enabled: boolean, platform: "macos"|"windows", ...SECRET refs }` — **default `enabled:false`**.

**Registry-stub mechanism (this is how the swarm avoids collisions):** L0 writes `registry.ts` importing each provider from its own module path and creates each module as a **stub** exporting a `DeployProvider` whose `deploy()` throws `NOT_IMPLEMENTED`. Each provider lane then **fills its own stub file only** — no lane ever edits `registry.ts` or another provider. `npm run build`/`npm test` stay green throughout (stubs compile; unused targets never run).

**Done when:** `npm run build` + `npm test` green; the three pre-existing targets (`cloudflare_pages`, `github_releases`, `local_dir`) and the `match` toolchain pass through the new registry unchanged (regression-tested); all stub files + interfaces exist and compile.

---

## Provider lanes (READY the moment L0 merges; each owns exactly one stub file)

| Lane | Owns (exclusive) | Build | Unblocks apps | Live gate |
|---|---|---|---|---|
| **L1 · generic command** ⭐ | `surfaces/deploy/command.ts` | `deploy.command` shell string → run via `runner.run`; `previewUrl` from `deploy.url` | pawsport, audience, robo.learn (interim), automation/kalshi, **any app** | app's own deploy creds |
| **L2 · Vercel** | `surfaces/deploy/vercel.ts` | `runArgv("vercel", ["deploy","--prod","--token",…,"--yes"])`, parse prod URL | slot-sense | `VERCEL_TOKEN` |
| **L3 · Fly.io** | `surfaces/deploy/fly.ts` | `runArgv("flyctl", ["deploy","--app",…])` | elevation-broker, pawsport backend | `FLY_API_TOKEN` |
| **L4 · GitHub Pages** | `surfaces/deploy/github-pages.ts` | publish build output to Pages (`gh`/actions or `gh api`); url = `<user>.github.io/<repo>` | Portfolio, giftkeeper privacy page | `GITHUB_TOKEN` |
| **L5 · itch.io** | `surfaces/deploy/itch.ts` | `runArgv("butler", ["push", outputDir, "user/game:channel"])` | hexy | `BUTLER_API_KEY` |
| **L6 · AWS/Terraform** | `surfaces/deploy/aws.ts` | `terraform apply -auto-approve` in a configured dir (or defer to L1 generic w/ a TF recipe) | robo.learn | `AWS_*` + TF state |
| **L7 · EAS mobile toolchain** | `surfaces/mobile/eas.ts` | `eas build --non-interactive` + `eas submit`; land at `uploaded`, reuse the ASC review poll | tenzy (iOS+Android), giftkeeper (iOS) | `EXPO_TOKEN` + ASC key/Play JSON (Gate #2) |
| **L8 · desktop signing** | `surfaces/signing/macos.ts`, `surfaces/signing/windows.ts` | macOS Developer ID **notarize+staple** (`xcrun notarytool`/`stapler`); Windows Authenticode (`signtool`) **built but `enabled:false`** | command-center (macOS); topplicant (Windows, deferred) | `APPLE_*`; Windows deferred |

Each provider lane's **done** = its stub is implemented; an **offline/dry-run unit test** proves the argv/command it *would* run and its result-parsing (mock `CommandRunner`), mirroring how the existing web/desktop adapters are tested; `npm test` green. The **live** leg is verified later, per app, when G-CREDS lands — not a blocker to merging the code.

---

## Non-provider lanes (independent; run alongside)

- **L9 · App onboarding sub-swarm** — owns `apps/<slug>/` (one dir per app) + adds channel entries. Ready after **L0 + L1** (every app is expressible via the generic provider immediately, then upgraded to its specific provider as L2–L8 land). **Fan out one agent per app** (they're independent files). Each writes `apps/<slug>/app.yml` from the app's real toolchain (see coverage matrix) with `SECRET:` placeholders, runs `halyard app init`-style validation + `halyard preflight --probe off`. Apps to onboard: hexy, tenzy, giftkeeper, command-center, topplicant, pawsport, audience, robo.learn, slot-sense, Portfolio, automation/kalshi, elevation-broker (+ any other releasable repo).
- **L10 · Publicity channel expansion** — owns `publicity/publishers.ts` (+ new notifier preset modules). Add **owned**-channel publishers (still generic HTTP POST) and Slack/Discord **webhook notifier** presets for the approval queue. Third-party (X/LinkedIn/HN/Reddit/Product Hunt) stays **draft-only** — you may add *drafters/templates* for them, never a posting client (invariant #5).
- **L11 · Preflight as the launch gate** — owns `coordinator/preflight.ts`. Extend so `halyard preflight` is the single per-app "ready to launch?" gate: probe every configured provider's creds + surface config; exit non-zero if a required `SECRET:` is unresolved. This becomes the operator's Gate-2 checklist in code.
- **L12 · Self-host entitlement** — owns `licensing/*`. Provide a *supported* path for the owner to run multi-app acting across their own portfolio (self-issued Pro key **or** a `HALYARD_SELF_HOST` entitlement that unlocks multi-app while keeping the open-core gate for external users). Resolves **G-LICENSE**. Document in L13.
- **L13 · Docs + credential matrix + demo** — owns `docs/`, `README.md`, `scripts/demo.ts`, new `docs/PROVIDERS.md` + `docs/CREDENTIALS.md`. Author the **Gate #2 creds → `SECRET:` ref** matrix (which env var each provider/app needs) and extend `npm run demo` to walk build→sign→deploy→flip→live→publicity for one app per provider family (all offline defaults).
- **L14 · Android Play review poll** *(optional, low priority)* — owns a new `coordinator/sources/play-review.ts`. iOS has an ASC review poll; Android has none. Only matters if you want `in_review → live` projection from Play truth rather than the flag flip. Skippable at first.
- **L15 · Halyard release hygiene** *(operator/human)* — merge open **PR #28** (web console) if not already on `main`, verify **G-CI**, cut the **`v0.1.0`** git tag (it's the Wave-0 "free tag" item). Cross-reference `halyard-cc-plugin-manifest-handoff.md` for wiring Halyard into Command Center as an app-plugin — that is a **separate** effort, not in this swarm.

---

## Per-app coverage matrix (which lane makes each app launchable through Halyard)

| App | Surface | Provider / toolchain | Lane | Notes |
|---|---|---|---|---|
| slot-sense | web | Vercel | L2 | + A2P/Twilio creds are the app's own gate |
| Portfolio | web | GitHub Pages | L4 | self-serve; no store gate |
| elevation-broker | web | Fly | L3 | has `fly.toml` already |
| pawsport | web (+api) | Fly / generic | L3/L1 | backend + Next front; Stripe verify exists |
| audience | web | generic / Fly | L1/L3 | custom infra |
| robo.learn | web | AWS/Terraform | L6 (or L1) | EKS/Terraform; generic works interim |
| automation/kalshi | — | generic (systemd) | L1 | **coordination-only**; live trading stays a human gate |
| tenzy | ios+android | EAS | L7 | iOS creds present; Android needs Play JSON |
| giftkeeper | ios | EAS | L7 | + privacy page via L4; store assets are its own gate |
| hexy | desktop | itch.io (+ macOS sign) | L5 (+L8) | already has own signing CI — itch provider is the migration path |
| command-center | desktop | github_releases (exists) + macOS sign | L8 | also gated on **P3/P4 human spikes** (not this swarm) |
| topplicant | desktop | github_releases (exists) + Windows sign | L8 | Windows signing **deferred** |

---

## Integration order & reconciliation checkpoint

1. **L0** (shared contract) merges first — regression-green on the three existing targets + `match`.
2. **L1** (generic provider) next — instantly gives every app a path and unblocks onboarding.
3. **L2–L8** in parallel (each own file, no collisions).
4. **L9** onboarding fans out (generic first, upgrade to specific providers as they land).
5. **L10–L14** run independently throughout.
6. **L12 + L15** (operator/human): entitlement + release hygiene.
7. **Reconciliation checkpoint (offline, no creds):** `npm run build` green · `npm test` green (offline spine intact, every new provider has dry-run tests) · `npm run demo` walks a representative app per provider family through build→sign→deploy→flip→live→publicity in a temp dir · `halyard preflight --probe off` exits clean for **every** onboarded app. No live credential is required to pass this checkpoint — that is the point (safe offline default preserved).

## Rules of the road

- One lane = one branch/worktree; **touch only your owned files**. Provider lanes fill their own stub — never edit `registry.ts` or another provider.
- Keep the **offline spine green** at every step; add offline-defaulted tests for your provider (mock `CommandRunner`; assert the argv, not a live call).
- **Runtime values → `runArgv` (no shell); operator-config strings → `run`.** Never interpolate a runtime value into a shell string.
- Secrets are `SECRET:NAME` refs only. Never write, log, or default a raw credential.
- Respect invariants #2/#5, verify-only payments, and the Windows-signing deferral (build it, ship it off).
- Before "done": `npm run build && npm test` clean; show the new dry-run test passing.

## Out of scope (name it, don't do it)

- Auto-posting to third-party social (violates #5 + ToS). Draft + stage only.
- Any model deciding ship/flip/promote (violates #2).
- Command Center plugin-manifest wiring (separate handoff).
- Un-deferring Windows Authenticode (portfolio decision; code lands disabled).
- Moving money / write-path payments.

## Suggested skills

- **superpowers:brainstorming** — briefly, only if L0's registry/schema seam is ambiguous after reading the ground-truth files; settle the contract before fanning out.
- **superpowers:writing-plans** then **superpowers:test-driven-development** — L0 and each provider lane are test-first (mirror the existing adapter tests).
- **superpowers:dispatching-parallel-agents** — for the L9 per-app onboarding fan-out.
- **superpowers:verification-before-completion** — run the reconciliation checkpoint and paste the green output before claiming done.
- **codebase-digest** — if a lane needs more of Halyard's internals than the ground-truth section gives.
