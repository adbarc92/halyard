# Local demo — a full end-to-end run with no accounts

```bash
npm run demo            # runs it, prints each step + the equivalent CLI command, cleans up
npm run demo -- --keep  # keep the temp state/work dirs to poke around
```

`npm run demo` drives the **real** coordinator spine end-to-end on your machine — real web
build, real `local_dir` deploy, real flag flip, real reconcile, real publicity — all in
throwaway temp dirs. **No external accounts, no provider, nothing published.** It's the closest
thing to a real launch you can run locally, and it narrates the `halyard` command behind each
step so it doubles as a guided tour:

```
1. Release: build → test gate → deploy            (lands at `uploaded`)
2. Create the launch                              (flag born OFF)
3. Link the release to the launch
4. Flip the flag ON                               (the launch moment)
5. Reconcile                                      (projects the flip → `live`)
6. Publicity fan-out                              (owned auto-publishes; third-party stages)
7. Status + approval queue                        (inspect the result + the staged post)
```

You'll see the release reach `live`, an owned-channel post auto-published to disk, a
third-party post staged in the approval queue (never auto-posted), and a deployed
`preview/.../index.html` you can open.

### How it stays self-contained

The demo app config is `scripts/demo-app.yml` — deliberately **not** under `apps/`, so it's
never auto-discovered and the example repo stays single-app (its free-tier workflows keep
working). It's web-only with a no-op build and the `local_dir` deploy target, and the flag
provider/publisher/notifier all use the git-backed file clients.

### vs. the other offline checks

| | What it exercises |
|---|---|
| `npm test` | the unit/integration suite (logic, gates, invariants) |
| `npm run verify:launch` | the full spine with **fakes** (faked build + ASC); fast pass/fail of the projection logic |
| **`npm run demo`** | the full spine with the **real** adapters (real build, deploy, reconcile, publicity) writing real artifacts |

### When you need real accounts

Only the final mile — building/uploading a real binary to a store, flipping a flag in a real
provider, or posting to a real third-party channel — needs real credentials. Everything up to
and including `live` (locally) does not. When you're ready for the real thing, see
[LAUNCH.md](LAUNCH.md) (the ordered runbook) and [LAUNCH-READINESS.md](LAUNCH-READINESS.md),
and run `halyard preflight` to see exactly which secrets each integration needs.
