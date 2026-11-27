<!-- graph:state -->
# State

What survives between sessions. Read at the start of a session, append at the end.

## Current

- Spine runs offline and green: 470 tests, 91 web tests, per [TEST-PLAN](TEST-PLAN.md) and [CODEBASE-DIGEST](CODEBASE-DIGEST.md), re-verified 2026-10-12.
- Web-console auth boundary was the in-flight work, not yet merged when the digest was written: [CODEBASE-DIGEST](CODEBASE-DIGEST.md).
- Live providers are exercised only in CI/production: [README](../README.md) Status.

## Decisions

- The human flag flip, not store approval, is the launch; no model decides ship, promote, flip or post: [README](../README.md) Status.
- Windows Authenticode is built but ships disabled: [README](../README.md) Status.

## Dead ends

- Nothing recorded yet.

## Open

- Web-auth branch: green suite plus 7 manual auth checks, then merge: [TEST-PLAN](TEST-PLAN.md) exit criteria.
- Rung 3 smoke per integration and live preflight before first launch: [TEST-PLAN](TEST-PLAN.md).
