<!-- graph:router -->
# halyard — router

Halyard is an event-driven, git-backed release and publicity coordinator (CLI, library, CI workflows) for multi-app shops: the flag flip is the launch.
Offline-by-default and feature-complete per its docs; web-console auth work was in flight. See [state](state.md).

## Where things live

- [index](index.md) lists every doc with one sentence each; [state](state.md) holds what survives between sessions.
- [README](../README.md): operator manual and honest status. [design](../design.md): the why.
- [CODEBASE-DIGEST](CODEBASE-DIGEST.md): code map. [CHANGELOG](../CHANGELOG.md).
- `src/halyard/`: spine. `web/`: console. `apps/`: app configs. `tests/`.

## Read first, by task

- Find code to change: [CODEBASE-DIGEST](CODEBASE-DIGEST.md)
- Go live: [LAUNCH](LAUNCH.md), then [LAUNCH-READINESS](LAUNCH-READINESS.md)
- Arm credentials: [CREDENTIALS](CREDENTIALS.md)
- Embed as a library: [INTEGRATION](INTEGRATION.md)
- Decide what to test: [TEST-PLAN](TEST-PLAN.md)

## Never

- No CLAUDE.md or AGENTS.md exists; hard rules are in [README](../README.md) Status and [LAUNCH-READINESS](LAUNCH-READINESS.md) invariants.
