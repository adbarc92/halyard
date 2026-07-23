/** Client-safe error helper — must NOT import anything from halyard or node: */
export async function errorMessage(res: Response, fallback: string): Promise<string> {
  const body = (await res.json().catch(() => ({}))) as { message?: string };
  return body.message ?? fallback;
}
