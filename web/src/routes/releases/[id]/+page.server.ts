import type { PageServerLoad } from "./$types";
import { error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export const load: PageServerLoad = ({ params }) => {
  const release = service().getRelease(params.id);
  if (!release) throw error(404, `no such release: ${params.id}`);
  return { release };
};
