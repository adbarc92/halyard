// tests/naming.test.ts
import { describe, expect, it } from "vitest";
import { flagKeyFor, autoPromoteFlagKey, AUTO_PROMOTE_PREFIX } from "../src/halyard/flags/naming.js";

describe("flag naming", () => {
  it("flagKeyFor expands the pattern", () => {
    expect(flagKeyFor("launch.{slug}.{feature}", "acme", "beta")).toBe("launch.acme.beta");
  });

  it("autoPromoteFlagKey uses the reserved namespace + a sanitized version", () => {
    expect(autoPromoteFlagKey("acme", "1.4.0")).toBe("halyard.autopromote.acme.1.4.0");
    expect(AUTO_PROMOTE_PREFIX).toBe("halyard.autopromote.");
    expect(autoPromoteFlagKey("acme", "1.4.0").startsWith(AUTO_PROMOTE_PREFIX)).toBe(true);
  });

  it("autoPromoteFlagKey slugifies an unsafe (non-semver) version to one safe segment", () => {
    expect(autoPromoteFlagKey("acme", "2024/06/release one")).toBe("halyard.autopromote.acme.2024-06-release-one");
  });
});
