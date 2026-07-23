// web/src/lib/server/loopback.js
// Dependency-free plain ESM. Shared by hooks.server.ts, auth.ts, web/server.js, and tests —
// one canonical source for the loopback / proxy-posture / bind-guard logic.

/**
 * Loopback if 127.0.0.0/8, ::1, localhost, or IPv4-mapped IPv6 (::ffff:127.x).
 * @param {string | null | undefined} addr
 * @returns {boolean}
 */
export function isLoopbackAddress(addr) {
  if (!addr) return false;
  let a = String(addr).trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "localhost" || a === "::1") return true;
  if (a.startsWith("::ffff:")) a = a.slice("::ffff:".length);
  return a === "127.0.0.1" || a.startsWith("127.");
}

// adapter-node's forwarded-header config vars. ORIGIN is intentionally excluded: it fixes
// URL/CSRF generation and is set even for a bare loopback server (see the design's F19).
const PROXY_ENV_VARS = ["ADDRESS_HEADER", "XFF_DEPTH", "PROTOCOL_HEADER", "HOST_HEADER", "PORT_HEADER"];

/**
 * True if any forwarded-header proxy-posture env var is set.
 * @param {Record<string, string | undefined>} env
 * @returns {boolean}
 */
export function looksProxied(env) {
  return PROXY_ENV_VARS.some((k) => env[k] != null && env[k] !== "");
}

/**
 * "refuse" iff no token AND (host non-loopback OR proxy posture); else "ok".
 * @param {{ token?: string | null | undefined, host?: string | null | undefined, env?: Record<string, string | undefined> }} opts
 * @returns {"ok" | "refuse"}
 */
export function bindGuard(opts) {
  const { token, host, env } = opts;
  if (token) return "ok";
  if (!isLoopbackAddress(host) || looksProxied(env ?? {})) return "refuse";
  return "ok";
}
