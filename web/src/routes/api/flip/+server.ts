import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST({ request }) {
  const { flagKey, on } = await request.json();
  if (typeof flagKey !== "string" || typeof on !== "boolean") throw error(400, "flagKey (string) and on (boolean) required");
  try {
    await service().flip(flagKey, on);
    return json({ ok: true, flagKey, on });
  } catch (err) {
    throw error(500, err instanceof Error ? err.message : String(err));
  }
}
