> ## ⚠️ DEPRECATED — EXECUTED (PR #28)
> This plan is fully implemented; the web console ships in the `web/` workspace. Retained as a
> historical build log. Console follow-ups (live flag provider in UI, sub-path embedding, full
> reconcile orchestration) are tracked in
> [`../specs/2026-06-10-remaining-work-swarm-handoff.md`](../specs/2026-06-10-remaining-work-swarm-handoff.md).

# Halyard Web Console Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a standalone SvelteKit web console (the "head") to Halyard that imports the `halyard` library and surfaces its operator workflow — release status board, approval queue + approve, flag flip, read-only launches/releases browse, and `coordinator_error` notifications — runnable credential-free against the CWD project.

**Architecture:** New `web/` npm workspace. All Halyard access is isolated behind one server-only module (`console-service.ts`), the TDD'd core. SvelteKit (adapter-node) serves the UI, a JSON `/api`, and `/health` from one Node process. Reconcile is transitions-only (flag poll, no publicity, no network); publicity stays the CLI/cron's job. The library is **not modified**.

**Tech Stack:** TypeScript (ESM, Node ≥20), SvelteKit + `@sveltejs/adapter-node`, Vite, Vitest, the `halyard` library (workspace symlink), `cross-env`.

**Source of truth:** `docs/superpowers/specs/2026-06-08-web-console-design.md`. Read it before starting.

---

## Library surface used (all already exported from `"halyard"` — verified; do not modify the library)

| Symbol | Signature (as used here) |
|---|---|
| `loadOrgConfig` | `(path: string) => OrgConfig` — throws `ConfigError` on missing/bad/invalid |
| `loadAppConfig` | `(path: string) => AppConfig` — throws `ConfigError` |
| `ConfigError` | `class extends Error` (thrown by the loaders) |
| `discoverAppSlugs` | `(appsDir: string) => string[]` — `[]` if `appsDir` absent (no throw) |
| `scanReleaseIds` | `(stateDir: string) => string[]` |
| `readRelease` | `(stateDir: string, releaseId: string) => Release \| null` |
| `summarizeRelease` | `(release: Release, now: string) => ReleaseStatus` — **`now` is a string** |
| `scanLaunchIds` | `(stateDir: string) => string[]` |
| `readLaunch` | `(stateDir: string, launchId: string) => Launch \| null` |
| `listProposals` | `(stateDir: string) => Proposal[]` — **all** statuses, no filter |
| `approveProposal` | `({stateDir, canonDir, proposalId, finalText?, now}) => {proposal, canonAppended}` |
| `FlagFileClient` | `new (stateDir: string, now?: () => string)`; `getState(key) => Promise<FlagState>`, `ensureFlag(key) => Promise<void>`, `setState(key, on) => Promise<void>` |
| `flagPollSource` | `(client: FlagClient) => ReconcileSource` |
| `reconcile` | `({stateDir, sources, now}) => Promise<ReconcileReport>` |
| `getEntitlement` | `() => Entitlement` |
| `enforceMultiApp` | `(appCount: number, entitlement: Entitlement) => void` — **throws** when `appCount > 1` and not licensed |
| Types | `Release`, `ReleaseStatus`, `Launch`, `Proposal`, `FlagState`, `OrgConfig`, `AppConfig`, `Entitlement` |

`ReleaseStatus` fields: `release_id, app, surface, version, state, waiting_on, last_transition, age_hours, flag, review_status, flag_state, stuck`.
`Proposal` fields: `proposal_id, kind, app, release_id?, launch_id?, flag?, channel?, surface?, severity?, recommendation?, title, body, status, created_at`. `status ∈ {open, approved, dismissed, resolved}`.

---

## File structure

```
halyard/
  package.json                         # MODIFY: add "workspaces": ["web"], web:* scripts, cross-env devDep
  web/                                 # NEW workspace @halyard/web (private)
    package.json
    svelte.config.js                   # adapter-node
    vite.config.ts                     # ssr.external halyard; vitest config
    tsconfig.json
    .gitignore
    src/
      app.html
      app.d.ts
      lib/server/
        clock.ts                       # now() helper
        project.ts                     # resolveRoot + loadProject (memoized) + types
        console-service.ts             # the testable core (reads + actions)
      routes/
        +layout.svelte                 # nav + degraded banner
        +layout.server.ts              # health → layout data
        +page.server.ts                # board load
        +page.svelte                   # status board
        health/+server.ts              # GET /health
        api/reconcile/+server.ts       # POST
        api/flip/+server.ts            # POST
        api/approve/+server.ts         # POST
        queue/+page.server.ts , +page.svelte
        flags/+page.server.ts  , +page.svelte
        releases/+page.server.ts , +page.svelte
        releases/[id]/+page.server.ts , +page.svelte
        launches/+page.server.ts , +page.svelte
        launches/[id]/+page.server.ts , +page.svelte
    tests/
      helpers/seed.ts                  # temp-project seeding helper
      console-service.test.ts
      api.test.ts
```

---

## Task 1: Workspace scaffolding + SvelteKit skeleton that builds

**Files:**
- Modify: `package.json` (root)
- Create: `web/package.json`, `web/svelte.config.js`, `web/vite.config.ts`, `web/tsconfig.json`, `web/.gitignore`, `web/src/app.html`, `web/src/app.d.ts`, `web/src/routes/+page.svelte`

- [ ] **Step 1: Add workspace + scripts to root `package.json`**

Modify the root `package.json` — add a `"workspaces"` key, four scripts, and `cross-env` as a devDep. Resulting (merge into existing, keep all current fields):

```jsonc
{
  // ...existing name/version/type/engines/main/module/types/exports/bin/files...
  "workspaces": ["web"],
  "scripts": {
    // ...existing scripts...
    "web:dev": "npm run build && npm run dev --workspace web",
    "web:build": "npm run build && npm run build --workspace web",
    "web:start": "cross-env HOST=127.0.0.1 node web/build",
    "web:test": "npm run test --workspace web"
  },
  "devDependencies": {
    // ...existing...
    "cross-env": "^7.0.3"
  }
}
```

- [ ] **Step 2: Create `web/package.json`**

