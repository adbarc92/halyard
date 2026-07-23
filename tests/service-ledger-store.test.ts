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
