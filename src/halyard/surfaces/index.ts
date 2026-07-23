import type { Surface } from "../config/primitives.js";
import type { SurfaceAdapter } from "./types.js";
import { WebSurfaceAdapter } from "./web.js";
import { IosSurfaceAdapter } from "./ios.js";
import { AndroidSurfaceAdapter } from "./android.js";
import { DesktopSurfaceAdapter } from "./desktop.js";

export * from "./types.js";
export { ShellCommandRunner } from "./command-runner.js";
export { WebSurfaceAdapter } from "./web.js";
export { IosSurfaceAdapter } from "./ios.js";
export { AndroidSurfaceAdapter } from "./android.js";
export { DesktopSurfaceAdapter } from "./desktop.js";

// The pluggable provider/toolchain/signing seam (a target/toolchain = its own module).
export type { DeployProvider } from "./deploy/provider.js";
export { getDeployProvider, validateDeployConfig, deployTargets } from "./deploy/registry.js";
export type { MobileToolchain } from "./mobile/toolchain.js";
export { getMobileToolchain, mobileToolchains } from "./mobile/registry.js";
export type { SigningStep } from "./signing/index.js";
export { getSigningStep } from "./signing/index.js";

/**
 * Resolve the adapter for a surface. Web, iOS, Android, and desktop are implemented behind
 * the same interface so the coordinator stays surface-agnostic.
 */
export function getAdapter(surface: Surface): SurfaceAdapter {
  switch (surface) {
    case "web":
      return new WebSurfaceAdapter();
    case "ios":
      return new IosSurfaceAdapter();
    case "android":
      return new AndroidSurfaceAdapter();
    case "desktop":
      return new DesktopSurfaceAdapter();
    default: {
      const _exhaustive: never = surface;
      throw new Error(`unknown surface: ${String(_exhaustive)}`);
    }
  }
}
