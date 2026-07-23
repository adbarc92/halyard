// web/src/routes/login/+page.server.ts
import { fail, redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import {
  consoleToken, timingSafeEqualStr, createSession, isValidSession,
  SESSION_COOKIE, sanitizeNext, secureCookieFlag, sessionCookieOptions,
} from "$lib/server/auth.js";
import { recordFailure, recordSuccess, checkLocked, clientKey } from "$lib/server/ratelimit.js";
import { systemClock } from "$lib/server/clock.js";

export const load = ({ cookies }: { cookies: { get(n: string): string | undefined } }) => {
  if (consoleToken && isValidSession(cookies.get(SESSION_COOKIE))) throw redirect(302, `${base}/`);
  return {};
};

export const actions = {
  default: async ({ request, cookies, url, getClientAddress }: any) => {
    const form = await request.formData();
    const token = String(form.get("token") ?? "");
    const next = sanitizeNext(String(form.get("next") ?? "/"));

    // Throttle brute force per client address; epoch ms from the injectable clock. Fail open
    // when the address is unknown rather than throttle a shared bucket that would let one
    // client lock everyone out (clientKey returns null → skip the limiter for this request).
    const now = new Date(systemClock()).getTime();
    const key = clientKey(getClientAddress);

    if (key) {
      const lock = checkLocked(key, now);
      if (lock.locked) {
        return fail(429, {
          error: `Too many attempts. Try again in ${Math.ceil((lock.retryAfterMs ?? 0) / 1000)}s.`,
        });
      }
    }

    if (!consoleToken || !timingSafeEqualStr(token, consoleToken)) {
      if (key) recordFailure(key, now);
      return fail(401, { error: "Invalid token" });
    }
    if (key) recordSuccess(key);
    const id = createSession();
    const secure = secureCookieFlag({
      forwardedProto: request.headers.get("x-forwarded-proto"),
      urlProtocol: url.protocol,
      originSet: process.env.ORIGIN != null,
    });
    cookies.set(SESSION_COOKIE, id, sessionCookieOptions(secure));
    throw redirect(303, next === "/" ? `${base}/` : next);
  },
};
