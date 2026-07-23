import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
    environment: "node",
    // The library barrel pulls a heavy ESM dep (@anthropic-ai/sdk); under the default thread
    // pool, many files importing it concurrently starved the 5s default timeout (and could crash
    // a worker outright). Forks isolate memory per process and a generous timeout absorbs the
    // first-import cost, so `npm test` is a deterministic green — the gate the handoff relies on.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    pool: "forks",
    // Coverage gate (enforced in CI via `npm run test:coverage`). Thresholds sit just below
    // current coverage to prevent regression without noise; raise them as coverage grows.
    // Barrels (index.ts) are pure re-exports, excluded from the denominator.
    coverage: {
      provider: "v8",
      include: ["src/halyard/**/*.ts"],
      exclude: ["src/halyard/**/index.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        lines: 85,
        statements: 85,
        branches: 80,
        functions: 87,
      },
    },
  },
});
