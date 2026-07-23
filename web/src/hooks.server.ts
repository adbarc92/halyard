// web/src/hooks.server.ts
import { type Handle, json, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import {
  consoleToken, isValidSession, parseBearer, timingSafeEqualStr,
  isLoopbackAddress, SESSION_COOKIE, sanitizeNext,
} from "$lib/server/auth.js";
import { clientKey, checkLocked, recordFailure, recordSuccess } from "$lib/server/ratelimit.js";
import { systemClock } from "$lib/server/clock.js";

export const handle: Handle = async ({ event, resolve }) => {
  event.locals.authed = false;
  const routeId = event.route.id;
  const isPage = routeId !== null;
  const isApi = routeId?.startsWith("/api") ?? false;
  const isData = event.isDataRequest === true;

  if (!consoleToken) {
    // No-token mode: loopback-only, and never trust a peer when a proxy is in front.
    const forwarded = [...event.request.headers.keys()].some((k) => k.startsWith("x-forwarded-"));
    let addr = "";
    try { addr = event.getClientAddress(); } catch { addr = ""; }
    if (!forwarded && isLoopbackAddress(addr)) {
      event.locals.authed = true;
      return resolve(event);
    }
    return json({ message: "authentication required" }, { status: 403 });
  }

  // Token set. A Bearer header is a token *guess*, so it gets the same brute-force throttle
  // as the /login form — otherwise an attacker could spray guesses at any endpoint and
  // bypass the form's rate limit entirely. A session cookie carries no guessable secret
  // (256-bit random id), so it is never throttled. Fail open when the address is unknown.
  const bearer = parseBearer(event.request.headers.get("authorization"));
  if (bearer !== null) {
    const key = clientKey(() => event.getClientAddress());
    const now = new Date(systemClock()).getTime();
    if (key && checkLocked(key, now).locked) {
      return json({ message: "too many attempts" }, { status: 429 });
    }
    if (timingSafeEqualStr(bearer, consoleToken)) {
      if (key) recordSuccess(key);
      event.locals.authed = true;
      return resolve(event);
    }
    if (key) recordFailure(key, now);
  } else if (isValidSession(event.cookies.get(SESSION_COOKIE))) {
    event.locals.authed = true;
    return resolve(event);
  }

  // Token set, unauthenticated.
  const rid = routeId as string | null;
  if (rid === "/login" || rid === "/logout" || !isPage) return resolve(event);
  if (isApi || isData) return json({ message: "authentication required" }, { status: 401 });
  throw redirect(302, `${base}/login?next=${encodeURIComponent(sanitizeNext(event.url.pathname))}`);
};
