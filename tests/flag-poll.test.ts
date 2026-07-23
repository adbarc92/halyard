import { describe, expect, it } from "vitest";
import { flagPollSource } from "../src/halyard/coordinator/sources/flag-poll.js";
import { newRelease } from "../src/halyard/coordinator/record-store.js";
import type { Release } from "../src/halyard/contracts/release.schema.js";
import type { FlagClient, FlagState } from "../src/halyard/flags/types.js";

class StubFlag implements FlagClient {
  constructor(private readonly state: FlagState) {}
  async getState(): Promise<FlagState> {
    return this.state;
  }
  async ensureFlag(): Promise<void> {}
  async setState(): Promise<void> {}
}

function release(state: Release["state"], surface: Release["surface"] = "ios", flag: string | null = "launch.aurora.offline_sync"): Release {
  return { ...newRelease({ releaseId: "rel_aurora_ios_1.4.0", app: "aurora", surface, version: "1.4.0" }), state, flag };
}

const ctx = { now: () => "t", log: () => {} };

describe("M4: flag poll projects flag truth into the launch transition", () => {
  it("shipped_dark + flag ON → live (the launch moment)", async () => {
    const proposals = await flagPollSource(new StubFlag("on")).poll(release("shipped_dark"), ctx);
    expect(proposals).toEqual([{ to: "live", by: "flag-poll", externalRefs: { flag_state: "on" } }]);
  });

  it("shipped_dark + flag OFF → no movement (waits)", async () => {
    expect(await flagPollSource(new StubFlag("off")).poll(release("shipped_dark"), ctx)).toHaveLength(0);
  });

  it("live + flag OFF → rolled_back (the only mobile rollback)", async () => {
    const proposals = await flagPollSource(new StubFlag("off")).poll(release("live"), ctx);
    expect(proposals).toEqual([{ to: "rolled_back", by: "flag-poll", externalRefs: { flag_state: "off" } }]);
  });

  it("web rests at uploaded: uploaded + flag ON → live", async () => {
    const proposals = await flagPollSource(new StubFlag("on")).poll(release("uploaded", "web"), ctx);
    expect(proposals).toEqual([{ to: "live", by: "flag-poll", externalRefs: { flag_state: "on" } }]);
  });

  it("android (non-prod track) also rests at uploaded: uploaded + flag ON → live", async () => {
    const proposals = await flagPollSource(new StubFlag("on")).poll(release("uploaded", "android"), ctx);
    expect(proposals).toEqual([{ to: "live", by: "flag-poll", externalRefs: { flag_state: "on" } }]);
  });

  it("android PRODUCTION track does NOT rest at uploaded: it awaits the Play review poll", async () => {
    // A production-track release ships dark only after Play review (the mirror of iOS).
    // Flipping the flag ON early must NOT shortcut it straight to live, bypassing review.
    const prod: Release = {
      ...release("uploaded", "android"),
      external_refs: { play_track: "production" },
    };
    expect(await flagPollSource(new StubFlag("on")).poll(prod, ctx)).toHaveLength(0);
  });

  it("only applies to flagged releases at a rest/live state", () => {
    const src = flagPollSource(new StubFlag("on"));
    expect(src.appliesTo(release("shipped_dark"))).toBe(true);
    expect(src.appliesTo(release("live"))).toBe(true);
    expect(src.appliesTo(release("uploaded", "android"))).toBe(true); // no review on this track
    expect(
      src.appliesTo({ ...release("uploaded", "android"), external_refs: { play_track: "production" } }),
    ).toBe(false); // production track must go through the Play review poll first
    expect(src.appliesTo(release("tagged"))).toBe(false);
    expect(src.appliesTo(release("shipped_dark", "ios", null))).toBe(false); // unlinked, no flag
    expect(src.appliesTo(release("uploaded", "ios"))).toBe(false); // iOS must go through review
  });
});
