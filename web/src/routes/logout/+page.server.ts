// web/src/routes/logout/+page.server.ts
import { redirect } from "@sveltejs/kit";
import { base } from "$app/paths";
import { destroySession, SESSION_COOKIE } from "$lib/server/auth.js";

export const actions = {
  default: async ({ cookies }: any) => {
    destroySession(cookies.get(SESSION_COOKIE));
    cookies.delete(SESSION_COOKIE, { path: "/" });
    throw redirect(303, `${base}/login`);
  },
};
