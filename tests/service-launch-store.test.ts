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
