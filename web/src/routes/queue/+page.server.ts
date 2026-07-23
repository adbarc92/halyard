import type { PageServerLoad } from "./$types";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = ({ url }) => {
  const svc = service();
  if (svc.health().status !== "ok") return { open: [], all: false };
  const all = url.searchParams.get("all") === "1";
  return { open: svc.listQueue({ all }).open, all };
};
