/**
 * Tiny flag parser for the CLI, extracted so it's unit-testable (cli.ts self-executes
 * `main()` on import). Supports `--key value` pairs and bare `--flag` booleans ("true").
 * A value that itself begins with `--` is treated as the next flag, so the preceding flag
 * becomes a boolean.
 */
export function parseFlags(argv: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (tok && tok.startsWith("--")) {
      const key = tok.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = "true";
      }
    }
  }
  return flags;
}

export function requireFlag(flags: Record<string, string>, name: string): string {
  const v = flags[name];
  if (!v) {
    throw new Error(`missing required --${name}`);
  }
  return v;
}
