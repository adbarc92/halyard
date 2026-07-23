import { z } from "zod";

/**
 * Invariant #4: Config holds secret *references* (`SECRET:NAME`), never values.
 *
 * A `SecretRef` is a branded string that can only ever hold the *name* of a secret,
 * never the secret itself. Any config field that is meant to carry a credential is
 * typed as `SecretRef`, so a raw value is rejected at load/validation time — it
 * cannot be represented. Resolution to an actual value happens at runtime against a
 * secret store (GitHub Actions secrets, 1Password, env), never on disk.
 *
 * The literal prefix is the contract. `SECRET:ANTHROPIC_API_KEY` is a reference;
 * `sk-ant-...` is a value and must be impossible to store here.
 */

export const SECRET_PREFIX = "SECRET:" as const;

/** `SECRET:` followed by an UPPER_SNAKE_CASE name (letters, digits, underscores). */
const SECRET_REF_PATTERN = /^SECRET:[A-Z][A-Z0-9_]*$/;

/**
 * Heuristics that catch the most common ways a real credential leaks into a
 * `SecretRef` field. These are not a security boundary on their own — the prefix
 * requirement is — but they turn an obvious mistake (pasting a key) into a loud,
 * named validation error instead of a silently-accepted ref-shaped string.
 */
const VALUE_SHAPED_PATTERNS: ReadonlyArray<{ pattern: RegExp; hint: string }> = [
  { pattern: /^sk-/i, hint: "looks like an API key" },
  { pattern: /^ghp_|^github_pat_/i, hint: "looks like a GitHub token" },
  { pattern: /^-----BEGIN/, hint: "looks like a PEM/private key" },
  { pattern: /^https?:\/\//i, hint: "looks like a URL — store the URL behind a secret ref" },
  { pattern: /^[A-Za-z0-9+/]{40,}={0,2}$/, hint: "looks like a base64-encoded blob" },
];

export type SecretRef = string & { readonly __brand: "SecretRef" };

export const SecretRefSchema = z
  .string()
  .superRefine((val, ctx) => {
    if (SECRET_REF_PATTERN.test(val)) return;

    if (!val.startsWith(SECRET_PREFIX)) {
      const leaked = VALUE_SHAPED_PATTERNS.find((p) => p.pattern.test(val));
      const because = leaked
        ? ` This value ${leaked.hint}; secrets must never be written to config.`
        : "";
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `must be a secret reference of the form "SECRET:NAME", not a literal value.${because}`,
      });
      return;
    }

    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: `is a malformed secret reference; expected "SECRET:NAME" with an UPPER_SNAKE_CASE name.`,
    });
  })
  .transform((val) => val as SecretRef);

/** Extract the bare secret name from a reference (without resolving it). */
export function secretName(ref: SecretRef): string {
  return ref.slice(SECRET_PREFIX.length);
}

export function isSecretRef(val: unknown): val is SecretRef {
  return typeof val === "string" && SECRET_REF_PATTERN.test(val);
}
