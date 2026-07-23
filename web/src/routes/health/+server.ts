import { json } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export function GET() {
  const h = service().health();
  return json(h, { status: h.status === "ok" ? 200 : 503 });
}
