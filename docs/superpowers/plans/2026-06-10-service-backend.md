# Service Backend (R3 Phase 1) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement `coordinator.backend: service` as thin HTTP client adapters over a shared `ServiceHttpClient`, at last-writer-wins parity with the git backend, so a hosted Halyard hub can store state behind an API. (Per [the design](../specs/2026-06-10-service-backend-design.md).)

**Architecture:** Five adapters (`Service{Record,Launch,Proposal,Ledger,Canon}Store`) implement the existing Phase-0 ports (`coordinator/ports.ts`, shipped PR #37) over a `ServiceHttpClient` that speaks a documented REST contract. Invariant #3 (dedup) is preserved by the *existing* client-side `appendTransition` idempotency — unchanged. Multi-writer concurrency control is explicitly deferred to a future phase. The hub server is out of scope; adapters are tested against an in-memory fake `fetch` implementing the contract.

**Tech Stack:** TypeScript (ESM, NodeNext), Zod, Vitest. Mirrors the existing `HttpFlagClient` pattern (`flags/http-client.ts`).

---

## File structure

**Create:**
- `src/halyard/coordinator/service/client.ts` — `ServiceHttpClient` + `ServiceHttpError` + options.
- `src/halyard/coordinator/service/record-store.ts` — `ServiceRecordStore implements RecordStore`.
- `src/halyard/coordinator/service/launch-store.ts` — `ServiceLaunchStore implements LaunchStore`.
- `src/halyard/coordinator/service/proposal-store.ts` — `ServiceProposalStore implements ProposalStore`.
- `src/halyard/coordinator/service/ledger-store.ts` — `ServiceLedgerStore implements LedgerStore`.
- `src/halyard/coordinator/service/canon-store.ts` — `ServiceCanonStore implements CanonStore`.
- `src/halyard/coordinator/service/index.ts` — `makeServiceBackend()` assembling the five adapters.
- `tests/helpers/fake-service.ts` — in-memory contract-faithful fake `fetch` (used by adapter tests + parity).
- `tests/service-client.test.ts`, `tests/service-record-store.test.ts`, `tests/service-launch-store.test.ts`, `tests/service-proposal-store.test.ts`, `tests/service-ledger-store.test.ts`, `tests/service-canon-store.test.ts`, `tests/service-backend.test.ts`, `tests/service-config.test.ts`, `tests/service-makebackend.test.ts`, `tests/service-preflight.test.ts`, `tests/service-parity.test.ts`.

**Modify:**
- `src/halyard/config/org-config.schema.ts` — add `coordinator.service` + `superRefine`.
- `src/halyard/config/backend.ts` — `makeBackend` service branch; `assertSupportedBackend` accepts `service`.
- `src/halyard/coordinator/preflight.ts` — add a `coordinator-service` readiness item.
- `src/halyard/index.ts` — export `ServiceHttpClient`, `ServiceHttpError`, `makeServiceBackend`.
- `tests/backend.test.ts` — update the now-stale "rejects service" test.

**Dependency order:** client (Task 1) → fake (Task 2) → five adapters (Tasks 3–7) → assemble (Task 8) → config (Task 9) → makeBackend wiring (Task 10) → preflight (Task 11) → parity + full verify (Task 12). Tasks 3–7 are independent of each other (the parallel lanes) once Tasks 1–2 land.

All commands run from the repo root `d:/MajorProjects/INFRASTRUCTURE/halyard`. Branch: `feat/service-backend` (create it first: `git checkout -b feat/service-backend`).

---

### Task 1: ServiceHttpClient + ServiceHttpError

**Files:**
- Create: `src/halyard/coordinator/service/client.ts`
- Test: `tests/service-client.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-client.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient, ServiceHttpError } from "../src/halyard/coordinator/service/client.js";

/** A fetch double that records the request and returns a canned Response. */
function cannedFetch(res: Response, sink?: (url: string, init: RequestInit) => void) {
  return (async (url: any, init: any = {}) => {
    sink?.(String(url), init);
    return res;
  }) as typeof fetch;
}

describe("ServiceHttpClient", () => {
  it("GET 200 returns parsed JSON; sends bearer auth + strips trailing slash", async () => {
    let seenUrl = "";
    let seenAuth = "";
    const client = new ServiceHttpClient({
      baseUrl: "https://svc/",
      token: "tok_secret",
      fetchFn: cannedFetch(new Response(JSON.stringify({ ok: true }), { status: 200 }), (u, i) => {
        seenUrl = u;
        seenAuth = (i.headers as Record<string, string>).authorization;
      }),
    });
    const body = await client.getJson("/releases/rel_1");
    expect(body).toEqual({ ok: true });
    expect(seenUrl).toBe("https://svc/releases/rel_1");
    expect(seenAuth).toBe("Bearer tok_secret");
  });

  it("GET 404 returns null (not an error)", async () => {
    const client = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 404 })) });
    expect(await client.getJson("/releases/missing")).toBeNull();
  });

  it("GET 500 throws a retryable ServiceHttpError; 400 throws non-retryable", async () => {
    const c500 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 500 })) });
    await expect(c500.getJson("/x")).rejects.toMatchObject({ name: "ServiceHttpError", status: 500, retryable: true });
    const c400 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 400 })) });
    await expect(c400.getJson("/x")).rejects.toMatchObject({ status: 400, retryable: false });
  });

  it("sendJson PUT 204 resolves undefined; PUT 200 returns body", async () => {
    const c204 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(null, { status: 204 })) });
    expect(await c204.sendJson("PUT", "/releases/r", { a: 1 })).toBeUndefined();
    const c200 = new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn: cannedFetch(new Response(JSON.stringify({ created: true }), { status: 200 })) });
    expect(await c200.sendJson("PUT", "/canon/c", {})).toEqual({ created: true });
  });

  it("a network error (or abort) becomes a retryable ServiceHttpError", async () => {
    const client = new ServiceHttpClient({
      baseUrl: "https://svc",
      token: "t",
      timeoutMs: 5,
      // never resolves; rejects when the timeout aborts the signal
      fetchFn: ((_u: any, init: any) =>
        new Promise((_res, rej) => init.signal?.addEventListener("abort", () => rej(new Error("aborted"))))) as typeof fetch,
    });
    await expect(client.getJson("/slow")).rejects.toMatchObject({ name: "ServiceHttpError", retryable: true });
  });

  it("never includes the token in a thrown error message", async () => {
    const client = new ServiceHttpClient({ baseUrl: "https://svc", token: "SUPERSECRET", fetchFn: cannedFetch(new Response(null, { status: 500 })) });
    await client.getJson("/x").catch((e: Error) => expect(e.message).not.toContain("SUPERSECRET"));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-client.test.ts`
Expected: FAIL — cannot find module `client.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/client.ts
type FetchFn = typeof fetch;

/** Error from the Halyard state service. `retryable` is true for 5xx/network/timeout, false for 4xx. */
export class ServiceHttpError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
    this.name = "ServiceHttpError";
  }
}

export interface ServiceHttpClientOptions {
  baseUrl: string;
  token: string;
  fetchFn?: FetchFn;
  /** Request timeout in ms (default 10_000). A wedged fetch must not stall a reconcile sweep. */
  timeoutMs?: number;
}

/**
 * Thin HTTP client for the Halyard state service. Mirrors `flags/http-client.ts`: bearer auth from a
 * runtime-resolved token (never logged), constructor-injected `fetchFn` for tests. Adds a request
 * timeout (the flag client has none) and a typed error. The adapters layer port semantics on top.
 */
export class ServiceHttpClient {
  private readonly baseUrl: string;
  private readonly fetchFn: FetchFn;
  private readonly timeoutMs: number;

  constructor(private readonly opts: ServiceHttpClientOptions) {
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.fetchFn = opts.fetchFn ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 10_000;
  }

  private async request(method: string, path: string, body?: unknown): Promise<Response> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      return await this.fetchFn(`${this.baseUrl}${path}`, {
        method,
        headers: { authorization: `Bearer ${this.opts.token}`, "content-type": "application/json" },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: controller.signal,
      });
    } catch (err) {
      // Network failure / timeout abort → retryable. Message must never carry the token.
      const detail = err instanceof Error ? err.message : String(err);
      throw new ServiceHttpError(`service ${method} ${path} failed: ${detail}`, 0, true);
    } finally {
      clearTimeout(timer);
    }
  }

  /** GET → 200 parsed JSON, 404 → null, other non-2xx → throw. */
  async getJson(path: string): Promise<unknown | null> {
    const res = await this.request("GET", path);
    if (res.status === 404) return null;
    if (!res.ok) throw new ServiceHttpError(`service GET ${path} ${res.status}`, res.status, res.status >= 500);
    return res.json();
  }

  /** PUT/POST → 2xx parsed JSON (undefined if empty body), non-2xx → throw. */
  async sendJson(method: "PUT" | "POST", path: string, body: unknown): Promise<unknown> {
    const res = await this.request(method, path, body);
    if (!res.ok) throw new ServiceHttpError(`service ${method} ${path} ${res.status}`, res.status, res.status >= 500);
    const text = await res.text();
    return text ? JSON.parse(text) : undefined;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-client.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/client.ts tests/service-client.test.ts
git commit -m "feat(service): ServiceHttpClient + ServiceHttpError"
```

---

### Task 2: In-memory contract-faithful fake `fetch`

**Files:**
- Create: `tests/helpers/fake-service.ts`
- Test: `tests/helpers/fake-service.ts` self-check is exercised by later adapter tests (no standalone test file — it is test infra).

- [ ] **Step 1: Write the fake**

```ts
// tests/helpers/fake-service.ts
/**
 * An in-memory fake of the Halyard state-service HTTP contract, returned as a `fetchFn` for
 * ServiceHttpClient. Behaviour matches the contract in the design doc, including the ledger's
 * server-side set-union (the one accumulating endpoint) and canon create-if-absent. `GET` list
 * endpoints return ids in INSERTION order (deliberately unsorted) so adapter tests prove the
 * client-side sort. Use `baseUrl: "https://svc"` so paths are bare (`/releases/...`).
 */
export function makeFakeServiceFetch() {
  const releases = new Map<string, unknown>();
  const launches = new Map<string, unknown>();
  const proposals = new Map<string, unknown>();
  const ledgers = new Map<string, Set<string>>();
  const canon = new Map<string, unknown>();
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const noContent = () => new Response(null, { status: 204 });

  const fetchFn = (async (url: any, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = new URL(String(url)).pathname; // baseUrl "https://svc" → "/releases/x"
    const body = init.body ? JSON.parse(init.body) : undefined;
    const seg = path.split("/").filter(Boolean); // e.g. ["releases","rel_1"] or ["ledgers","l","announced"]

    const single = (map: Map<string, unknown>, idKey: string) => {
      const id = decodeURIComponent(seg[1]!);
      if (method === "GET") return map.has(id) ? json(map.get(id)) : new Response(null, { status: 404 });
      if (method === "PUT") { map.set(id, body); return noContent(); }
      return new Response(null, { status: 405 });
    };

    if (seg[0] === "releases") return seg.length === 1 ? json([...releases.keys()]) : single(releases, "release_id");
    if (seg[0] === "launches") return seg.length === 1 ? json([...launches.keys()]) : single(launches, "launch_id");
    if (seg[0] === "proposals") return seg.length === 1 ? json([...proposals.values()]) : single(proposals, "proposal_id");

    if (seg[0] === "ledgers") {
      const lid = decodeURIComponent(seg[1]!);
      if (seg.length === 2 && method === "GET") {
        return ledgers.has(lid) ? json([...ledgers.get(lid)!]) : new Response(null, { status: 404 });
      }
      if (seg[2] === "announced" && method === "POST") {
        const set = ledgers.get(lid) ?? new Set<string>();
        set.add(body.key); // server-side set-union — the one accumulating endpoint
        ledgers.set(lid, set);
        return noContent();
      }
    }

    if (seg[0] === "canon" && method === "PUT") {
      const id = decodeURIComponent(seg[1]!);
      if (canon.has(id)) return json({ created: false });
      canon.set(id, body);
      return json({ created: true });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return { fetchFn, stores: { releases, launches, proposals, ledgers, canon } };
}
```

- [ ] **Step 2: Commit**

```bash
git add tests/helpers/fake-service.ts
git commit -m "test(service): in-memory contract-faithful fake fetch"
```

(No run step — this file is exercised by Tasks 3–8 and 12. If you want a smoke check now, `npx tsc -p tsconfig.json --noEmit` should still pass.)

---

### Task 3: ServiceRecordStore

**Files:**
- Create: `src/halyard/coordinator/service/record-store.ts`
- Test: `tests/service-record-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-record-store.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient } from "../src/halyard/coordinator/service/client.js";
import { ServiceRecordStore } from "../src/halyard/coordinator/service/record-store.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

function store() {
  const { fetchFn } = makeFakeServiceFetch();
  return new ServiceRecordStore(new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn }));
}

describe("ServiceRecordStore", () => {
  it("write then read round-trips a Release (validated)", async () => {
    const s = store();
    const r = newRelease({ releaseId: "rel_a_web_1.0.0", app: "a", surface: "web", version: "1.0.0" });
    expect(await s.read("rel_a_web_1.0.0")).toBeNull();
    await s.write(r);
    expect(await s.read("rel_a_web_1.0.0")).toEqual(r);
  });

  it("scanIds returns ids sorted (server order is insertion order)", async () => {
    const s = store();
    for (const v of ["1.2.0", "1.0.0", "1.10.0"]) {
      await s.write(newRelease({ releaseId: `rel_a_web_${v}`, app: "a", surface: "web", version: v }));
    }
    expect(await s.scanIds()).toEqual(["rel_a_web_1.0.0", "rel_a_web_1.10.0", "rel_a_web_1.2.0"]); // bare .sort()
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-record-store.test.ts`
Expected: FAIL — cannot find module `record-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/record-store.ts
import { ReleaseSchema, type Release } from "../../contracts/release.schema.js";
import type { RecordStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

/** Release records over the Halyard state service. Validates on read (invariant #1); sorts ids client-side (git parity). */
export class ServiceRecordStore implements RecordStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(releaseId: string): Promise<Release | null> {
    const raw = await this.client.getJson(`/releases/${encodeURIComponent(releaseId)}`);
    return raw === null ? null : ReleaseSchema.parse(raw);
  }

  async write(release: Release): Promise<void> {
    await this.client.sendJson("PUT", `/releases/${encodeURIComponent(release.release_id)}`, release);
  }

  async scanIds(): Promise<string[]> {
    const raw = (await this.client.getJson("/releases")) as string[] | null;
    return (raw ?? []).slice().sort(); // bare sort, matching scanReleaseIds
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-record-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/record-store.ts tests/service-record-store.test.ts
git commit -m "feat(service): ServiceRecordStore adapter"
```

---

### Task 4: ServiceLaunchStore

**Files:**
- Create: `src/halyard/coordinator/service/launch-store.ts`
- Test: `tests/service-launch-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-launch-store.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient } from "../src/halyard/coordinator/service/client.js";
import { ServiceLaunchStore } from "../src/halyard/coordinator/service/launch-store.js";
import { newLaunch } from "../src/halyard/coordinator/launch-store.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

function store() {
  const { fetchFn } = makeFakeServiceFetch();
  return new ServiceLaunchStore(new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn }));
}
const mk = (feature: string) =>
  newLaunch({ app: "a", feature, title: feature, narrativeSeed: "n", announcePolicy: "per_surface", tier: "standard", flag: `launch.a.${feature}`, createdBy: "t", createdAt: "2026-06-10T00:00:00.000Z" });

describe("ServiceLaunchStore", () => {
  it("write then read round-trips a Launch", async () => {
    const s = store();
    const l = mk("beta");
    expect(await s.read(l.launch_id)).toBeNull();
    await s.write(l);
    expect(await s.read(l.launch_id)).toEqual(l);
  });

  it("scanIds returns ids sorted", async () => {
    const s = store();
    await s.write(mk("gamma"));
    await s.write(mk("alpha"));
    expect(await s.scanIds()).toEqual(["lnch_a_alpha", "lnch_a_gamma"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-launch-store.test.ts`
Expected: FAIL — cannot find module `launch-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/launch-store.ts
import { LaunchSchema, type Launch } from "../../contracts/launch.schema.js";
import type { LaunchStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceLaunchStore implements LaunchStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(launchId: string): Promise<Launch | null> {
    const raw = await this.client.getJson(`/launches/${encodeURIComponent(launchId)}`);
    return raw === null ? null : LaunchSchema.parse(raw);
  }

  async write(launch: Launch): Promise<void> {
    await this.client.sendJson("PUT", `/launches/${encodeURIComponent(launch.launch_id)}`, launch);
  }

  async scanIds(): Promise<string[]> {
    const raw = (await this.client.getJson("/launches")) as string[] | null;
    return (raw ?? []).slice().sort(); // bare sort, matching scanLaunchIds
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-launch-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/launch-store.ts tests/service-launch-store.test.ts
git commit -m "feat(service): ServiceLaunchStore adapter"
```

---

### Task 5: ServiceProposalStore

**Files:**
- Create: `src/halyard/coordinator/service/proposal-store.ts`
- Test: `tests/service-proposal-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-proposal-store.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient } from "../src/halyard/coordinator/service/client.js";
import { ServiceProposalStore } from "../src/halyard/coordinator/service/proposal-store.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

function store() {
  const { fetchFn } = makeFakeServiceFetch();
  return new ServiceProposalStore(new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn }));
}
const mk = (id: string): Proposal => ({ proposal_id: id, kind: "flag_removal", app: "a", title: id, body: "b", status: "open", created_at: "2026-06-10T00:00:00.000Z" });

describe("ServiceProposalStore", () => {
  it("write then read round-trips a Proposal", async () => {
    const s = store();
    expect(await s.read("p1")).toBeNull();
    await s.write(mk("p1"));
    expect(await s.read("p1")).toEqual(mk("p1"));
  });

  it("list returns proposals sorted by proposal_id (localeCompare)", async () => {
    const s = store();
    await s.write(mk("prop_b"));
    await s.write(mk("prop_a"));
    expect((await s.list()).map((p) => p.proposal_id)).toEqual(["prop_a", "prop_b"]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-proposal-store.test.ts`
Expected: FAIL — cannot find module `proposal-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/proposal-store.ts
import { ProposalSchema, type Proposal } from "../../contracts/proposal.schema.js";
import type { ProposalStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceProposalStore implements ProposalStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async read(proposalId: string): Promise<Proposal | null> {
    const raw = await this.client.getJson(`/proposals/${encodeURIComponent(proposalId)}`);
    return raw === null ? null : ProposalSchema.parse(raw);
  }

  async write(proposal: Proposal): Promise<void> {
    await this.client.sendJson("PUT", `/proposals/${encodeURIComponent(proposal.proposal_id)}`, proposal);
  }

  async list(): Promise<Proposal[]> {
    const raw = (await this.client.getJson("/proposals")) as unknown[] | null;
    return (raw ?? [])
      .map((p) => ProposalSchema.parse(p))
      .sort((a, b) => a.proposal_id.localeCompare(b.proposal_id)); // matches listProposals
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-proposal-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/proposal-store.ts tests/service-proposal-store.test.ts
git commit -m "feat(service): ServiceProposalStore adapter"
```

---

### Task 6: ServiceLedgerStore

**Files:**
- Create: `src/halyard/coordinator/service/ledger-store.ts`
- Test: `tests/service-ledger-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-ledger-store.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient } from "../src/halyard/coordinator/service/client.js";
import { ServiceLedgerStore } from "../src/halyard/coordinator/service/ledger-store.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

function store() {
  const { fetchFn } = makeFakeServiceFetch();
  return new ServiceLedgerStore(new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn }));
}

describe("ServiceLedgerStore", () => {
  it("readAnnounced is an empty Set before anything is marked", async () => {
    expect(await store().readAnnounced("lnch_a_x")).toEqual(new Set());
  });

  it("markAnnounced accumulates (server-side set-union), readAnnounced returns the union", async () => {
    const s = store();
    await s.markAnnounced("lnch_a_x", "scope:launch");
    await s.markAnnounced("lnch_a_x", "scope:web");
    await s.markAnnounced("lnch_a_x", "scope:launch"); // idempotent
    expect(await s.readAnnounced("lnch_a_x")).toEqual(new Set(["scope:launch", "scope:web"]));
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-ledger-store.test.ts`
Expected: FAIL — cannot find module `ledger-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/ledger-store.ts
import type { LedgerStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

/** Publicity ledger over the service. `markAnnounced` is the one accumulating endpoint (server set-union). */
export class ServiceLedgerStore implements LedgerStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async readAnnounced(launchId: string): Promise<Set<string>> {
    const raw = (await this.client.getJson(`/ledgers/${encodeURIComponent(launchId)}`)) as string[] | null;
    return new Set(raw ?? []);
  }

  async markAnnounced(launchId: string, scopeKey: string): Promise<void> {
    await this.client.sendJson("POST", `/ledgers/${encodeURIComponent(launchId)}/announced`, { key: scopeKey });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-ledger-store.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/ledger-store.ts tests/service-ledger-store.test.ts
git commit -m "feat(service): ServiceLedgerStore adapter"
```

---

### Task 7: ServiceCanonStore

**Files:**
- Create: `src/halyard/coordinator/service/canon-store.ts`
- Test: `tests/service-canon-store.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-canon-store.test.ts
import { describe, expect, it } from "vitest";
import { ServiceHttpClient } from "../src/halyard/coordinator/service/client.js";
import { ServiceCanonStore } from "../src/halyard/coordinator/service/canon-store.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

function store() {
  const { fetchFn } = makeFakeServiceFetch();
  return new ServiceCanonStore(new ServiceHttpClient({ baseUrl: "https://svc", token: "t", fetchFn }));
}

describe("ServiceCanonStore", () => {
  it("append returns true when newly written, false when the id already exists", async () => {
    const s = store();
    const entry = { id: "canon_p1", channel: "x", text: "hello", approvedAt: "2026-06-10T00:00:00.000Z" };
    expect(await s.append(entry)).toBe(true);
    expect(await s.append(entry)).toBe(false); // idempotent on id
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-canon-store.test.ts`
Expected: FAIL — cannot find module `canon-store.js`.

- [ ] **Step 3: Write the implementation**

```ts
// src/halyard/coordinator/service/canon-store.ts
import type { CanonEntry } from "../../publicity/canon-store.js";
import type { CanonStore } from "../ports.js";
import type { ServiceHttpClient } from "./client.js";

export class ServiceCanonStore implements CanonStore {
  constructor(private readonly client: ServiceHttpClient) {}

  async append(entry: CanonEntry): Promise<boolean> {
    const body = (await this.client.sendJson("PUT", `/canon/${encodeURIComponent(entry.id)}`, entry)) as { created: boolean };
    return body.created;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-canon-store.test.ts`
Expected: PASS (1 test).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/service/canon-store.ts tests/service-canon-store.test.ts
git commit -m "feat(service): ServiceCanonStore adapter"
```

---

### Task 8: makeServiceBackend + package exports

**Files:**
- Create: `src/halyard/coordinator/service/index.ts`
- Modify: `src/halyard/index.ts`
- Test: `tests/service-backend.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-backend.test.ts
import { describe, expect, it } from "vitest";
import { makeServiceBackend } from "../src/halyard/coordinator/service/index.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";

describe("makeServiceBackend", () => {
  it("assembles a Backend whose five stores all reach the service", async () => {
    const { fetchFn } = makeFakeServiceFetch();
    const backend = makeServiceBackend({ baseUrl: "https://svc", token: "t", fetchFn });
    await backend.records.write(newRelease({ releaseId: "rel_a_web_1.0.0", app: "a", surface: "web", version: "1.0.0" }));
    expect(await backend.records.scanIds()).toEqual(["rel_a_web_1.0.0"]);
    await backend.ledger.markAnnounced("lnch_a_x", "k");
    expect(await backend.ledger.readAnnounced("lnch_a_x")).toEqual(new Set(["k"]));
    expect(await backend.canon.append({ id: "c1", text: "t", approvedAt: "2026-06-10T00:00:00.000Z" })).toBe(true);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-backend.test.ts`
Expected: FAIL — cannot find module `service/index.js`.

- [ ] **Step 3: Write `makeServiceBackend`**

```ts
// src/halyard/coordinator/service/index.ts
import type { Backend } from "../ports.js";
import { ServiceHttpClient, type ServiceHttpClientOptions } from "./client.js";
import { ServiceRecordStore } from "./record-store.js";
import { ServiceLaunchStore } from "./launch-store.js";
import { ServiceProposalStore } from "./proposal-store.js";
import { ServiceLedgerStore } from "./ledger-store.js";
import { ServiceCanonStore } from "./canon-store.js";

export { ServiceHttpClient, ServiceHttpError } from "./client.js";
export type { ServiceHttpClientOptions } from "./client.js";

/** Assemble the service `Backend` from one shared HTTP client. */
export function makeServiceBackend(opts: ServiceHttpClientOptions): Backend {
  const client = new ServiceHttpClient(opts);
  return {
    records: new ServiceRecordStore(client),
    launches: new ServiceLaunchStore(client),
    proposals: new ServiceProposalStore(client),
    ledger: new ServiceLedgerStore(client),
    canon: new ServiceCanonStore(client),
  };
}
```

- [ ] **Step 4: Export from the package root**

In `src/halyard/index.ts`, find the block added by Phase 0:
```ts
// Persistence ports + git backend (R3 Phase 0)
export * from "./coordinator/ports.js";
export { makeGitBackend } from "./coordinator/git-backend.js";
```
Replace it with:
```ts
// Persistence ports + git backend (R3 Phase 0)
export * from "./coordinator/ports.js";
export { makeGitBackend } from "./coordinator/git-backend.js";

// Service backend (R3 Phase 1)
export { makeServiceBackend, ServiceHttpClient, ServiceHttpError } from "./coordinator/service/index.js";
export type { ServiceHttpClientOptions } from "./coordinator/service/index.js";
```

- [ ] **Step 5: Run test + typecheck**

Run: `npx vitest run tests/service-backend.test.ts && npm run typecheck`
Expected: PASS (1 test); typecheck clean.

- [ ] **Step 6: Commit**

```bash
git add src/halyard/coordinator/service/index.ts src/halyard/index.ts tests/service-backend.test.ts
git commit -m "feat(service): makeServiceBackend + package exports"
```

---

### Task 9: `coordinator.service` config schema + superRefine

**Files:**
- Modify: `src/halyard/config/org-config.schema.ts`
- Modify: `tests/backend.test.ts` (the existing "rejects service" test is now stale)
- Test: `tests/service-config.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-config.test.ts
import { describe, expect, it } from "vitest";
import { OrgConfigSchema } from "../src/halyard/config/org-config.schema.js";

const base = {
  version: 1,
  org: { name: "Acme" },
  notifications: { approval_channel_ref: "SECRET:APPROVAL" },
  drafting: { provider: "anthropic", model: "claude-x", api_key_ref: "SECRET:ANTHROPIC", voice_canon: "canon" },
  channels: {},
  defaults: { announce_policy: "per_surface" },
};
const git = (extra = {}) => ({ ...base, coordinator: { backend: "git", state_dir: "state", reconcile_cron: "*/20 * * * *", ...extra } });
const service = (extra = {}) => ({ ...base, coordinator: { backend: "service", state_dir: "state", reconcile_cron: "*/20 * * * *", ...extra } });

describe("coordinator.service schema", () => {
  it("accepts a service backend with a service block", () => {
    expect(() => OrgConfigSchema.parse(service({ service: { api_url: "https://h.example.com/api", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" } }))).not.toThrow();
  });
  it("rejects backend: service WITHOUT a service block", () => {
    expect(() => OrgConfigSchema.parse(service())).toThrow(/service config is required/);
  });
  it("rejects backend: git WITH a service block", () => {
    expect(() => OrgConfigSchema.parse(git({ service: { api_url: "https://h.example.com/api", api_key_ref: "SECRET:X" } }))).toThrow(/not allowed/);
  });
  it("still accepts a plain git backend", () => {
    expect(() => OrgConfigSchema.parse(git())).not.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-config.test.ts`
Expected: FAIL — the service block is rejected by `.strict()` (unknown key) / no superRefine yet.

- [ ] **Step 3: Update `CoordinatorSchema`**

In `src/halyard/config/org-config.schema.ts`, replace:
```ts
const CoordinatorSchema = z
  .object({
    backend: z.enum(["git", "service"]),
    state_dir: z.string().min(1),
    reconcile_cron: CronSchema,
    dedup: z.boolean().default(true),
  })
  .strict();
```
with:
```ts
const CoordinatorSchema = z
  .object({
    backend: z.enum(["git", "service"]),
    state_dir: z.string().min(1), // required for git; an ignored placeholder for service
    // Present iff backend: service. The DB lives behind this API (the hub owns it); the
    // library is a thin HTTP client. URL is non-secret; the token comes from api_key_ref at runtime.
    service: z
      .object({ api_url: z.string().url(), api_key_ref: SecretRefSchema })
      .strict()
      .optional(),
    reconcile_cron: CronSchema,
    dedup: z.boolean().default(true), // currently inert: invariant #3 is hardwired in appendTransition
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.backend === "git" && c.service) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service"], message: 'service config is not allowed for backend "git"' });
    }
    if (c.backend === "service" && !c.service) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service"], message: 'service config is required for backend "service"' });
    }
  });
```
(`SecretRefSchema` is already imported at the top of the file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-config.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Fix the now-stale `tests/backend.test.ts`**

The old test flips `backend` to `"service"` with no service block and expects `assertSupportedBackend` to throw `/not implemented/`. That config now fails validation earlier, and `service` will become supported (Task 10). Replace the second `it(...)` in `tests/backend.test.ts`:
```ts
  it("requires a service block when the service backend is selected", () => {
    expect(() => validateOrgConfig({ ...orgRaw, coordinator: { ...orgRaw.coordinator, backend: "service" } })).toThrow(/service config is required/);
  });
```
(Keep the first test — "accepts the git backend" — unchanged.)

- [ ] **Step 6: Run both + typecheck**

Run: `npx vitest run tests/service-config.test.ts tests/backend.test.ts && npm run typecheck`
Expected: PASS; typecheck clean.

- [ ] **Step 7: Commit**

```bash
git add src/halyard/config/org-config.schema.ts tests/service-config.test.ts tests/backend.test.ts
git commit -m "feat(service): coordinator.service config schema + superRefine"
```

---

### Task 10: `makeBackend` service branch + `assertSupportedBackend` accepts service

**Files:**
- Modify: `src/halyard/config/backend.ts`
- Test: `tests/service-makebackend.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-makebackend.test.ts
import { describe, expect, it, afterEach } from "vitest";
import { makeBackend } from "../src/halyard/config/backend.js";
import { setSecretStore, envSecretStore } from "../src/halyard/secrets/resolve.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";
import type { OrgConfig } from "../src/halyard/config/org-config.schema.js";

afterEach(() => setSecretStore(envSecretStore));

function orgService(): OrgConfig {
  return {
    version: 1, org: { name: "Acme" },
    coordinator: { backend: "service", state_dir: "state", reconcile_cron: "*/20 * * * *", dedup: true,
      service: { api_url: "https://svc", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" } },
    notifications: { approval_channel_ref: "SECRET:APPROVAL" },
    drafting: { provider: "anthropic", model: "m", api_key_ref: "SECRET:ANTHROPIC", voice_canon: "canon" },
    channels: {}, defaults: { announce_policy: "per_surface" },
  } as OrgConfig;
}

describe("makeBackend — service branch", () => {
  it("constructs a service backend when the token resolves", async () => {
    setSecretStore({ get: (n) => (n === "HALYARD_SERVICE_TOKEN" ? "tok" : undefined) });
    const { fetchFn } = makeFakeServiceFetch();
    const backend = makeBackend(orgService(), { stateDir: "ignored", fetchFn });
    // Reaches the fake service (no throw, empty scan).
    expect(await backend.records.scanIds()).toEqual([]);
  });

  it("hard-fails when the service token is unresolvable (no git fallback)", () => {
    setSecretStore({ get: () => undefined });
    expect(() => makeBackend(orgService(), { stateDir: "ignored" })).toThrow(/HALYARD_SERVICE_TOKEN/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-makebackend.test.ts`
Expected: FAIL — `makeBackend` ignores `coordinator.service` / has no `fetchFn` param, builds a git backend.

- [ ] **Step 3: Update `config/backend.ts`**

Replace the whole file with:
```ts
import type { OrgConfig } from "./org-config.schema.js";
import { secretName } from "./secret-ref.js";
import { tryResolveSecret } from "../secrets/resolve.js";
import { makeGitBackend } from "../coordinator/git-backend.js";
import { makeServiceBackend } from "../coordinator/service/index.js";
import type { Backend } from "../coordinator/ports.js";

/**
 * `coordinator.backend` is `git | service`; both are implemented. Kept as a guard so an
 * out-of-enum value (should be impossible post-validation) still fails loudly.
 */
export function assertSupportedBackend(org: OrgConfig): void {
  if (org.coordinator.backend !== "git" && org.coordinator.backend !== "service") {
    throw new Error(`coordinator.backend "${org.coordinator.backend}" is not implemented`);
  }
}

/**
 * The single decision point for persistence: select the adapter set from `coordinator.backend`.
 *   - `git`     → filesystem adapters under `stateDir`/`canonDir`.
 *   - `service` → HTTP adapters against `coordinator.service.api_url`, bearer-authed with the
 *     `api_key_ref` token resolved at runtime. HARD-FAILS if the block/token is missing — a remote
 *     store cannot do anything (even reads) without its token, and there is NO git fallback. `fetchFn`
 *     is an optional test seam.
 */
export function makeBackend(
  org: OrgConfig,
  opts: { stateDir: string; canonDir?: string; fetchFn?: typeof fetch },
): Backend {
  assertSupportedBackend(org);
  if (org.coordinator.backend === "service") {
    const svc = org.coordinator.service;
    if (!svc) throw new Error('coordinator.backend "service" requires a coordinator.service block');
    const token = tryResolveSecret(svc.api_key_ref);
    if (!token) {
      throw new Error(`coordinator.service token ${secretName(svc.api_key_ref)} is not set — the service backend requires it (no git fallback)`);
    }
    return makeServiceBackend({ baseUrl: svc.api_url, token, ...(opts.fetchFn ? { fetchFn: opts.fetchFn } : {}) });
  }
  return makeGitBackend(opts);
}
```
(`secretName` is exported from `config/secret-ref.ts`; `tryResolveSecret` from `secrets/resolve.ts` — both already used elsewhere.)

- [ ] **Step 4: Run test + typecheck + full suite (no regressions)**

Run: `npx vitest run tests/service-makebackend.test.ts && npm run typecheck && npx vitest run`
Expected: service-makebackend PASS (2); typecheck clean; full suite still 258+ green (the `makeBackend` git path is unchanged).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/config/backend.ts tests/service-makebackend.test.ts
git commit -m "feat(service): makeBackend service branch (hard-fail on missing token)"
```

---

### Task 11: preflight `coordinator-service` readiness item

**Files:**
- Modify: `src/halyard/coordinator/preflight.ts`
- Test: `tests/service-preflight.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
// tests/service-preflight.test.ts
import { describe, expect, it } from "vitest";
import { assessReadiness } from "../src/halyard/coordinator/preflight.js";
import { loadOrgConfig, loadAppConfig } from "../src/halyard/config/loader.js";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const app = loadAppConfig(resolve(here, "..", "apps", "aurora", "app.yml"));
const baseOrg = loadOrgConfig(resolve(here, "..", "halyard.config.yml"));

function serviceOrg() {
  return {
    ...baseOrg,
    coordinator: { ...baseOrg.coordinator, backend: "service" as const,
      service: { api_url: "https://svc", api_key_ref: "SECRET:HALYARD_SERVICE_TOKEN" } },
  };
}
const resolves = (names: string[]) => (n: string) => (names.includes(n) ? "x" : undefined);

describe("preflight: coordinator-service", () => {
  it("adds a required coordinator-service item that is unconfigured when the token is absent", () => {
    const report = assessReadiness(app, serviceOrg(), resolves([]));
    const item = report.items.find((i) => i.integration === "coordinator-service");
    expect(item).toBeDefined();
    expect(item!.required).toBe(true);
    expect(item!.configured).toBe(false);
    expect(report.ready).toBe(false);
  });

  it("is configured when the token resolves", () => {
    const report = assessReadiness(app, serviceOrg(), resolves(["HALYARD_SERVICE_TOKEN"]));
    expect(report.items.find((i) => i.integration === "coordinator-service")!.configured).toBe(true);
  });

  it("git backend has no coordinator-service item", () => {
    const report = assessReadiness(app, baseOrg, resolves([]));
    expect(report.items.find((i) => i.integration === "coordinator-service")).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/service-preflight.test.ts`
Expected: FAIL — no `coordinator-service` item exists.

- [ ] **Step 3: Add the readiness item**

In `src/halyard/coordinator/preflight.ts`, immediately after the `approval-surface` item push (before the `flags` block), insert:
```ts
  // Coordinator service backend — required when selected: every state command needs this token.
  if (org.coordinator.backend === "service" && org.coordinator.service) {
    const keyName = secretName(org.coordinator.service.api_key_ref);
    items.push({ integration: "coordinator-service", required: true, configured: has(keyName), detail: keyName });
  }
```
(`secretName` is already imported in this file.)

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/service-preflight.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/halyard/coordinator/preflight.ts tests/service-preflight.test.ts
git commit -m "feat(service): preflight requires the coordinator service token"
```

---

### Task 12: git-vs-service parity slice + full verification

**Files:**
- Test: `tests/service-parity.test.ts`

- [ ] **Step 1: Write the parity test**

```ts
// tests/service-parity.test.ts
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { makeGitBackend } from "../src/halyard/coordinator/git-backend.js";
import { makeServiceBackend } from "../src/halyard/coordinator/service/index.js";
import type { Backend } from "../src/halyard/coordinator/ports.js";
import { reconcile } from "../src/halyard/coordinator/reconcile.js";
import { proposeOnce } from "../src/halyard/coordinator/proposals.js";
import { appendTransition, newRelease } from "../src/halyard/coordinator/record-store.js";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { FlagFileClient } from "../src/halyard/flags/file-client.js";
import { makeFakeServiceFetch } from "./helpers/fake-service.js";
import type { Proposal } from "../src/halyard/contracts/proposal.schema.js";

let stateDir: string;
const now = () => "2026-06-10T00:00:00.000Z";
beforeEach(() => { stateDir = mkdtempSync(join(tmpdir(), "halyard-parity-")); });
afterEach(() => rmSync(stateDir, { recursive: true, force: true }));

/** Run the same operations against a backend and return the observable results. */
async function exercise(backend: Backend) {
  // records: write a couple, scan (order), read back
  await backend.records.write(newRelease({ releaseId: "rel_a_web_1.2.0", app: "a", surface: "web", version: "1.2.0" }));
  await backend.records.write(newRelease({ releaseId: "rel_a_web_1.10.0", app: "a", surface: "web", version: "1.10.0" }));
  const ids = await backend.records.scanIds();
  // proposals: create-once is idempotent
  const p: Proposal = { proposal_id: "prop_x", kind: "flag_removal", app: "a", title: "t", body: "b", status: "open", created_at: now() };
  const first = await proposeOnce(backend.proposals, p);
  const second = await proposeOnce(backend.proposals, p);
  const list = (await backend.proposals.list()).map((x) => x.proposal_id);
  // ledger: multi-key union (the fan-out path)
  await backend.ledger.markAnnounced("lnch_a_x", "scope:launch");
  await backend.ledger.markAnnounced("lnch_a_x", "scope:web");
  const announced = [...(await backend.ledger.readAnnounced("lnch_a_x"))].sort();
  // canon: create-if-absent
  const c1 = await backend.canon.append({ id: "canon_1", text: "hello", approvedAt: now() });
  const c2 = await backend.canon.append({ id: "canon_1", text: "hello", approvedAt: now() });
  return { ids, firstCreated: first.created, secondCreated: second.created, list, announced, c1, c2 };
}

describe("git vs service backend parity", () => {
  it("produces identical observable results for the same operations", async () => {
    const git = makeGitBackend({ stateDir, canonDir: join(stateDir, "canon") });
    const { fetchFn } = makeFakeServiceFetch();
    const service = makeServiceBackend({ baseUrl: "https://svc", token: "t", fetchFn });

    const gitResult = await exercise(git);
    const serviceResult = await exercise(service);

    expect(serviceResult).toEqual(gitResult);
    // sanity: the shared expectations
    expect(gitResult.ids).toEqual(["rel_a_web_1.10.0", "rel_a_web_1.2.0"]);
    expect(gitResult).toMatchObject({ firstCreated: true, secondCreated: false, announced: ["scope:launch", "scope:web"], c1: true, c2: false });
  });

  it("reconcile flips a flag to live identically on the service backend", async () => {
    // Seed a shipped_dark release whose flag is ON, then reconcile via the flag poll.
    const { fetchFn } = makeFakeServiceFetch();
    const backend = makeServiceBackend({ baseUrl: "https://svc", token: "t", fetchFn });
    let r = newRelease({ releaseId: "rel_a_web_2.0.0", app: "a", surface: "web", version: "2.0.0" });
    r = { ...r, flag: "launch.a.beta", launch_id: "lnch_a_beta" };
    for (const to of ["tagged", "built", "tested", "uploaded", "shipped_dark"] as const) r = appendTransition(r, to, "test", now);
    await backend.records.write(r);
    const flagClient = new FlagFileClient(stateDir, now);
    await flagClient.setState("launch.a.beta", true);

    const report = await reconcile({ backend, sources: [flagPollSource(flagClient)], now });
    expect(report.applied.some((a) => a.to === "live")).toBe(true);
    expect((await backend.records.read("rel_a_web_2.0.0"))!.state).toBe("live");
  });
});
```

- [ ] **Step 2: Run the parity test**

Run: `npx vitest run tests/service-parity.test.ts`
Expected: PASS (2 tests). If the first fails on `ids`/`list` ordering, the comparator is wrong (releases must use bare `.sort()`, proposals `localeCompare`); if it fails on `announced`, the ledger fake or adapter isn't unioning.

- [ ] **Step 3: Full verification (the design's "done when")**

Run: `npm run typecheck && npx vitest run`
Expected: typecheck clean; **all tests green** (258 prior + the new service tests). The git backend is untouched, so the prior suite is unchanged.

- [ ] **Step 4: Build + web (library export added → rebuild before web)**

Run: `npm run build && npm run -w web test`
Expected: build clean; web **30 passed** (web doesn't consume the service backend, but it imports `halyard` and must still resolve).

- [ ] **Step 5: Commit**

```bash
git add tests/service-parity.test.ts
git commit -m "test(service): git-vs-service backend parity slice"
```

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/service-backend
gh pr create --base main --title "feat(service): coordinator.backend service adapters (R3 Phase 1)" --body "Implements the service backend per docs/superpowers/specs/2026-06-10-service-backend-design.md: five HTTP adapters over ServiceHttpClient at git-parity, makeBackend service branch, coordinator.service config, preflight token check, git-vs-service parity slice. Concurrency control deferred (see design). Server is out of scope."
```

---

## Notes for the implementer

- **Invariant #4 (secrets):** the token is resolved at runtime via `tryResolveSecret` and passed to the client; never log it. The client tests assert it's sent as a bearer header and never appears in error messages — keep it that way in any new code.
- **Invariant #3 (dedup):** do NOT add dedup logic to the adapters. It lives in the pure `appendTransition`/`isCurrentState`, already exercised by the parity slice's reconcile test. The service adapters are last-writer-wins, like git.
- **Concurrency:** multi-writer safety is explicitly out of scope (see the design's deferred-work note). Do not add ETag/If-Match here.
- **`stateDir` for service:** `makeBackend` still receives `stateDir` (required by the type) and the service branch ignores it. Do not make `stateDir` optional — it would break ~10 call sites under strict TS (see the design's Critique Round 3).
