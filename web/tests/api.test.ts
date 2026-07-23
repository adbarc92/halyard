import { describe, expect, it } from "vitest";
import type { Release } from "halyard";
import { seedProject, addDemoApp } from "./helpers/seed.js";

async function call(handler: any, init?: { body?: unknown }) {
  const request = new Request("http://localhost/x", {
    method: init?.body ? "POST" : "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body ? { body: JSON.stringify(init.body) } : {}),
  });
  return handler({ request });
}

describe("GET /health", () => {
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

describe("POST /api actions", () => {
  it("flip then reconcile projects a release to live", async () => {
    const { root, stateDir } = seedProject();
    const { writeRelease, newRelease, appendTransition } = await import("halyard");
    const now = () => "2026-06-08T00:00:00.000Z";
    let r: Release = { ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }), flag: "launch.demo.beta" };
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

  it("approve returns 404 (not 500) for a missing proposal", async () => {
    const { root } = seedProject();
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const approve = (await import("../src/routes/api/approve/+server.js")).POST;
    // SvelteKit's error() throws; the handler surfaces it as an HttpError with .status.
    await expect(call(approve, { body: { proposalId: "nope" } })).rejects.toMatchObject({ status: 404 });
  });
});

describe("POST /api/reconcile-full", () => {
  it("runs the full cycle and returns the report shape the board renders", async () => {
    const { root, stateDir } = seedProject();
    const { writeRelease, newRelease, appendTransition, FlagFileClient } = await import("halyard");
    const now = () => "2026-06-08T00:00:00.000Z";
    let r: Release = { ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }), flag: "launch.demo.beta" };
    r = appendTransition(r, "built", "t", now);
    r = appendTransition(r, "tested", "t", now);
    r = appendTransition(r, "uploaded", "t", now);
    writeRelease(stateDir, r);
    await new FlagFileClient(stateDir, now).setState("launch.demo.beta", true);

    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const reconcileFull = (await import("../src/routes/api/reconcile-full/+server.js")).POST;

    const res = await call(reconcileFull, { body: {} });
    expect(res.status).toBe(200);
    const { ok, report } = await res.json();
    expect(ok).toBe(true);
    // The board destructures exactly these fields — guard their presence/types.
    expect(report.reconcile.applied.some((a: { to: string }) => a.to === "live")).toBe(true);
    expect(report.reconcile.errors).toBeInstanceOf(Array);
    for (const k of ["graduationProposals", "publicityFanouts", "triageProposals", "rejectionProposals"]) {
      expect(typeof report[k]).toBe("number");
    }
  });

  it("maps the multi-app Pro gate to 403 (not 500)", async () => {
    const { root } = seedProject();
    addDemoApp(root, "demo2"); // >1 app on the free tier trips enforceMultiApp
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const reconcileFull = (await import("../src/routes/api/reconcile-full/+server.js")).POST;
    await expect(call(reconcileFull, { body: {} })).rejects.toMatchObject({ status: 403 });
  });
});

describe("POST /api/reconcile", () => {
  it("maps the multi-app Pro gate to 403 (not 500)", async () => {
    const { root } = seedProject();
    addDemoApp(root, "demo2");
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const reconcileEp = (await import("../src/routes/api/reconcile/+server.js")).POST;
    await expect(call(reconcileEp, { body: {} })).rejects.toMatchObject({ status: 403 });
  });
});

describe("GET / layout payload", () => {
  it("does not ship internal stateDir / apps to the client", async () => {
    const { root } = seedProject();
    process.env.HALYARD_CONFIG_ROOT = root;
    const { vi } = await import("vitest");
    vi.resetModules();
    const { load } = await import("../src/routes/+layout.server.js");
    // Simulate an unauthenticated request: locals is present but authed is falsy.
    // root is gated behind locals.authed to avoid leaking the project path on /login.
    const data = (await (load as any)({ locals: {} })) as { health: Record<string, unknown> };
    expect(data.health.status).toBe("ok");
    expect(data.health.root).toBe(""); // gated: real path only when locals.authed
    expect(data.health).not.toHaveProperty("stateDir");
    expect(data.health).not.toHaveProperty("apps");
  });
});
