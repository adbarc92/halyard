# Web Auto-Promote (F2) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Wire `promote_gate: false` so a standalone web release auto-promotes to `live` on deploy — its flag is created **born ON** (single `setState`), and the existing flag-poll projects `uploaded → live` via an inline scoped reconcile. (Per [the design](../specs/2026-06-11-web-auto-promote-design.md).)

**Architecture:** A new helper `coordinator/auto-promote.ts` (`autoPromoteWebRelease`) called from `cli.ts` `releaseRun` after `runRelease`. The flag key + reserved prefix live in the leaf `flags/naming.ts`. Graduation skips the reserved namespace; a `FlagsSchema.naming` refine reserves it. **No new state, no state-machine change, no schema-shape change** — only the helper, CLI wiring, a graduation skip, a naming refine, and stale-comment fixes.

**Tech Stack:** TypeScript (ESM/NodeNext, strict + `noUncheckedIndexedAccess` + `exactOptionalPropertyTypes`), Vitest.

---

## File structure

**Create:**
- `src/halyard/coordinator/auto-promote.ts` — `autoPromoteWebRelease(opts): Promise<Release>` (guards + born-ON + inline projection).
- `tests/auto-promote.test.ts` — helper behavior + the e2e flow (deploy→live, rollback, redeploy-no-op).

**Modify:**
- `src/halyard/flags/naming.ts` — add `AUTO_PROMOTE_PREFIX` + `autoPromoteFlagKey(slug, version)`.
- `src/halyard/coordinator/graduation.ts` — skip reserved-namespace flags.
- `src/halyard/config/app-config.schema.ts` — `FlagsSchema.naming` refine forbidding the `halyard.` prefix; refresh the stale `promote_gate` comment.
- `src/halyard/contracts/release.schema.ts` — fix the stale "requires …a launch" comments (comment-only; the refine already checks only `flag`).
- `src/halyard/cli.ts` — `releaseRun`: call the helper after `runRelease`, print/return the resulting release's state.
- `tests/naming.test.ts` (create if absent) / `tests/graduation.test.ts` / `tests/service-config.test.ts`-style config test — see tasks.

**Dependency order:** naming (T1) → helper + release.schema comment fix (T2) → graduation skip (T3) → config refine + promote_gate comment (T4) → cli wiring + e2e (T5) → verify + PR (T6).

All commands run from repo root `d:/MajorProjects/INFRASTRUCTURE/halyard`. **You are on branch `docs/auto-promote-design`** (it carries the design + this plan; commit the implementation here so design+plan+code bundle into one PR). Verify with `git rev-parse --abbrev-ref HEAD`. No `Co-Authored-By`/"Generated with" lines.

---

### Task 1: Reserved namespace + flag key in the leaf module

**Files:**
- Modify: `src/halyard/flags/naming.ts`
- Test: `tests/naming.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/naming.test.ts
import { describe, expect, it } from "vitest";
import { flagKeyFor, autoPromoteFlagKey, AUTO_PROMOTE_PREFIX } from "../src/halyard/flags/naming.js";

describe("flag naming", () => {
  it("flagKeyFor expands the pattern", () => {
    expect(flagKeyFor("launch.{slug}.{feature}", "acme", "beta")).toBe("launch.acme.beta");
  });

  it("autoPromoteFlagKey uses the reserved namespace + a sanitized version", () => {
    expect(autoPromoteFlagKey("acme", "1.4.0")).toBe("halyard.autopromote.acme.1.4.0");
    expect(AUTO_PROMOTE_PREFIX).toBe("halyard.autopromote.");
    expect(autoPromoteFlagKey("acme", "1.4.0").startsWith(AUTO_PROMOTE_PREFIX)).toBe(true);
  });

  it("autoPromoteFlagKey slugifies an unsafe (non-semver) version to one safe segment", () => {
    expect(autoPromoteFlagKey("acme", "2024/06/release one")).toBe("halyard.autopromote.acme.2024-06-release-one");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/naming.test.ts`
