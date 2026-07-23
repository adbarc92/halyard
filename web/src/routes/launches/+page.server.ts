import type { PageServerLoad } from "./$types";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = () => {
  const svc = service();
  return { launches: svc.health().status === "ok" ? svc.listLaunches() : [] };
};
