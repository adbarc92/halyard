# Roadmap — forward-looking, not-yet-built

Halyard is feature-complete for launch (see [`LAUNCH-HANDOFF.md`](LAUNCH-HANDOFF.md)); everything
here is **post-launch / nice-to-have**, none of it blocks the first real launch. Items are ordered
by how soon they'd pay off, not by size. Detailed design specs live under
[`superpowers/specs/`](superpowers/specs/).

## ~~R-ONBOARD — frictionless app onboarding~~ · **DONE**

Shipped: `halyard app init` (alias `onboard`) scaffolds `apps/<slug>/app.yml` for the chosen
surfaces (iOS / Android / web / desktop), pre-filling `SECRET:NAME` refs + `REPLACE_ME` markers,
printing the per-surface secrets to set, and running `halyard preflight --probe off`. Non-clobbering
without `--force`; fully flag-drivable (and prompts at a TTY). Code in `src/halyard/onboard/`;
covered by `tests/onboard.test.ts`.

## Already-known deferred items (lower priority)

- **Web console auth hardening** — multi-user / RBAC, token rotation **UI**, OAuth (still deferred,
  YAGNI for a single operator). _Login rate-limiting and a documented `HALYARD_CONSOLE_TOKEN`
  rotation path shipped (in-memory limiter `web/src/lib/server/ratelimit.ts`)._ The shipped
  single-shared-token model (PR #45) is intentionally minimal; spec:
  [`superpowers/specs/2026-06-15-web-console-auth-design.md`](superpowers/specs/2026-06-15-web-console-auth-design.md).
- **Multi-writer concurrency control** — service-backend adapters are last-writer-wins by design;
  true concurrency needs optimistic locking + the hub server to test against. Spec:
  [`superpowers/specs/2026-06-10-service-backend-swarm-handoff.md`](superpowers/specs/2026-06-10-service-backend-swarm-handoff.md).
- **The hub server itself** — greenfield (DB, deploy, auth); out of this repo / a separate project.
- **R4 net-new vendors/channels** — new flag providers, publishers, store backends behind the
  existing ports; a genuine parallel swarm, gated behind small factory/config preps. Open only when
  chosen. Context: [`superpowers/specs/2026-06-11-post-r3-roadmap-handoff.md`](superpowers/specs/2026-06-11-post-r3-roadmap-handoff.md).

## Operational (not features)

- **GitHub Actions CI is billing-blocked** — PRs #44/#45 were merged on local verification only.
  Clear it in Settings → Billing so CI guards future PRs. (Tracked here so it isn't forgotten; it's
  an account action, not engineering.)