```json
{
  "name": "@halyard/web",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "dev": "vite dev",
    "build": "vite build",
    "preview": "vite preview",
    "check": "svelte-kit sync && svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "halyard": "*"
  },
  "devDependencies": {
    "@sveltejs/adapter-node": "^5.2.0",
    "@sveltejs/kit": "^2.5.0",
    "@sveltejs/vite-plugin-svelte": "^3.1.0",
    "svelte": "^5.0.0",
    "svelte-check": "^3.8.0",
    "typescript": "^5.6.0",
    "vite": "^5.4.0",
    "vitest": "^2.1.0"
  }
}
```

- [ ] **Step 3: Create `web/svelte.config.js`**

```js
import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(), // outputs ./build, server reads HOST/PORT env
  },
};
export default config;
```

- [ ] **Step 4: Create `web/vite.config.ts`**

```ts
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [sveltekit()],
  // halyard is a Node-only ESM lib (node:fs, node:crypto, @anthropic-ai/sdk).
  // Keep it external to the SSR bundle; never pre-bundle it for the browser.
  ssr: { external: ["halyard", "@anthropic-ai/sdk"] },
  optimizeDeps: { exclude: ["halyard"] },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
```

- [ ] **Step 5: Create `web/tsconfig.json`**

```json
{
  "extends": "./.svelte-kit/tsconfig.json",
  "compilerOptions": {
    "allowJs": true,
    "checkJs": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "resolveJsonModule": true,
    "skipLibCheck": true,
    "sourceMap": true,
    "strict": true,
    "moduleResolution": "bundler"
  }
}
```

- [ ] **Step 6: Create `web/.gitignore`**

```gitignore
.svelte-kit/
build/
node_modules/
```

- [ ] **Step 7: Create `web/src/app.html`**

```html
<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Halyard Console</title>
    %sveltekit.head%
  </head>
  <body>
    <div>%sveltekit.body%</div>
  </body>
</html>
```

- [ ] **Step 8: Create `web/src/app.d.ts`**

```ts
declare global {
  namespace App {}
}
export {};
```

- [ ] **Step 9: Create a placeholder `web/src/routes/+page.svelte`**

```svelte
<h1>Halyard Console</h1>
```

- [ ] **Step 10: Install and verify the skeleton builds (proves the workspace symlink + lib build + adapter all wire up)**

