<!-- graph:index -->
# Index

One line per doc: link | keywords | one sentence. A link ending in "/" covers a whole folder.
Regenerate with `graph.mjs init`; check with `graph.mjs lint`.

- [Halyard — Codebase Digest (for agents)](CODEBASE-DIGEST.md) | codebase, digest, architecture, state-machine, cli, contracts, navigation | Agent-oriented map of the code: architecture, key flows, CLI and library contracts, gotchas. Open to find which source file to change.
- [Credential matrix — Gate #2 creds → `SECRET:` ref / env var](CREDENTIALS.md) | credentials, secret, env-var, signing, deploy-target, gate-2 | Matrix of each provider, toolchain and surface to the credential and env var it needs. Open when arming a real integration.
- [Local demo — a full end-to-end run with no accounts](DEMO.md) | demo, offline, end-to-end, no-accounts, npm-run-demo | How to run the self-contained offline demo of a full launch with no accounts, and how it differs from other offline checks.
- [Embedding Halyard (using it as a library)](INTEGRATION.md) | library, embedding, dependency-injection, public-api, web-console, state-model | Guide to using Halyard as an imported library: public exports, injecting backends and secrets, the state contract, and the web console head.
- [Launch readiness — what's required to go live, and how to test it](LAUNCH-READINESS.md) | readiness, armed, safe-default, toggles, go-no-go, invariants, preflight | Requirements and checklist for going live: armed versus safe-default toggles, secrets, per-launch go/no-go, and pre-flight tests.
- [Launch playbook (go-live runbook)](LAUNCH.md) | launch, playbook, runbook, phases, flip, rollback, dry-run | Ordered go-live runbook with commands, expected output and rollback per phase, from prerequisites to the flag flip and watching. Open when executing a launch.
- [Licensing (open-core)](LICENSING.md) | license, pro, open-core, ed25519, self-host, key | Open-core licensing: which features are Pro, using and issuing signed offline keys, and self-hosting options.
- [Observability configuration (Sentry or equivalent)](OBSERVABILITY.md) | sentry, crash-free, alert, observability, triage, config | Setting up Sentry or equivalent crash and health signal: provider setup, Halyard config, out-of-band alert wiring and verification.
- [Payment processing (third-party integration)](PAYMENTS.md) | payments, payment-processing, provider, preflight, app.yml, verify | Configuring third-party payment processing per app, verifying it with preflight, and adding a provider.
- [Deploy providers, mobile toolchains & desktop signing](PROVIDERS.md) | deploy, providers, cloudflare, vercel, fly, mobile-toolchains, desktop-signing | Reference for deploy provider registry, web and desktop targets, mobile toolchains and desktop signing. Open to configure or add a deploy target.
- [Live smoke tests](SMOKE.md) | smoke, live-tests, real-credentials, integration, opt-in | Opt-in live smoke tests that verify each integration against the real provider once credentials are set; run before a real launch.
- [Halyard — Test Plan (pre-launch)](TEST-PLAN.md) | test-plan, rungs, coverage, exit-criteria, launch-ready, ci | Pre-launch test ladder from static gates to staged real launch, with exit criteria for launch-ready. Open to decide what to run before shipping.
