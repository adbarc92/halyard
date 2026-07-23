import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST() {
  try {
    const report = await service().reconcileNow();
    return json({ ok: true, report });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // enforceMultiApp throws here → Pro-required → 403 (not an unhandled 500)
    if (/Pro feature/i.test(message)) throw error(403, message);
    throw error(500, message);
  }
}
