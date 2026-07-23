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
