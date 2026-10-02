import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";
import { fileURLToPath } from "node:url";

export default defineConfig({
  plugins: [sveltekit()],
  // halyard is a Node-only ESM lib (node:fs, node:crypto, @anthropic-ai/sdk).
  // Keep it external to the SSR bundle; never pre-bundle it for the browser.
  ssr: { external: ["halyard", "@anthropic-ai/sdk"] },
  optimizeDeps: { exclude: ["halyard"] },
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Keep the operator's licensing env out of the suite (see the root vitest.config.ts).
    env: { HALYARD_SELF_HOST: "", HALYARD_LICENSE_KEY: "" },
    alias: { "$app/paths": fileURLToPath(new URL("./tests/mocks/app-paths.ts", import.meta.url)) },
  },
});