Run: `npm install`
Then: `npm run web:build`
Expected: root `npm run build` produces `dist/`, then SvelteKit builds `web/build/` with no errors. (The lib's `prepare`/our `web:build` ensures `dist/` exists before the SvelteKit build runs.)

- [ ] **Step 11: Commit**

```bash
git add package.json package-lock.json web/
git commit -m "feat(web): scaffold SvelteKit console workspace"
```

---

## Task 2: Project resolution + `loadProject` (memoized, guarded)

**Files:**
- Create: `web/src/lib/server/clock.ts`, `web/src/lib/server/project.ts`
- Create: `web/tests/helpers/seed.ts`, `web/tests/console-service.test.ts` (start it here)

- [ ] **Step 1: Create the seed helper `web/tests/helpers/seed.ts`** (builds a valid temp project by reusing the repo's example configs)

```ts
import { cpSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const REPO = resolve(__dirname, "..", "..", ".."); // web/tests/helpers -> repo root

/** Create a temp Halyard project root with a valid org config + one app ("demo"). */
export function seedProject(): { root: string; stateDir: string } {
  const root = mkdtempSync(join(tmpdir(), "halyard-web-"));
  cpSync(join(REPO, "halyard.config.yml"), join(root, "halyard.config.yml"));
  mkdirSync(join(root, "apps", "demo"), { recursive: true });
  cpSync(join(REPO, "scripts", "demo-app.yml"), join(root, "apps", "demo", "app.yml"));
  const stateDir = join(root, "state");
  mkdirSync(stateDir, { recursive: true });
  return { root, stateDir };
}

/** A temp root with NO config — for the degraded-state path. */
export function seedEmptyRoot(): { root: string } {
  return { root: mkdtempSync(join(tmpdir(), "halyard-web-empty-")) };
}
```

- [ ] **Step 2: Write the failing test for `loadProject`** in `web/tests/console-service.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { loadProject } from "../src/lib/server/project.js";
import { seedProject, seedEmptyRoot } from "./helpers/seed.js";

describe("loadProject", () => {
  it("loads a valid project: org, apps, stateDir, canonDir, flagClient", () => {
    const { root, stateDir } = seedProject();
    const p = loadProject(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.org.org.name).toBe("Example");
    expect(p.apps.map((a) => a.app.slug)).toEqual(["demo"]);
    expect(p.stateDir).toBe(stateDir);
    expect(p.canonDir.endsWith("canon")).toBe(true); // ./canon/voice/ resolved under root
    expect(p.flagClient).toBeDefined();
  });

  it("returns a degraded (not-ok) result when no config is present", () => {
    const { root } = seedEmptyRoot();
    const p = loadProject(root);
    expect(p.ok).toBe(false);
    if (p.ok) return;
    expect(p.error).toMatch(/config/i);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npm run test --workspace web`
Expected: FAIL — `loadProject` is not defined / module missing.

- [ ] **Step 4: Create `web/src/lib/server/clock.ts`**

```ts
/** Injectable clock; ISO-8601 strings, matching Halyard's `now: () => string` ports. */
export type Clock = () => string;
export const systemClock: Clock = () => new Date().toISOString();
```

- [ ] **Step 5: Implement `web/src/lib/server/project.ts`**

```ts
import { join, resolve } from "node:path";
import {
  loadOrgConfig,
  loadAppConfig,
  discoverAppSlugs,
  FlagFileClient,
  ConfigError,
  type OrgConfig,
  type AppConfig,
} from "halyard";
import { systemClock, type Clock } from "./clock.js";

export interface LoadedProject {
  ok: true;
  root: string;
  org: OrgConfig;
  apps: AppConfig[];
  stateDir: string;
  canonDir: string;
  flagClient: FlagFileClient;
}
export interface DegradedProject {
  ok: false;
  root: string;
  error: string;
}
export type Project = LoadedProject | DegradedProject;

/** The console-only project root: explicit env override, else the process CWD (like the CLI). */
export function resolveRoot(): string {
  return process.env.HALYARD_CONFIG_ROOT
    ? resolve(process.env.HALYARD_CONFIG_ROOT)
    : process.cwd();
}

/** Load org + apps from a single root. Never throws — failure becomes a degraded result. */
export function loadProject(root: string, now: Clock = systemClock): Project {
  try {
    const org = loadOrgConfig(join(root, "halyard.config.yml"));
    const slugs = discoverAppSlugs(join(root, "apps"));
    const apps = slugs.map((slug) => loadAppConfig(join(root, "apps", slug, "app.yml")));
    const stateDir = resolve(root, org.coordinator.state_dir);
    const canonDir = resolve(root, org.drafting.voice_canon);
    return { ok: true, root, org, apps, stateDir, canonDir, flagClient: new FlagFileClient(stateDir, now) };
  } catch (err) {
    const error = err instanceof ConfigError || err instanceof Error ? err.message : String(err);
    return { ok: false, root, error };
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS (both `loadProject` tests).

- [ ] **Step 7: Commit**

```bash
git add web/src/lib/server/clock.ts web/src/lib/server/project.ts web/tests/
git commit -m "feat(web): project resolution + guarded loadProject"
```

---

## Task 3: Console service — read methods

**Files:**
- Create: `web/src/lib/server/console-service.ts`
- Modify: `web/tests/console-service.test.ts`

- [ ] **Step 1: Write failing tests for the read methods** (append to `web/tests/console-service.test.ts`)

```ts
import { createConsoleService } from "../src/lib/server/console-service.js";
import { writeRelease, newRelease, writeLaunch, newLaunch } from "halyard";

function fixedClock() {
  return () => "2026-06-08T00:00:00.000Z";
}

describe("console service reads", () => {
  it("health reports ok with app count for a valid project", () => {
    const { root } = seedProject();
    const svc = createConsoleService({ root, now: fixedClock() });
    const h = svc.health();
    expect(h.status).toBe("ok");
    expect(h.apps).toEqual(["demo"]);
  });

  it("health reports error for a project with no config", () => {
    const { root } = seedEmptyRoot();
    const svc = createConsoleService({ root, now: fixedClock() });
    expect(svc.health().status).toBe("error");
  });

  it("listReleaseStatuses projects each release via summarizeRelease", () => {
    const { root, stateDir } = seedProject();
    let r = newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" });
    writeRelease(stateDir, r);
    const svc = createConsoleService({ root, now: fixedClock() });
    const statuses = svc.listReleaseStatuses();
    expect(statuses).toHaveLength(1);
    expect(statuses[0].release_id).toBe("rel_demo_web_1.0.0");
    expect(statuses[0].waiting_on).toBeTypeOf("string");
  });

  it("getRelease returns the full record or null", () => {
    const { root, stateDir } = seedProject();
    writeRelease(stateDir, newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }));
    const svc = createConsoleService({ root, now: fixedClock() });
    expect(svc.getRelease("rel_demo_web_1.0.0")?.version).toBe("1.0.0");
    expect(svc.getRelease("nope")).toBeNull();
  });

  it("listLaunches returns launch records", () => {
    const { root, stateDir } = seedProject();
    const launch = newLaunch({
      app: "demo", feature: "beta", title: "Beta", narrativeSeed: "why it matters",
      announcePolicy: "per_surface", tier: "standard", flag: "launch.demo.beta",
      createdBy: "test", createdAt: "2026-06-08T00:00:00.000Z",
    });
    writeLaunch(stateDir, launch);
    const svc = createConsoleService({ root, now: fixedClock() });
    expect(svc.listLaunches().map((l) => l.title)).toContain("Beta");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `createConsoleService` not defined.

- [ ] **Step 3: Implement the service skeleton + read methods** in `web/src/lib/server/console-service.ts`

```ts
import {
  scanReleaseIds, readRelease, summarizeRelease,
  scanLaunchIds, readLaunch,
  type Release, type ReleaseStatus, type Launch,
} from "halyard";
import { loadProject, type LoadedProject } from "./project.js";
import { systemClock, type Clock } from "./clock.js";

export interface HealthReport {
  status: "ok" | "error";
  root: string;
  stateDir?: string;
  apps?: string[];
  error?: string;
}

export interface ConsoleService {
  health(): HealthReport;
  listReleaseStatuses(): ReleaseStatus[];
  getRelease(id: string): Release | null;
  listLaunches(): Launch[];
  getLaunch(id: string): Launch | null;
}

class ProjectUnavailableError extends Error {}

export function createConsoleService(opts: { root: string; now?: Clock }): ConsoleService {
  const now: Clock = opts.now ?? systemClock;
  // Memoize: config is resolved once (synchronous, like the CLI). health() is a validity probe.
  const project = loadProject(opts.root, now);

  function loaded(): LoadedProject {
    if (!project.ok) throw new ProjectUnavailableError(project.error);
    return project;
  }

  return {
    health() {
      if (!project.ok) return { status: "error", root: project.root, error: project.error };
      return { status: "ok", root: project.root, stateDir: project.stateDir, apps: project.apps.map((a) => a.app.slug) };
    },
    listReleaseStatuses() {
      const p = loaded();
      const nowIso = now();
      return scanReleaseIds(p.stateDir)
        .map((id) => readRelease(p.stateDir, id))
        .filter((r): r is Release => r !== null)
        .map((r) => summarizeRelease(r, nowIso)); // summarizeRelease takes a STRING — invoke the clock
    },
    getRelease(id) {
      return readRelease(loaded().stateDir, id);
    },
    listLaunches() {
      const p = loaded();
      return scanLaunchIds(p.stateDir)
        .map((id) => readLaunch(p.stateDir, id))
        .filter((l): l is Launch => l !== null);
    },
    getLaunch(id) {
      return readLaunch(loaded().stateDir, id);
    },
  };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS (read-method tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/console-service.ts web/tests/console-service.test.ts
git commit -m "feat(web): console service read methods + health"
```

---

## Task 4: Console service — queue projection (status filter + error partition)

**Files:**
- Modify: `web/src/lib/server/console-service.ts`, `web/tests/console-service.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
import { writeProposal } from "halyard";

function proposal(id: string, status: string, kind = "social_post") {
  return {
    proposal_id: id, kind, app: "demo", title: "t", body: "b",
    status, created_at: "2026-06-08T00:00:00.000Z",
    ...(kind === "social_post" ? { channel: "x" } : {}),
  } as any;
}

describe("console service queue", () => {
  it("returns open proposals by default, all when requested, and partitions coordinator_error", () => {
    const { root, stateDir } = seedProject();
    writeProposal(stateDir, proposal("p_open", "open"));
    writeProposal(stateDir, proposal("p_done", "approved"));
    writeProposal(stateDir, proposal("p_err", "open", "coordinator_error"));
    const svc = createConsoleService({ root, now: fixedClock() });

    const q = svc.listQueue();
    expect(q.open.map((p) => p.proposal_id).sort()).toEqual(["p_err", "p_open"]); // open-only by default
    expect(q.errors.map((p) => p.proposal_id)).toEqual(["p_err"]); // coordinator_error partition

    const qAll = svc.listQueue({ all: true });
    expect(qAll.open.map((p) => p.proposal_id).sort()).toEqual(["p_done", "p_err", "p_open"]); // all statuses
  });
});
```

> `listQueue()` returns `{ open, errors }` — `open` holds the rows the UI renders (open-only, or all statuses when `{ all: true }`); `errors` is the `coordinator_error` partition for the board banner.

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `listQueue` not a function.

- [ ] **Step 3: Implement `listQueue`** — add to the `ConsoleService` interface and the returned object in `console-service.ts`

Add the import and interface member:

```ts
import { listProposals, type Proposal } from "halyard";
// in interface ConsoleService:
listQueue(opts?: { all?: boolean }): { open: Proposal[]; errors: Proposal[] };
```

Add the method to the returned object:

```ts
listQueue(opts) {
  const p = loaded();
  const all = listProposals(p.stateDir);
  const shown = opts?.all ? all : all.filter((x) => x.status === "open");
  return {
    open: shown, // "open" = the rows the UI shows (open-only, or all when requested)
    errors: all.filter((x) => x.kind === "coordinator_error" && x.status === "open"),
  };
},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/console-service.ts web/tests/console-service.test.ts
git commit -m "feat(web): queue projection with status filter + error partition"
```

---

## Task 5: Console service — `approve` action

**Files:**
- Modify: `web/src/lib/server/console-service.ts`, `web/tests/console-service.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("console service approve", () => {
  it("approves a proposal and reports it", () => {
    const { root, stateDir } = seedProject();
    writeProposal(stateDir, proposal("p1", "open"));
    const svc = createConsoleService({ root, now: fixedClock() });
    const res = svc.approve("p1");
    expect(res.proposal.status).toBe("approved");
  });

  it("throws for a missing proposal", () => {
    const { root } = seedProject();
    const svc = createConsoleService({ root, now: fixedClock() });
    expect(() => svc.approve("nope")).toThrow();
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `approve` not a function.

- [ ] **Step 3: Implement `approve`** in `console-service.ts`

Add import + interface member:

```ts
import { approveProposal } from "halyard";
// interface:
approve(proposalId: string, finalText?: string): { proposal: Proposal; canonAppended: boolean };
```

Method:

```ts
approve(proposalId, finalText) {
  const p = loaded();
  return approveProposal({ stateDir: p.stateDir, canonDir: p.canonDir, proposalId, finalText, now });
},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/console-service.ts web/tests/console-service.test.ts
git commit -m "feat(web): approve action"
```

---

## Task 6: Console service — `flip` + `listFlags`

**Files:**
- Modify: `web/src/lib/server/console-service.ts`, `web/tests/console-service.test.ts`

- [ ] **Step 1: Write the failing test** (append)

```ts
describe("console service flags", () => {
  it("flip succeeds; an unreferenced flag does not appear in listFlags", async () => {
    const { root } = seedProject();
    const svc = createConsoleService({ root, now: fixedClock() });
    await svc.flip("launch.demo.beta", true); // no release references this flag yet
    // listFlags is derived from release.flag values, so with no such release it is empty.
    expect(await svc.listFlags()).toEqual([]);
  });

  it("listFlags reports state for flags referenced by releases", async () => {
    const { root, stateDir } = seedProject();
    const r = { ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }), flag: "launch.demo.beta" };
    writeRelease(stateDir, r);
    const svc = createConsoleService({ root, now: fixedClock() });
    await svc.flip("launch.demo.beta", true);
    const flags = await svc.listFlags();
    expect(flags).toEqual([{ key: "launch.demo.beta", state: "on" }]);
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `flip`/`listFlags` not functions.

- [ ] **Step 3: Implement `flip` + `listFlags`** in `console-service.ts`

Add import + interface members:

```ts
import { type FlagState } from "halyard";
// interface:
flip(flagKey: string, on: boolean): Promise<void>;
listFlags(): Promise<{ key: string; state: FlagState }[]>;
```

Methods (note: `flip` uses the local git-backed FlagFileClient — see spec; live providers are a follow-up):

```ts
async flip(flagKey, on) {
  const p = loaded();
  await p.flagClient.ensureFlag(flagKey);
  await p.flagClient.setState(flagKey, on);
},
async listFlags() {
  const p = loaded();
  const keys = new Set<string>();
  for (const id of scanReleaseIds(p.stateDir)) {
    const r = readRelease(p.stateDir, id);
    if (r?.flag) keys.add(r.flag);
  }
  const out: { key: string; state: FlagState }[] = [];
  for (const key of [...keys].sort()) out.push({ key, state: await p.flagClient.getState(key) });
  return out;
},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/console-service.ts web/tests/console-service.test.ts
git commit -m "feat(web): flip action + flag listing"
```

---

## Task 7: Console service — `reconcileNow` (transitions-only, multi-app gated)

**Files:**
- Modify: `web/src/lib/server/console-service.ts`, `web/tests/console-service.test.ts`

- [ ] **Step 1: Write the failing test** (append) — proves flip → reconcile → live, offline, and the gate

```ts
import { appendTransition } from "halyard"; // for seeding a release into its resting state

describe("console service reconcileNow", () => {
  it("projects a flipped flag to live (transitions only, no network)", async () => {
    const { root, stateDir } = seedProject();
    // Seed a web release resting at `uploaded` with a flag (web's pre-launch resting state).
    let r = newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" });
    const now = () => "2026-06-08T00:00:00.000Z";
    r = { ...r, flag: "launch.demo.beta" };
    r = appendTransition(r, "built", "test", now);
    r = appendTransition(r, "tested", "test", now);
    r = appendTransition(r, "uploaded", "test", now);
    writeRelease(stateDir, r);

    const svc = createConsoleService({ root, now });
    await svc.flip("launch.demo.beta", true);
    await svc.reconcileNow();
    expect(svc.getRelease("rel_demo_web_1.0.0")?.state).toBe("live");
  });

  it("throws a Pro-required error when >1 app and unlicensed", async () => {
    const { root } = seedProject();
    // add a second app so appCount > 1 and the free entitlement trips the gate
    const { mkdirSync, cpSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const repo = resolve(__dirname, "..", "..");
    mkdirSync(join(root, "apps", "demo2"), { recursive: true });
    cpSync(join(repo, "scripts", "demo-app.yml"), join(root, "apps", "demo2", "app.yml"));
    const svc = createConsoleService({ root, now: () => "2026-06-08T00:00:00.000Z" });
    await expect(svc.reconcileNow()).rejects.toThrow(/Pro/i);
  });
});
```

> Note: the second app loads with `slug: demo` (same slug from the copied file). For the gate test only the **count** of discovered app dirs matters (`apps.length`), and `enforceMultiApp` keys off count, so two app dirs → `appCount === 2` → throws. (Slug uniqueness isn't asserted here.)

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `reconcileNow` not a function.

- [ ] **Step 3: Implement `reconcileNow`** in `console-service.ts`

Add imports + interface member:

```ts
import { reconcile, flagPollSource, getEntitlement, enforceMultiApp } from "halyard";
// interface:
reconcileNow(): Promise<Awaited<ReturnType<typeof reconcile>>>;
```

Method:

```ts
async reconcileNow() {
  const p = loaded();
  // Acting/coordination command → enforce the same multi-app Pro gate the CLI does.
  enforceMultiApp(p.apps.length, getEntitlement()); // throws when >1 app & unlicensed
  // Transitions only: flag poll, no publicity, no ASC, no network.
  return reconcile({ stateDir: p.stateDir, sources: [flagPollSource(p.flagClient)], now });
},
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS (both reconcile tests).

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/server/console-service.ts web/tests/console-service.test.ts
git commit -m "feat(web): reconcileNow (flag-poll transitions, multi-app gated)"
```

---

## Task 8: Shared server singleton + `/health` endpoint

**Files:**
- Create: `web/src/lib/server/service.ts`, `web/src/routes/health/+server.ts`
- Create: `web/tests/api.test.ts`

- [ ] **Step 1: Create the request-scoped singleton `web/src/lib/server/service.ts`**

```ts
import { createConsoleService, type ConsoleService } from "./console-service.js";
import { resolveRoot } from "./project.js";

let cached: ConsoleService | null = null;

/** The process-wide console service, bound to the resolved root. */
export function service(): ConsoleService {
  if (!cached) cached = createConsoleService({ root: resolveRoot() });
  return cached;
}
```

- [ ] **Step 2: Write the failing test for the health endpoint** in `web/tests/api.test.ts`

```ts
import { describe, expect, it, beforeEach } from "vitest";
import { seedProject } from "./helpers/seed.js";

// The endpoint reads the root from env via resolveRoot(); set it per test.
async function call(handler: any, init?: { body?: unknown }) {
  const request = new Request("http://localhost/x", {
    method: init?.body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return handler({ request });
}

describe("GET /health", () => {
  beforeEach(() => {
    // service.ts memoizes per-module; vitest isolates modules per file, but to be safe
    // we set the env and import fresh inside each test via dynamic import + resetModules.
  });

  it("returns 200 ok for a valid project", async () => {
    const { root } = seedProject();
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const { GET } = await import("../src/routes/health/+server.js");
    const res = await call(GET);
    expect(res.status).toBe(200);
    expect((await res.json()).status).toBe("ok");
  });

  it("returns 503 when no project", async () => {
    const { mkdtempSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join } = await import("node:path");
    process.env.HALYARD_CONFIG_ROOT = mkdtempSync(join(tmpdir(), "empty-"));
    const { vi } = await import("vitest");
    vi.resetModules();
    const { GET } = await import("../src/routes/health/+server.js");
    const res = await call(GET);
    expect(res.status).toBe(503);
  });
});
```

- [ ] **Step 3: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — `health/+server.js` missing.

- [ ] **Step 4: Implement `web/src/routes/health/+server.ts`**

```ts
import { json } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export function GET() {
  const h = service().health();
  return json(h, { status: h.status === "ok" ? 200 : 503 });
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS.

> If the dynamic-import + `vi.resetModules()` pattern proves flaky across the two tests sharing the memoized singleton, split them into two files (`health-ok.test.ts`, `health-degraded.test.ts`); module isolation is per-file in Vitest.

- [ ] **Step 6: Commit**

```bash
git add web/src/lib/server/service.ts web/src/routes/health/ web/tests/api.test.ts
git commit -m "feat(web): /health endpoint + service singleton"
```

---

## Task 9: `/api` action endpoints (reconcile, flip, approve)

**Files:**
- Create: `web/src/routes/api/reconcile/+server.ts`, `web/src/routes/api/flip/+server.ts`, `web/src/routes/api/approve/+server.ts`
- Modify: `web/tests/api.test.ts`

- [ ] **Step 1: Write failing tests** (append to `web/tests/api.test.ts`)

```ts
describe("POST /api actions", () => {
  it("flip then reconcile projects a release to live", async () => {
    const { root, stateDir } = seedProject();
    const { writeRelease, newRelease, appendTransition } = await import("halyard");
    const now = () => "2026-06-08T00:00:00.000Z";
    let r = { ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }), flag: "launch.demo.beta" };
    r = appendTransition(r, "built", "t", now);
    r = appendTransition(r, "tested", "t", now);
    r = appendTransition(r, "uploaded", "t", now);
    writeRelease(stateDir, r);

    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const flip = (await import("../src/routes/api/flip/+server.js")).POST;
    const reconcileEp = (await import("../src/routes/api/reconcile/+server.js")).POST;

    const fRes = await call(flip, { body: { flagKey: "launch.demo.beta", on: true } });
    expect(fRes.status).toBe(200);
    const rRes = await call(reconcileEp, { body: {} });
    expect(rRes.status).toBe(200);

    const { readRelease } = await import("halyard");
    expect(readRelease(stateDir, "rel_demo_web_1.0.0")?.state).toBe("live");
  });

  it("approve marks a proposal approved", async () => {
    const { root, stateDir } = seedProject();
    const { writeProposal } = await import("halyard");
    writeProposal(stateDir, { proposal_id: "p1", kind: "social_post", app: "demo", channel: "x", title: "t", body: "b", status: "open", created_at: "2026-06-08T00:00:00.000Z" } as any);
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const approve = (await import("../src/routes/api/approve/+server.js")).POST;
    const res = await call(approve, { body: { proposalId: "p1" } });
    expect(res.status).toBe(200);
    expect((await res.json()).proposal.status).toBe("approved");
  });
});
```

- [ ] **Step 2: Run to verify failure**

Run: `npm run test --workspace web`
Expected: FAIL — endpoint modules missing.

- [ ] **Step 3: Implement `web/src/routes/api/reconcile/+server.ts`**

```ts
import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST() {
  try {
    const report = await service().reconcileNow();
    return json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // enforceMultiApp throws here → Pro-required → 403 (not an unhandled 500)
    if (/Pro feature/i.test(message)) throw error(403, message);
    throw error(500, message);
  }
}
```

- [ ] **Step 4: Implement `web/src/routes/api/flip/+server.ts`**

```ts
import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST({ request }) {
  const { flagKey, on } = await request.json();
  if (typeof flagKey !== "string" || typeof on !== "boolean") throw error(400, "flagKey (string) and on (boolean) required");
  try {
    await service().flip(flagKey, on);
    return json({ ok: true, flagKey, on });
  } catch (err) {
    throw error(500, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 5: Implement `web/src/routes/api/approve/+server.ts`**

```ts
import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST({ request }) {
  const { proposalId, finalText } = await request.json();
  if (typeof proposalId !== "string") throw error(400, "proposalId (string) required");
  try {
    const result = service().approve(proposalId, typeof finalText === "string" ? finalText : undefined);
    return json({ ok: true, ...result });
  } catch (err) {
    throw error(404, err instanceof Error ? err.message : String(err));
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npm run test --workspace web`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add web/src/routes/api/ web/tests/api.test.ts
git commit -m "feat(web): /api reconcile, flip, approve endpoints"
```

---

## Task 10: Status board page (`/`) + layout/nav + degraded banner

**Files:**
- Create: `web/src/routes/+layout.server.ts`, `web/src/routes/+layout.svelte`, `web/src/routes/+page.server.ts`
- Modify: `web/src/routes/+page.svelte` (replace placeholder)

- [ ] **Step 1: Create `web/src/routes/+layout.server.ts`** (health drives the degraded banner)

```ts
import { service } from "$lib/server/service.js";
export function load() {
  return { health: service().health() };
}
```

- [ ] **Step 2: Create `web/src/routes/+layout.svelte`**

```svelte
<script lang="ts">
  let { data, children } = $props();
</script>

<nav>
  <a href="/">Board</a> · <a href="/queue">Queue</a> · <a href="/flags">Flags</a> ·
  <a href="/releases">Releases</a> · <a href="/launches">Launches</a>
  <span style="float:right">{data.health.status === "ok" ? data.health.root : "no project"}</span>
</nav>

{#if data.health.status !== "ok"}
  <p role="alert">No Halyard project at <code>{data.health.root}</code>: {data.health.error}</p>
{/if}

{@render children()}
```

- [ ] **Step 3: Create `web/src/routes/+page.server.ts`**

```ts
import { service } from "$lib/server/service.js";
export function load() {
  const svc = service();
  if (svc.health().status !== "ok") return { releases: [], errors: [] };
  return { releases: svc.listReleaseStatuses(), errors: svc.listQueue().errors };
}
```

- [ ] **Step 4: Replace `web/src/routes/+page.svelte`** with the board

```svelte
<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  let { data } = $props();
  let busy = $state(false);

  async function reconcile() {
    busy = true;
    const res = await fetch("/api/reconcile", { method: "POST" });
    busy = false;
    if (!res.ok) alert((await res.json()).message ?? "reconcile failed");
    await invalidateAll();
  }
</script>

<h1>Release status</h1>
<button onclick={reconcile} disabled={busy}>Reconcile now</button>
<button onclick={() => invalidateAll()}>Refresh</button>

{#if data.errors.length}
  <section role="alert">
    <h2>Coordinator errors</h2>
    <ul>{#each data.errors as e}<li>{e.title} — {e.body}</li>{/each}</ul>
  </section>
{/if}

<table>
  <thead><tr><th>Release</th><th>App</th><th>Surface</th><th>Ver</th><th>State</th><th>Waiting on</th><th>Age (h)</th><th>Flag</th></tr></thead>
  <tbody>
    {#each data.releases as r}
      <tr>
        <td><a href={`/releases/${r.release_id}`}>{r.release_id}</a></td>
        <td>{r.app}</td><td>{r.surface}</td><td>{r.version}</td>
        <td>{r.state}{r.stuck ? " ⏳" : ""}</td>
        <td>{r.waiting_on}</td><td>{r.age_hours ?? "—"}</td>
        <td>{r.flag ?? "—"} {r.flag_state ? `(${r.flag_state})` : ""}</td>
      </tr>
    {/each}
  </tbody>
</table>
```

- [ ] **Step 5: Verify the build + typecheck pass**

Run: `npm run web:build`
Then: `npm run check --workspace web`
Expected: build succeeds; `svelte-check` reports 0 errors.

- [ ] **Step 6: Commit**

```bash
git add web/src/routes/+layout.server.ts web/src/routes/+layout.svelte web/src/routes/+page.server.ts web/src/routes/+page.svelte
git commit -m "feat(web): status board page + nav + degraded banner"
```

---

## Task 11: Approval queue page (`/queue`) + approve

**Files:**
- Create: `web/src/routes/queue/+page.server.ts`, `web/src/routes/queue/+page.svelte`

- [ ] **Step 1: Create `web/src/routes/queue/+page.server.ts`**

```ts
import { service } from "$lib/server/service.js";
export function load({ url }) {
  const svc = service();
  if (svc.health().status !== "ok") return { open: [] };
  const all = url.searchParams.get("all") === "1";
  return { open: svc.listQueue({ all }).open, all };
}
```

- [ ] **Step 2: Create `web/src/routes/queue/+page.svelte`**

```svelte
<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  let { data } = $props();
  let edits = $state<Record<string, string>>({});

  async function approve(id: string) {
    const finalText = edits[id];
    const res = await fetch("/api/approve", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ proposalId: id, finalText }),
    });
    if (!res.ok) alert((await res.json()).message ?? "approve failed");
    await invalidateAll();
  }
</script>

<h1>Approval queue</h1>
<p><a href={data.all ? "/queue" : "/queue?all=1"}>{data.all ? "Show open only" : "Show all"}</a></p>

{#each data.open as p}
  <article>
    <h3>{p.kind} — {p.title} <small>[{p.app}{p.channel ? ` · ${p.channel}` : ""}{p.severity ? ` · ${p.severity}` : ""}]</small></h3>
    <p>{p.body}</p>
    {#if p.kind === "social_post"}
      <textarea bind:value={edits[p.proposal_id]} placeholder="Edit final text (optional)" rows="3"></textarea>
    {/if}
    {#if p.status === "open"}<button onclick={() => approve(p.proposal_id)}>Approve</button>{:else}<em>{p.status}</em>{/if}
  </article>
{:else}
  <p>Queue is empty.</p>
{/each}
```

- [ ] **Step 2b: Verify build/typecheck**

Run: `npm run check --workspace web`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/queue/
git commit -m "feat(web): approval queue page + approve"
```

---

## Task 12: Flags page (`/flags`) + flip

**Files:**
- Create: `web/src/routes/flags/+page.server.ts`, `web/src/routes/flags/+page.svelte`

- [ ] **Step 1: Create `web/src/routes/flags/+page.server.ts`**

```ts
import { service } from "$lib/server/service.js";
export async function load() {
  const svc = service();
  if (svc.health().status !== "ok") return { flags: [] };
  return { flags: await svc.listFlags() };
}
```

- [ ] **Step 2: Create `web/src/routes/flags/+page.svelte`**

```svelte
<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  let { data } = $props();

  async function flip(flagKey: string, on: boolean) {
    if (!confirm(`Flip ${flagKey} ${on ? "ON" : "OFF"}? This is the launch/rollback gate.`)) return;
    const res = await fetch("/api/flip", {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ flagKey, on }),
    });
    if (!res.ok) alert((await res.json()).message ?? "flip failed");
    await invalidateAll();
  }
</script>

<h1>Flags</h1>
<p><small>Local git-backed flags. After a flip, run “Reconcile now” on the board to project the change.</small></p>
{#each data.flags as f}
  <div>
    <code>{f.key}</code> — <strong>{f.state}</strong>
    <button onclick={() => flip(f.key, true)} disabled={f.state === "on"}>On</button>
    <button onclick={() => flip(f.key, false)} disabled={f.state === "off"}>Off</button>
  </div>
{:else}
  <p>No launch flags found on any release.</p>
{/each}
```

- [ ] **Step 2b: Verify build/typecheck**

Run: `npm run check --workspace web`
Expected: 0 errors.

- [ ] **Step 3: Commit**

```bash
git add web/src/routes/flags/
git commit -m "feat(web): flags page + flip gate"
```

---

## Task 13: Read-only browse — releases & launches (list + detail)

**Files:**
- Create: `web/src/routes/releases/+page.server.ts`, `releases/+page.svelte`, `releases/[id]/+page.server.ts`, `releases/[id]/+page.svelte`, `launches/+page.server.ts`, `launches/+page.svelte`, `launches/[id]/+page.server.ts`, `launches/[id]/+page.svelte`

- [ ] **Step 1: `web/src/routes/releases/+page.server.ts`**

```ts
import { service } from "$lib/server/service.js";
export function load() {
  const svc = service();
  return { releases: svc.health().status === "ok" ? svc.listReleaseStatuses() : [] };
}
```

- [ ] **Step 2: `web/src/routes/releases/+page.svelte`**

```svelte
<script lang="ts">let { data } = $props();</script>
<h1>Releases</h1>
<ul>{#each data.releases as r}<li><a href={`/releases/${r.release_id}`}>{r.release_id}</a> — {r.state}</li>{/each}</ul>
```

- [ ] **Step 3: `web/src/routes/releases/[id]/+page.server.ts`**

```ts
import { error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";
export function load({ params }) {
  const release = service().getRelease(params.id);
  if (!release) throw error(404, `no such release: ${params.id}`);
  return { release };
}
```

- [ ] **Step 4: `web/src/routes/releases/[id]/+page.svelte`**

```svelte
<script lang="ts">let { data } = $props();</script>
<h1>{data.release.release_id}</h1>
<p>{data.release.app} · {data.release.surface} · v{data.release.version} · <strong>{data.release.state}</strong></p>
<p>Flag: {data.release.flag ?? "—"}</p>
<h2>Transitions</h2>
<ol>{#each data.release.transitions as t}<li>{t.to} — {t.by} @ {t.at}</li>{/each}</ol>
```

- [ ] **Step 5: `web/src/routes/launches/+page.server.ts`**

```ts
import { service } from "$lib/server/service.js";
export function load() {
  const svc = service();
  return { launches: svc.health().status === "ok" ? svc.listLaunches() : [] };
}
```

- [ ] **Step 6: `web/src/routes/launches/+page.svelte`**

```svelte
<script lang="ts">let { data } = $props();</script>
<h1>Launches</h1>
<ul>{#each data.launches as l}<li><a href={`/launches/${l.launch_id}`}>{l.title}</a> — {l.app}</li>{/each}</ul>
```

- [ ] **Step 7: `web/src/routes/launches/[id]/+page.server.ts`**

```ts
import { error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";
export function load({ params }) {
  const launch = service().getLaunch(params.id);
  if (!launch) throw error(404, `no such launch: ${params.id}`);
  return { launch };
}
```

- [ ] **Step 8: `web/src/routes/launches/[id]/+page.svelte`**

```svelte
<script lang="ts">let { data } = $props();</script>
<h1>{data.launch.title}</h1>
<p>{data.launch.app} · tier {data.launch.tier} · {data.launch.announce_policy}</p>
<p>Flag: {data.launch.flag ?? "—"}</p>
<p><em>{data.launch.narrative_seed}</em></p>
<h2>Releases</h2>
<ul>{#each data.launch.releases as id}<li><a href={`/releases/${id}`}>{id}</a></li>{/each}</ul>
```

- [ ] **Step 9: Verify build/typecheck**

Run: `npm run check --workspace web` then `npm run web:build`
Expected: 0 errors; build succeeds.

- [ ] **Step 10: Commit**

```bash
git add web/src/routes/releases/ web/src/routes/launches/
git commit -m "feat(web): read-only releases & launches browse"
```

---

## Task 14: Loopback bind test + start-command verification

**Files:**
- Create: `web/tests/bind.test.ts`

- [ ] **Step 1: Write a test asserting `web:start` binds loopback** in `web/tests/bind.test.ts`

```ts
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("start command binds loopback", () => {
  it("root web:start sets HOST=127.0.0.1", () => {
    const pkg = JSON.parse(readFileSync(resolve(__dirname, "..", "..", "package.json"), "utf8"));
    expect(pkg.scripts["web:start"]).toContain("HOST=127.0.0.1");
  });
});
```

- [ ] **Step 2: Run to verify** (it should already pass given Task 1's script; this locks it in)

Run: `npm run test --workspace web`
Expected: PASS.

- [ ] **Step 3: Manually verify the running server is healthy and loopback-bound**

```bash
npm run web:build
npm run web:start &
sleep 2
curl -s -o /dev/null -w "%{http_code}" http://127.0.0.1:3000/health   # expect 200 (run from a Halyard project root)
```
Expected: `200`. Stop the server (Ctrl-C / kill); confirm the process exits cleanly with no orphaned children.

> On Windows PowerShell, run the server in one terminal (`npm run web:start`) and `curl http://127.0.0.1:3000/health` in another; `cross-env` handles the `HOST` var cross-platform.

- [ ] **Step 4: Commit**

```bash
git add web/tests/bind.test.ts
git commit -m "test(web): assert start command binds loopback"
```

---

## Task 15: Operator UI polish (frontend-design)

**Files:**
- Modify: `web/src/routes/+layout.svelte` and page components; create `web/src/routes/+layout.svelte` styles or `web/src/app.css`.

- [ ] **Step 1: Invoke the `frontend-design:frontend-design` skill** to give the four screens a cohesive, production-grade operator look (state badges with color, a real table/cards layout, the coordinator-error banner, queue cards, flag toggles). Keep all existing `load`/`fetch` wiring and route structure intact — this is a presentational pass only. Do not introduce new dependencies that pull `halyard` toward the client bundle.

- [ ] **Step 2: Verify build + typecheck still pass**

Run: `npm run check --workspace web` then `npm run web:build`
Expected: 0 errors; build succeeds.

- [ ] **Step 3: Commit**

```bash
git add web/src/
git commit -m "feat(web): operator UI polish"
```

---

## Task 16: Documentation — start command, port, health, config root, stateDir

**Files:**
- Modify: `docs/INTEGRATION.md`, `README.md`
- Create: `web/README.md`

- [ ] **Step 1: Add a "Web console (head)" section to `docs/INTEGRATION.md`** documenting:
  - **Start:** from a Halyard project root, `npm run web:build` then `npm run web:start` (prod), or `npm run web:dev` (dev). Non-interactive.
  - **Port:** `PORT` env (default `3000`); binds `HOST=127.0.0.1` (loopback only).
  - **Health:** `GET /health` → `200 {status, root, stateDir, apps}` when a valid project is present, `503` when config is missing/invalid.
  - **Config root:** CWD by default, or `HALYARD_CONFIG_ROOT` (absolute). Reads `halyard.config.yml` + `apps/<slug>/app.yml` from that root.
  - **stateDir:** `org.coordinator.state_dir` resolved under the root (default `./state`) — the head reads it and writes only via approve/flip/reconcile.
  - **Scope note:** reconcile is transitions-only (flag poll); publicity fan-out (incl. owned auto-publish) stays with `halyard reconcile` (CLI/cron). Single-operator; don't run alongside the reconcile cron on the same `stateDir`.

- [ ] **Step 2: Add a short pointer in `README.md`** under the operator/usage section linking to the console section in `INTEGRATION.md` and the one-liner: "Web console: `npm run web:dev`."

- [ ] **Step 3: Create `web/README.md`** with the same start/health/config summary for someone landing in the workspace directly.

- [ ] **Step 4: Verify the full test suite + library tests are green**

Run (from root): `npm test` (library) and `npm run web:test` (console)
Expected: both green.

- [ ] **Step 5: Commit**

```bash
git add docs/INTEGRATION.md README.md web/README.md
git commit -m "docs: document the web console (start, port, health, config root, stateDir)"
```

---

## Task 17: Final verification (verification-before-completion)

- [ ] **Step 1: Invoke `superpowers:verification-before-completion`.** Run, from a Halyard project root:
  - `npm test` (library suite green — proves the library was untouched/uncompromised)
  - `npm run web:test` (console suite green)
  - `npm run check --workspace web` (0 type errors)
  - `npm run web:build` (production build succeeds)
  - `npm run web:start`, then `curl http://127.0.0.1:3000/health` → `200`, and load `http://127.0.0.1:3000/` in a browser to see the board render.
- [ ] **Step 2: Confirm a client-bundle has no `halyard`.** Inspect `web/build/client/` (or the Vite manifest) and confirm no chunk pulls in `halyard`/`@anthropic-ai/sdk`/`node:` builtins — the server-only boundary held. (If anything leaked, a universal `load` or component imported `$lib/server` — fix the import.)
- [ ] **Step 3: Show the evidence** (command output + a board screenshot/`/health` response) before claiming completion.

---

## Self-review notes (author)

- **Spec coverage:** status board (T10), approval queue + approve (T11, T5, T9), flag flip (T12, T6, T9), read-only browse (T13, T3), `coordinator_error` surfacing (T4 partition → T10 banner), credential-free offline reconcile transitions-only + multi-app gate (T7), `/health` semantics (T8), HOST loopback (T1, T14), Vite SSR external + server-only boundary (T1, T17 step 2), npm workspaces + build ordering (T1), CSRF stays on by default (no override added — endpoints are same-origin `fetch`), docs (T16). All spec sections map to a task.
- **No library changes** anywhere (verified: every imported symbol exists in `src/halyard/index.ts`).
- **Type consistency:** `createConsoleService({root, now})` and `service()` used consistently; `summarizeRelease(rel, now())` (string arg) honored in T3; `enforceMultiApp` throw caught → 403 in T9; `listQueue` returns `{open, errors}` used identically in T4/T10/T11.
- **CSRF:** not overridden, so `csrf.checkOrigin` stays on; same-origin `fetch` from the console's own pages satisfies it (spec §HTTP surface).