Expected: FAIL — `autoPromoteFlagKey`/`AUTO_PROMOTE_PREFIX` not exported.

- [ ] **Step 3: Implement**

Append to `src/halyard/flags/naming.ts`:
```ts
/**
 * Reserved flag namespace for web auto-promote (`promote_gate: false`). Kept here in the leaf
 * naming module so both the auto-promote helper and graduation can import it without coupling to
 * the reconcile subsystem. Graduation skips this namespace; `flags.naming` may not use it.
 */
export const AUTO_PROMOTE_PREFIX = "halyard.autopromote.";

/** Per-version born-ON flag key for a standalone auto-promoted web release. Version is slugified
 *  to a single safe segment (semver is only conditionally validated upstream). */
export function autoPromoteFlagKey(slug: string, version: string): string {
  const safeVersion = version.replace(/[^A-Za-z0-9.]+/g, "-");
  return `${AUTO_PROMOTE_PREFIX}${slug}.${safeVersion}`;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/naming.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/flags/naming.ts tests/naming.test.ts
git commit -m "feat(flags): reserved auto-promote namespace + autoPromoteFlagKey"
```

---

### Task 2: `autoPromoteWebRelease` helper

**Files:**
- Create: `src/halyard/coordinator/auto-promote.ts`
- Modify: `src/halyard/contracts/release.schema.ts` (stale-comment fix — comment only)
- Test: `tests/auto-promote.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/auto-promote.test.ts
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { autoPromoteWebRelease } from "../src/halyard/coordinator/auto-promote.js";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { newRelease, appendTransition } from "../src/halyard/coordinator/record-store.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import type { AppConfig } from "../src/halyard/config/app-config.schema.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";

let stateDir: string;
const now = () => "2026-06-11T00:00:00.000Z";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-autopromote-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

// Minimal app config; HALYARD_LIVE_FLAGS is unset so makeFlagClient resolves the FlagFileClient.
function webApp(promoteGate: boolean): AppConfig {
  return {
    app: { slug: "acme" },
    flags: { provider: "file", api_key_ref: "SECRET:X", naming: "launch.{slug}.{feature}", graduate_after_days: 14 },
    surfaces: { web: { promote_gate: promoteGate } },
  } as unknown as AppConfig;
}

/** A web release that deployed (at `uploaded`), standalone (no launch, no flag). */
function deployedWeb(version = "1.4.0"): Release {
  let r = newRelease({ releaseId: `rel_acme_web_${version}`, app: "acme", surface: "web", version });
  for (const to of ["tagged", "built", "tested", "uploaded"] as const) r = appendTransition(r, to, "ci", now);
  return r;
}

describe("autoPromoteWebRelease", () => {
  it("promote_gate:false + standalone web at uploaded → born-ON flag, release.flag set, projected live", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb();
    await backend.records.write(release);

    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });

    expect(result.flag).toBe("halyard.autopromote.acme.1.4.0");
    expect(result.state).toBe("live");
    // Born ON in the provider, single write.
    expect(await new FlagFileClient(stateDir, now).getState("halyard.autopromote.acme.1.4.0")).toBe("on");
    // Persisted live record carries the flag, launch_id still null.
    const stored = await backend.records.read(release.release_id);
    expect(stored!.state).toBe("live");
    expect(stored!.launch_id).toBeNull();
  });

  it("promote_gate:true → no-op (stays uploaded, no flag)", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb();
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(true), surface: "web", stateDir, backend, now });
    expect(result.flag).toBeNull();
    expect(result.state).toBe("uploaded");
    expect(existsSync(join(stateDir, "flags"))).toBe(false);
  });

  it("non-web surface → no-op", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = { ...deployedWeb(), surface: "ios" as const };
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "ios", stateDir, backend, now });
    expect(result.flag).toBeNull();
  });

  it("failed deploy (stranded at tested, not uploaded) → no-op", async () => {
    const backend = makeGitBackend({ stateDir });
    let r = newRelease({ releaseId: "rel_acme_web_2.0.0", app: "acme", surface: "web", version: "2.0.0" });
    for (const to of ["tagged", "built", "tested"] as const) r = appendTransition(r, to, "ci", now);
    await backend.records.write(r);
    const result = await autoPromoteWebRelease({ release: r, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(result.flag).toBeNull();
    expect(result.state).toBe("tested");
  });

  it("already-bound (flag set) → no-op (idempotent across re-runs)", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = { ...deployedWeb(), flag: "halyard.autopromote.acme.1.4.0" };
    await backend.records.write(release);
    const result = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(result.state).toBe("uploaded"); // unchanged; helper short-circuits
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/auto-promote.test.ts`
Expected: FAIL — cannot find module `auto-promote.js`.

