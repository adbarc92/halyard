import type { MobileToolchain } from "./toolchain.js";
import { matchToolchain } from "./match.js";
import { easToolchain } from "./eas.js";

/**
 * Mobile-toolchain registry — maps a `surfaces.<ios|android>.toolchain` name to its
 * toolchain. `match` (fastlane, the pre-registry path) is the default; `eas` ships as a
 * stub until Lane L7 fills it. Adding a toolchain means adding a module here, never editing
 * another toolchain.
 */
const REGISTRY: ReadonlyMap<string, MobileToolchain> = new Map(
  [matchToolchain, easToolchain].map((t) => [t.name, t] as const),
);

/** All registered toolchain names (for diagnostics). */
export function mobileToolchains(): string[] {
  return [...REGISTRY.keys()];
}

/** Resolve a toolchain by name, or throw a message naming the known toolchains. */
export function getMobileToolchain(name: string): MobileToolchain {
  const toolchain = REGISTRY.get(name);
  if (!toolchain) {
    throw new Error(
      `unknown mobile toolchain "${name}" — known toolchains: ${mobileToolchains().join(", ")}`,
    );
  }
  return toolchain;
}
