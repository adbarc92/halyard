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