- [ ] **Step 3: Implement the helper**

```ts
// src/halyard/coordinator/auto-promote.ts
import type { AppConfig } from "../config/app-config.schema.js";
import type { Surface } from "../config/primitives.js";
import type { Release } from "../contracts/release.schema.js";
import { autoPromoteFlagKey } from "../flags/naming.js";
import { makeFlagClient } from "../flags/select.js";
import type { Backend } from "./ports.js";
import { reconcile } from "./reconcile.js";
import { flagPollSource } from "./sources/flag-poll.js";

/**
 * Web auto-promote (`promote_gate: false`). For a STANDALONE web release that has actually deployed
 * (at `uploaded`, no launch, no flag), create its per-version flag **born ON** (a single
 * `setState`, no born-OFF window) and run a scoped flag-poll reconcile so it reaches `live` on
 * deploy. Rollback is the normal `flip … off → rolled_back`; a redeploy is a no-op (the `flag`
 * guard). Any non-matching case is a no-op returning the input release unchanged.
 *
 * Lives at the CLI release-path layer (not a reconcile source — invariant #1 keeps sources
 * read-only; not in `runRelease` — that stays surface-agnostic).
 */
export async function autoPromoteWebRelease(opts: {
  release: Release;
  app: AppConfig;
  surface: Surface;
  stateDir: string;
  backend: Backend;
  now: () => string;
}): Promise<Release> {
  const { release, app, surface, stateDir, backend, now } = opts;
  if (
    surface !== "web" ||
    app.surfaces.web?.promote_gate !== false ||
    release.state !== "uploaded" ||
    release.launch_id !== null ||
    release.flag !== null
  ) {
    return release; // not an auto-promote case
  }

  const flag = autoPromoteFlagKey(app.app.slug, release.version);
  const client = makeFlagClient([app], stateDir, now); // single app in scope; reused by the inline reconcile
  await client.setState(flag, true); // create-or-update in one write — born ON
  await backend.records.write({ ...release, flag });

  // Inline, scoped, flag-poll-only projection so the release is live ON DEPLOY (releaseRun does not
  // otherwise reconcile). Reuses the SAME client we wrote to, so the projection is consistent.
  await reconcile({
    backend,
    sources: [flagPollSource(client)],
    now,
    loadReleaseIds: () => [release.release_id],
  });
  return (await backend.records.read(release.release_id)) ?? { ...release, flag };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/auto-promote.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Fix the stale schema comments (comment-only)**

In `src/halyard/contracts/release.schema.ts`, replace the comment at lines 44-45:
```ts
    // A release is created by a tag and only bound to a launch at M4; until then
    // these are null. The flag-flip transition (`live`) requires both — enforced below.
```
with:
```ts
    // A release is created by a tag and MAY be bound to a launch (M4); until then this is null.
    // A standalone auto-promoted web release reaches `live` with launch_id still null — only a
    // non-null flag is required for live/rolled_back (enforced below).
