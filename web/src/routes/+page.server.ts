import type { PageServerLoad } from "./$types";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = () => {
  const svc = service();
  if (svc.health().status !== "ok") return { releases: [], errors: [] };
  return { releases: svc.listReleaseStatuses(), errors: svc.listQueue().errors };
};
