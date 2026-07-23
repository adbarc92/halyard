import { json, error } from "@sveltejs/kit";
import { service } from "$lib/server/service.js";

export async function POST({ request }) {
  const { proposalId, finalText } = await request.json();
  if (typeof proposalId !== "string") throw error(400, "proposalId (string) required");
  try {
    const result = await service().approve(proposalId, typeof finalText === "string" ? finalText : undefined);
    return json({ ok: true, ...result });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A missing proposal is a 404; anything else (e.g. a backend write failure) is a real 500.
    throw error(message.startsWith("no such proposal") ? 404 : 500, message);
  }
}
