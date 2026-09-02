# Changelog

All notable changes to Halyard are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- MIT `LICENSE`. ([#1](https://github.com/adbarc92/halyard/pull/1))
- This changelog.

### Fixed

- An unconfigured *optional* event source is now treated as **skipped**, not as an error, so a
  maintenance run no longer fails for a source the operator deliberately left unset.
  ([#2](https://github.com/adbarc92/halyard/pull/2))

## [0.1.0] — 2026-07-23

Initial public release.

### Added

- **Event-driven release coordinator** modelling a multi-platform launch (iOS, Android, web,
  desktop) as one durable state machine, rather than as a linear pipeline that cannot survive an
  hours-to-days store review.
- **Git-backed durable coordinator**, so state survives process restarts and is auditable as
  ordinary commits.
- **Event sources on one bus** — CI, store-review polling, the flag provider, and Sentry.
- **The flag flip as the real launch**, held as a deliberate human action:
  `halyard flip --flag <name> --state on`.
- **Reusable spine** — CLI, library, and CI workflows, built for a multi-app shop.
- **Fully offline defaults.** `npm run demo` walks a complete launch end-to-end in a temp
  directory with no accounts and no network.

[Unreleased]: https://github.com/adbarc92/halyard/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/adbarc92/halyard/releases/tag/v0.1.0
