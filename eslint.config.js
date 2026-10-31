import js from "@eslint/js";
import prettier from "eslint-config-prettier";
import { defineConfig } from "eslint/config";
import globals from "globals";
import tseslint from "typescript-eslint";

export default defineConfig(
  {
    // Build output and local-only directories (see .gitignore and web/.gitignore).
    ignores: [
      "dist/",
      "coverage/",
      "apps.private/",
      ".context-curator/",
      "web/.svelte-kit/",
      "web/build/",
    ],
  },
  js.configs.recommended,
  // Includes @typescript-eslint/ban-ts-comment, so `// @ts-nocheck` and bare `// @ts-ignore`
  // cannot quietly switch the type checker off for a file.
  tseslint.configs.recommended,
  {
    languageOptions: {
      globals: { ...globals.node },
    },
    rules: {
      // The codebase's convention: a leading underscore marks a deliberately unused name
      // (port methods a fake does not need, a destructured value that is skipped).
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_", caughtErrorsIgnorePattern: "^_" },
      ],
      // `any` is used on purpose at loose boundaries: test doubles and SvelteKit action params.
      "@typescript-eslint/no-explicit-any": "off",
      // Doc comments put a zero-width space inside `*/N` so the comment does not close early.
      "no-irregular-whitespace": ["error", { skipComments: true }],
      // Literal runs of spaces in a regex match YAML indentation and read as such.
      "no-regex-spaces": "off",
    },
  },
  // Formatting is Prettier's job; turn off the stylistic rules that would fight it.
  prettier,
);
