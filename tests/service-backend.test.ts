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
