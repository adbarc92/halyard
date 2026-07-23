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
