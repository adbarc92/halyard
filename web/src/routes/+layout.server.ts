import type { LayoutServerLoad } from "./$types";
import { service } from "$lib/server/service.js";
import { authEnabled } from "$lib/server/auth.js";

export const load: LayoutServerLoad = ({ locals }) => {
  // Unauthenticated requests only reach here for /login, /logout, and assets (the hook redirects
  // unauthenticated pages). Touch no backend and ship no project state to a pre-auth visitor.
  if (!locals.authed) {
    return { authEnabled: authEnabled(), health: { status: "ok" as const, root: "", error: undefined } };
  }
  const h = service().health();
  // Only the nav + degraded banner are rendered from this; never ship stateDir/apps.
  return {
    authEnabled: authEnabled(),
    health: { status: h.status, root: h.root, error: h.error ?? h.backendWarning },
  };
};
