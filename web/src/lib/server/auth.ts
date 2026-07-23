// web/src/lib/server/auth.ts
import crypto from "node:crypto";
export { isLoopbackAddress, looksProxied, bindGuard } from "./loopback.js";

export const SESSION_COOKIE = "hal_session";

/** Operator token, read once at module load. null => no-token mode. */
export const consoleToken: string | null = process.env.HALYARD_CONSOLE_TOKEN || null;
export function authEnabled(): boolean {
  return consoleToken !== null;
}

export function timingSafeEqualStr(a: string, b: string): boolean {
  // Compare fixed-length SHA-256 digests so neither equality nor input length leaks via timing.
  const ha = crypto.createHash("sha256").update(a, "utf8").digest();
  const hb = crypto.createHash("sha256").update(b, "utf8").digest();
  return crypto.timingSafeEqual(ha, hb);
}

export function parseBearer(header: string | null): string | null {
  if (!header) return null;
  const m = /^bearer\s+(.+)$/i.exec(header.trim());
  return m ? m[1].trim() : null;
}

export function secureCookieFlag(opts: {
  forwardedProto?: string | null;
  urlProtocol?: string;
  originSet?: boolean;
}): boolean {
  if ((opts.forwardedProto ?? "").toLowerCase() === "https") return true;
  if (opts.originSet && opts.urlProtocol === "https:") return true;
  return false;
}

/** Safe same-origin path or "/". Rejects //, /\, absolute URLs, CRLF; strips any data suffix. */
export function sanitizeNext(next: string | null | undefined): string {
  if (!next) return "/";
  const n = next.replace(/\/__data\.json$/, "");
  if (!/^\/[^/\\]/.test(n)) return "/";
  try {
    const u = new URL(n, "http://x");
    if (u.origin !== "http://x") return "/";
    return u.pathname + u.search;
  } catch {
    return "/";
  }
}

const TTL_MS = 12 * 60 * 60 * 1000;
interface Session { expiresAt: number; }
const sessions = new Map<string, Session>();

export function createSession(now: number = Date.now()): string {
  const id = crypto.randomBytes(32).toString("hex");
  sessions.set(id, { expiresAt: now + TTL_MS });
  return id;
}
export function isValidSession(id: string | undefined, now: number = Date.now()): boolean {
  if (!id) return false;
  const s = sessions.get(id);
  if (!s) return false;
  if (s.expiresAt <= now) { sessions.delete(id); return false; }
  return true;
}
export function destroySession(id: string | undefined): void {
  if (id) sessions.delete(id);
}
export function sessionCookieOptions(secure: boolean) {
  return { path: "/", httpOnly: true, sameSite: "lax" as const, maxAge: TTL_MS / 1000, secure };
}