```
And replace the superRefine comment at lines 58-59:
```ts
    // Invariant #3 corollary: the launch moment (flag flip) cannot exist without a
    // flag and a launch to belong to. The earlier states deliberately don't need them.
```
with:
```ts
    // Invariant #3 corollary: the launch moment (flag flip) cannot exist without a flag. Earlier
    // states don't need one. (launch_id is NOT required at live — auto-promoted web is standalone;
    // do NOT add a launch_id check here or every auto-promoted release fails validation.)
```

- [ ] **Step 6: Run the full suite to confirm the comment change broke nothing**

Run: `npx vitest run && npm run typecheck`
Expected: all green; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/halyard/coordinator/auto-promote.ts tests/auto-promote.test.ts src/halyard/contracts/release.schema.ts
git commit -m "feat(coordinator): autoPromoteWebRelease helper (born-ON flag + inline projection)"
```

---

### Task 3: Graduation skips the reserved namespace

**Files:**
- Modify: `src/halyard/coordinator/graduation.ts`
- Test: `tests/graduation.test.ts` (append a case)

- [ ] **Step 1: Write the failing test** — append inside the existing top-level `describe` in `tests/graduation.test.ts`:

```ts
  it("does NOT propose removing a reserved auto-promote flag, even past the window", async () => {
    const { makeGitBackend } = await import("../src/halyard/coordinator/git-backend.js");
    const backend = makeGitBackend({ stateDir });
    let r = newRelease({ releaseId: "rel_acme_web_1.4.0", app: "acme", surface: "web", version: "1.4.0" });
    r = { ...r, flag: "halyard.autopromote.acme.1.4.0" };
    for (const [to, at] of [
      ["tagged", "2025-01-02T00:00:00.000Z"], ["built", "2025-01-02T00:01:00.000Z"],
      ["tested", "2025-01-02T00:02:00.000Z"], ["uploaded", "2025-01-02T00:03:00.000Z"],
      ["live", "2025-01-05T00:00:00.000Z"],
    ] as [string, string][]) r = appendTransition(r, to as never, "test", () => at);
    await backend.records.write(r);

    const created = await proposeFlagGraduations({
      backend,
      now: () => "2025-06-15T00:00:00.000Z", // long past any window
      thresholdDaysByApp: { acme: 14 },
      launchFlagPrefixByApp: { acme: "halyard." }, // even with a matching prefix, reserved flags are exempt
    });
    expect(created).toHaveLength(0);
  });
```

