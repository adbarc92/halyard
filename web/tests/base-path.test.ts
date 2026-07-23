import { describe, expect, it, afterEach, vi } from "vitest";

/**
 * `kit.paths.base` is build-time: svelte.config.js reads HALYARD_BASE_PATH at config-load time.
 * These tests load the config module fresh under different env values and assert the normalized
 * base it hands SvelteKit (leading slash required, trailing slash stripped, "" for standalone).
 */
async function loadBase(): Promise<string> {
  vi.resetModules();
  const mod = await import("../svelte.config.js?" + Math.random()); // bypass module cache
  return (mod.default as any).kit.paths.base as string;
}

afterEach(() => {
  delete process.env.HALYARD_BASE_PATH;
});

describe("svelte.config.js paths.base from HALYARD_BASE_PATH", () => {
  it("defaults to '' (standalone / root) when unset", async () => {
    delete process.env.HALYARD_BASE_PATH;
    expect(await loadBase()).toBe("");
  });

  it("'/halyard' is used as-is", async () => {
    process.env.HALYARD_BASE_PATH = "/halyard";
    expect(await loadBase()).toBe("/halyard");
  });

  it("'halyard' (no leading slash) is normalized to '/halyard'", async () => {
    process.env.HALYARD_BASE_PATH = "halyard";
    expect(await loadBase()).toBe("/halyard");
  });

  it("a trailing slash is stripped (SvelteKit's rule)", async () => {
    process.env.HALYARD_BASE_PATH = "/halyard/";
    expect(await loadBase()).toBe("/halyard");
  });

  it("empty string stays '' (root)", async () => {
    process.env.HALYARD_BASE_PATH = "";
    expect(await loadBase()).toBe("");
  });
});
