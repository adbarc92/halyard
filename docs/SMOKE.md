# Live smoke tests

Isolated, opt-in checks you run **once real credentials are set** — each verifies one
integration against the real provider, with nothing user-visible. They go beyond the offline
suite (`npm test`) and the fakes-only dry run (`npm run verify:launch`); run them before a real
launch. Order is cheapest → most involved.

| # | Check | Command | Pass signal |
|---|---|---|---|
| 1 | **Readiness** (flags read + payments live-probe + config) | `halyard preflight` | exit 0; every required row `reachable` / configured |
| 2 | **Flag WRITE round-trip** (preflight only reads) | `npm run smoke:flags -- --app <slug>` | `{ ok: true }`; sentinel left OFF |
| 3 | **Payments access** | `halyard payments verify --apps <slug>` | `reachable: true` |
| 4 | **Approval surface** reaches your phone | `gh workflow run maintenance.yml` (or any proposal) | the push notification arrives |
| 5 | **Sentry alert path** (out-of-band triage) | `gh workflow run sentry-alert.yml` → `halyard queue` | a `crash_triage` proposal appears (on a seeded spike) |
| 6 | **Release dry run** (full spine, fakes) | `npm run verify:launch` | ✅ ALL GREEN |

Notes:
- **#2** only touches a `smoke.<slug>.__roundtrip__` sentinel flag and leaves it OFF; delete it
  in the provider UI afterwards (the generic client has no delete).
- **#1/#3** are read-only. **#4** can't auto-confirm receipt — eyeball your phone.
- Run these per app (`--apps`/`--app <slug>`). A failure here means a real launch would fail
  the same way — fix before flipping a flag.
