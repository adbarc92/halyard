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
    // The operator's own licensing env must not leak into the suite: with HALYARD_SELF_HOST=1 in
    // the shell, the "free tier by default" and multi-app Pro-gate tests read Pro and fail.
    // Blank means unset to the entitlement loader; tests that need either set it explicitly.
    env: { HALYARD_SELF_HOST: "", HALYARD_LICENSE_KEY: "" },
    // Coverage gate (enforced in CI via `npm run test:coverage`). Thresholds sit just below
    // current coverage to prevent regression without noise; raise them as coverage grows.
    // Barrels (index.ts) are pure re-exports, excluded from the denominator.
    // Vitest 4+ maps v8 coverage through the AST, which counts statements and branches
    // differently from 2.x (same tests and code: statements 89.1% -> 84.4%, branches
    // 88.4% -> 75.0%), so those two thresholds were reset just below the new figures.
    coverage: {
      provider: "v8",
      include: ["src/halyard/**/*.ts"],
      exclude: ["src/halyard/**/index.ts"],
      reporter: ["text-summary", "json-summary"],
      thresholds: {
        lines: 85,
        statements: 84,
        branches: 74,
        functions: 87,
      },
    },
  },
});
