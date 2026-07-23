import { describe, expect, it, afterEach, vi } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { FlagFileClient, HttpFlagClient, setSecretStore, envSecretStore } from "halyard";
import { loadProject, chooseFlagClient } from "../src/lib/server/project.js";
import { createConsoleService } from "../src/lib/server/console-service.js";
import { seedProject, seedProjectWithFlagApi } from "./helpers/seed.js";

function fixedClock() {
  return () => "2026-06-08T00:00:00.000Z";
}

afterEach(() => {
  delete process.env.HALYARD_LIVE_FLAGS;
  setSecretStore(envSecretStore); // restore the default (process.env) store
  vi.unstubAllGlobals();
});

describe("flag-client selection (mirrors the CLI / reconcile choice)", () => {
  it("uses FlagFileClient when no app declares flags.api_url (offline default)", () => {
    process.env.HALYARD_LIVE_FLAGS = "1"; // even with live flags ON, no api_url → file client
    const { root } = seedProject(); // demo app has no api_url
    const p = loadProject(root, fixedClock());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.flagClient).toBeInstanceOf(FlagFileClient);
  });

  it("uses FlagFileClient when api_url is set but HALYARD_LIVE_FLAGS is unset", () => {
    delete process.env.HALYARD_LIVE_FLAGS;
    const { root, tokenSecretName } = seedProjectWithFlagApi("https://flags.example.com");
    setSecretStore({ get: (n) => (n === tokenSecretName ? "tok_secret" : undefined) });
    const p = loadProject(root, fixedClock());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.flagClient).toBeInstanceOf(FlagFileClient);
  });

  it("uses FlagFileClient when api_url is set but the token does not resolve (degrades gracefully)", () => {
    process.env.HALYARD_LIVE_FLAGS = "1";
    const { root } = seedProjectWithFlagApi("https://flags.example.com");
    setSecretStore({ get: () => undefined }); // token absent → fall through to file client
    const p = loadProject(root, fixedClock());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.flagClient).toBeInstanceOf(FlagFileClient);
  });

  it("uses HttpFlagClient when live flags on + api_url declared + token resolves", () => {
    process.env.HALYARD_LIVE_FLAGS = "1";
    const { root, tokenSecretName } = seedProjectWithFlagApi("https://flags.example.com");
    setSecretStore({ get: (n) => (n === tokenSecretName ? "tok_secret" : undefined) });
    const p = loadProject(root, fixedClock());
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.flagClient).toBeInstanceOf(HttpFlagClient);
  });

  it("chooseFlagClient: live + api_url + token returns an Http client", () => {
    process.env.HALYARD_LIVE_FLAGS = "1";
    setSecretStore({ get: () => "tok" });
    const app = {
      flags: { api_url: "https://flags.example.com", api_key_ref: "SECRET:X" },
    } as any;
    expect(chooseFlagClient([app], "/tmp/state", fixedClock())).toBeInstanceOf(HttpFlagClient);
  });
});

describe("console flip/list route through the selected provider", () => {
  it("with api_url configured, flip + listFlags hit the HTTP provider (proven via injected fetch), not the state file", async () => {
    process.env.HALYARD_LIVE_FLAGS = "1";
    const { root, stateDir, tokenSecretName } = seedProjectWithFlagApi("https://flags.example.com");
    setSecretStore({ get: (n) => (n === tokenSecretName ? "tok_secret" : undefined) });

    // Seed a release referencing a flag so listFlags has a key to look up.
    const { newRelease, writeRelease } = await import("halyard");
    writeRelease(stateDir, {
      ...newRelease({ releaseId: "rel_demo_web_1.0.0", app: "demo", surface: "web", version: "1.0.0" }),
      flag: "launch.demo.beta",
    });

    // Stub the global fetch the HttpFlagClient uses by default. Record calls; never assert on creds.
    const calls: { url: string; method: string; hasAuth: boolean }[] = [];
    const store: Record<string, boolean> = {};
    vi.stubGlobal("fetch", async (url: any, init: any = {}) => {
      const u = String(url);
      const method = (init.method ?? "GET").toUpperCase();
      const headers = (init.headers ?? {}) as Record<string, string>;
      calls.push({ url: u, method, hasAuth: typeof headers.authorization === "string" });
      const key = decodeURIComponent(u.split("/flags/")[1] ?? "");
      if (method === "PUT") {
        store[key] = JSON.parse(init.body).on;
        return new Response(null, { status: 204 });
      }
      if (!(key in store)) return new Response(null, { status: 404 }); // absent
      return new Response(JSON.stringify({ on: store[key] }), { status: 200 });
    });

    const svc = createConsoleService({ root, now: fixedClock() });
    await svc.flip("launch.demo.beta", true);
    const flags = await svc.listFlags();

    expect(flags).toEqual([{ key: "launch.demo.beta", state: "on" }]);
    // The flip went over HTTP (a PUT to the provider), not to the local state file.
    expect(calls.some((c) => c.method === "PUT" && c.url.includes("/flags/launch.demo.beta"))).toBe(true);
    expect(calls.every((c) => c.hasAuth)).toBe(true); // creds present on every request
    expect(existsSync(join(stateDir, "flags", "launch.demo.beta.json"))).toBe(false); // not the file client
  });
});
