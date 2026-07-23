import type { PageServerLoad } from "./$types";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = () => {
  const svc = service();
  return { releases: svc.health().status === "ok" ? svc.listReleaseStatuses() : [] };
};
