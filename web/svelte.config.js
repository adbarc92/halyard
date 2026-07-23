import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

/**
 * Sub-path embedding. SvelteKit's `paths.base` is BUILD-TIME: it is baked into the bundle, so
 * mounting the console under a URL sub-path (e.g. `/halyard/*`, to embed in a larger dashboard)
 * requires rebuilding with HALYARD_BASE_PATH set. Defaults to root ("") so the standalone case
 * is unchanged. A leading slash is required and a trailing slash is stripped (SvelteKit's rule).
 */
const rawBase = process.env.HALYARD_BASE_PATH ?? "";
const base = rawBase === "" ? "" : "/" + rawBase.replace(/^\/+/, "").replace(/\/+$/, "");

/** @type {import('@sveltejs/kit').Config} */
const config = {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(), // outputs ./build, server reads HOST/PORT env
    paths: { base },
  },
};
export default config;
