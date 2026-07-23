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
