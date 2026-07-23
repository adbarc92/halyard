import { describe, expect, it, afterEach } from "vitest";
import { loadProject } from "../src/lib/server/project.js";
import { createConsoleService } from "../src/lib/server/console-service.js";
import { writeRelease, newRelease, writeLaunch, newLaunch, writeProposal, appendTransition, resetEntitlement, FlagFileClient } from "halyard";
import { seedProject, seedEmptyRoot, addDemoApp } from "./helpers/seed.js";

function fixedClock() {
  return () => "2026-06-08T00:00:00.000Z";
}

describe("loadProject", () => {
  it("loads a valid project: org, apps, stateDir, canonDir, flagClient", () => {
    const { root, stateDir } = seedProject();
    const p = loadProject(root);
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.org.org.name).toBe("Example");
    expect(p.apps.map((a) => a.app.slug)).toEqual(["demo"]);
    expect(p.stateDir).toBe(stateDir);
    expect(p.canonDir).toMatch(/canon[/\\]voice/);
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

function proposal(id: string, status: string, kind = "social_post") {
  return {
    proposal_id: id, kind, app: "demo", title: "t", body: "b",
    status, created_at: "2026-06-08T00:00:00.000Z",
    ...(kind === "social_post" ? { channel: "x" } : {}),
  } as any;
}

describe("console service approve", () => {
  it("approves a proposal and reports it", async () => {
    const { root, stateDir } = seedProject();
    writeProposal(stateDir, proposal("p1", "open"));
    const svc = createConsoleService({ root, now: fixedClock() });
    const res = await svc.approve("p1");
    expect(res.proposal.status).toBe("approved");
  });

  it("throws for a missing proposal", async () => {
    const { root } = seedProject();
    const svc = createConsoleService({ root, now: fixedClock() });
    await expect(svc.approve("nope")).rejects.toThrow();
  });
});

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

describe("console service reconcileNow", () => {
  afterEach(() => resetEntitlement());

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
    addDemoApp(root, "demo2"); // second app dir → appCount > 1 → free entitlement trips the gate
    const svc = createConsoleService({ root, now: () => "2026-06-08T00:00:00.000Z" });
    await expect(svc.reconcileNow()).rejects.toThrow(/Pro/i);
  });
});

describe("console service reconcileFull", () => {
  it("runs the full cycle and returns a report (flag-on release projects to live)", async () => {
    const { root, stateDir } = seedProject();
    // Seed a web release resting at `uploaded` with a flag, mirroring the reconcileNow seed above.
    let r = newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" });
    const now = () => "2026-06-08T00:00:00.000Z";
    r = { ...r, flag: "launch.demo.beta" };
    r = appendTransition(r, "built", "test", now);
    r = appendTransition(r, "tested", "test", now);
    r = appendTransition(r, "uploaded", "test", now);
    writeRelease(stateDir, r);
    await new FlagFileClient(stateDir, now).setState("launch.demo.beta", true);

    const svc = createConsoleService({ root, now });
    const report = await svc.reconcileFull();

    expect(report.reconcile.applied.some((a: { to: string }) => a.to === "live")).toBe(true);
    expect(typeof report.triageProposals).toBe("number");
  });
});
