import type { PageServerLoad } from "./$types";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = async () => {
  const svc = service();
  if (svc.health().status !== "ok") return { flags: [] };
  return { flags: await svc.listFlags() };
};