(Note: this test uses `backend` + `proposeFlagGraduations` + `newRelease`/`appendTransition` — match the imports already at the top of `graduation.test.ts`; add `makeGitBackend` via the inline `await import` shown, or to the file's imports.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/graduation.test.ts`
Expected: FAIL — the reserved flag IS proposed (1 created), because `"halyard.autopromote.…".startsWith("halyard.")` matches the launch prefix.

- [ ] **Step 3: Implement the skip**

In `src/halyard/coordinator/graduation.ts`, add the import at the top:
```ts
import { AUTO_PROMOTE_PREFIX } from "../flags/naming.js";
```
Then, immediately after the existing guard line (`if (!release || release.state !== "live" || !release.flag) continue;`), add:
```ts
    // Reserved auto-promote flags are operational continuous-deploy kill-switches, not launch
    // flags — never propose removing them (they govern the currently-live web version).
    if (release.flag.startsWith(AUTO_PROMOTE_PREFIX)) continue;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/graduation.test.ts`
Expected: PASS (existing cases + the new one).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/graduation.ts tests/graduation.test.ts
git commit -m "feat(coordinator): graduation exempts the reserved auto-promote namespace"
```

---

### Task 4: `FlagsSchema.naming` reserves the namespace + refresh `promote_gate` comment

**Files:**
- Modify: `src/halyard/config/app-config.schema.ts`
- Test: `tests/flags-naming-refine.test.ts` (create)

- [ ] **Step 1: Write the failing test**

```ts
// tests/flags-naming-refine.test.ts
import { describe, expect, it } from "vitest";
import { AppConfigSchema } from "../src/halyard/config/app-config.schema.js";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { parse as parseYaml } from "yaml";

const here = dirname(fileURLToPath(import.meta.url));
const auroraRaw = parseYaml(readFileSync(resolve(here, "..", "apps", "aurora", "app.yml"), "utf8"));

describe("flags.naming reserved namespace", () => {
  it("rejects a naming pattern using the reserved 'halyard.' prefix", () => {
    const bad = { ...auroraRaw, flags: { ...auroraRaw.flags, naming: "halyard.{slug}.{feature}" } };
    expect(() => AppConfigSchema.parse(bad)).toThrow(/reserved 'halyard\.' namespace/);
  });

  it("still accepts the existing aurora fixture (launch.* naming)", () => {
    expect(() => AppConfigSchema.parse(auroraRaw)).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/flags-naming-refine.test.ts`
Expected: FAIL — the `halyard.`-prefixed naming is accepted (no refine yet).

- [ ] **Step 3: Implement the refine + comment refresh**

In `src/halyard/config/app-config.schema.ts`, the `FlagsSchema` `naming` field is currently:
```ts
    naming: z.string().min(1), // e.g. "launch.{slug}.{feature}" — flags born OFF
```
Replace it with:
```ts
    naming: z
      .string()
      .min(1)
      .refine((n) => !n.startsWith("halyard."), {
        message: "flags.naming must not use the reserved 'halyard.' namespace (used by web auto-promote)",
      }), // e.g. "launch.{slug}.{feature}" — launch flags born OFF
```
And refresh the now-stale `promote_gate` comment (currently ending "Auto-promote (false → live on deploy) is not yet wired."):
```ts
    // When true, web's promote-to-prod gate IS the manual flag flip: the build rests at
    // `uploaded` and goes `live` only when the flag is flipped ON (see flag-poll). When false,
    // a STANDALONE web release auto-promotes — its flag is born ON on deploy (coordinator/
    // auto-promote.ts) so flag-poll projects it `live`; rollback is the usual flip-off.
    promote_gate: z.boolean(),
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/flags-naming-refine.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/config/app-config.schema.ts tests/flags-naming-refine.test.ts
git commit -m "feat(config): reserve halyard. flag namespace; document promote_gate auto-promote"
```

---

### Task 5: Wire `releaseRun` + the end-to-end flow

**Files:**
- Modify: `src/halyard/cli.ts` (`releaseRun`, lines ~118-144)
- Test: `tests/auto-promote.test.ts` (append the e2e flow)

- [ ] **Step 1: Write the failing test** — append to `tests/auto-promote.test.ts`:

```ts
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { FlagFileClient as FFC2 } from "../src/halyard/flags/file-client.js";

describe("auto-promote end-to-end (rollback + redeploy)", () => {
  it("rolls back via flip-off and a redeploy does NOT un-rollback", async () => {
    const backend = makeGitBackend({ stateDir });
    const release = deployedWeb("3.0.0");
    await backend.records.write(release);

    // Deploy → live.
    const live = await autoPromoteWebRelease({ release, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(live.state).toBe("live");

    // Operator rolls back: flip the flag OFF, then reconcile → rolled_back.
    const client = new FFC2(stateDir, now);
    await client.setState("halyard.autopromote.acme.3.0.0", false);
    await reconcile({ backend, sources: [flagPollSource(client)], now, loadReleaseIds: () => [release.release_id] });
    expect((await backend.records.read(release.release_id))!.state).toBe("rolled_back");

    // Redeploy: re-run the helper for the SAME (now flag-bound) release → no-op (stays rolled_back).
    const after = await backend.records.read(release.release_id);
    const redeploy = await autoPromoteWebRelease({ release: after!, app: webApp(false), surface: "web", stateDir, backend, now });
    expect(redeploy.state).toBe("rolled_back");
  });
});
```

- [ ] **Step 2: Run test to verify it fails (or passes — it exercises the helper directly)**

Run: `npx vitest run tests/auto-promote.test.ts`
Expected: PASS — the helper already supports this (the guard makes the redeploy a no-op). If it FAILS, the guard/rollback logic is wrong; fix the helper, not the test. (This test locks in the rollback-durability behavior.)

- [ ] **Step 3: Wire `releaseRun`**

In `src/halyard/cli.ts`, add the import near the other coordinator imports:
```ts
import { autoPromoteWebRelease } from "./coordinator/auto-promote.js";
```
Then in `releaseRun`, replace the block from `const release = await runRelease({` through the `console.log(...)` (lines ~122-140) with:
```ts
  const now = () => new Date().toISOString();
  const release = await runRelease({
    app,
    surface,
    version,
    commit,
    backend,
    workdir,
    runner: new ShellCommandRunner(),
    now,
    log: (m) => console.error(m),
  });

  // Web auto-promote: a standalone web release with promote_gate:false gets a born-ON flag and is
  // projected live on deploy. A no-op for every other case (returns `release` unchanged).
  const finalRelease = await autoPromoteWebRelease({ release, app, surface, stateDir, backend, now });

  console.log(
    JSON.stringify(
      { release_id: finalRelease.release_id, state: finalRelease.state, record: releasePath(stateDir, finalRelease.release_id) },
      null,
      2,
    ),
  );
```
And update the exit-code line to use `finalRelease`:
```ts
  return releaseSucceeded(finalRelease.state) ? 0 : 1;
```

- [ ] **Step 4: Run typecheck + full suite**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; full suite green (the existing cli-dispatch/release tests still pass — a `promote_gate: true` fixture like aurora makes `releaseRun` call the helper, which no-ops).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/cli.ts tests/auto-promote.test.ts
git commit -m "feat(cli): wire web auto-promote into release run"
```

---

### Task 6: Full verification + PR

**Files:** none (verification + PR).

- [ ] **Step 1: Full verification**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; **all tests green** (258 baseline + the new naming/auto-promote/graduation/config tests).

- [ ] **Step 2: Build + web (library exports changed in `flags/naming.ts`)**

Run: `npm run build && npm run -w web test && npm run -w web check`
Expected: build clean; web tests pass; svelte-check 0 errors.

- [ ] **Step 3: Open the PR (bundles design + plan + implementation)**

```bash
git push -u origin docs/auto-promote-design
gh pr create --base main --title "feat: web auto-promote (promote_gate:false) — F2" --body "Implements F2 per docs/superpowers/specs/2026-06-11-web-auto-promote-design.md (design + plan included). Standalone web releases with promote_gate:false get a born-ON reserved-namespace flag and are projected live on deploy via an inline scoped reconcile; rollback via flip-off; redeploy is a no-op; graduation exempts the reserved namespace; flags.naming reserves it. No state-machine/schema-shape change. Hardened through 3 critique rounds."
```

---

## Notes for the implementer
- **Born ON in one write:** use a single `client.setState(flag, true)` — do NOT call `ensureFlag` first (it would write the flag OFF, then ON; both clients' `setState` is create-or-update). The design's Round-3 fix.
- **The guard order matters:** `state === "uploaded"` excludes a failed deploy (stranded at `tested`); `launch_id === null && flag === null` makes it standalone-only and idempotent across re-runs. Don't drop any condition.
- **Do NOT** add a `launch_id` check to `release.schema.ts`'s `live` refinement — a standalone auto-promoted release is `live` with `launch_id: null` by design; checking it would break every auto-promoted record.
- **No state-machine/schema-shape change.** If you find yourself editing `state-machine.ts`, `contracts/state.js`, or adding a schema field, stop — you've left the design.
- `makeFlagClient([app], …)` (single app in scope), NOT `loadApps(flags)` — the inline reconcile reuses the same client, so the deploy-time projection is consistent by construction.
