import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = ({ params }) => {
  const launch = service().getLaunch(params.id);
  if (!launch) throw error(404, `no such launch: ${params.id}`);
  return { launch };
};
