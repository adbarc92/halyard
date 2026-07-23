// tests/helpers/fake-service.ts
/**
 * An in-memory fake of the Halyard state-service HTTP contract, returned as a `fetchFn` for
 * ServiceHttpClient. Behaviour matches the contract in the design doc, including the ledger's
 * server-side set-union (the one accumulating endpoint) and canon create-if-absent. `GET` list
 * endpoints return ids in INSERTION order (deliberately unsorted) so adapter tests prove the
 * client-side sort. Use `baseUrl: "https://svc"` so paths are bare (`/releases/...`).
 */
export function makeFakeServiceFetch() {
  const releases = new Map<string, unknown>();
  const launches = new Map<string, unknown>();
  const proposals = new Map<string, unknown>();
  const ledgers = new Map<string, Set<string>>();
  const canon = new Map<string, unknown>();
  const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
  const noContent = () => new Response(null, { status: 204 });

  const fetchFn = (async (url: any, init: any = {}) => {
    const method = (init.method ?? "GET").toUpperCase();
    const path = new URL(String(url)).pathname; // baseUrl "https://svc" → "/releases/x"
    const body = init.body ? JSON.parse(init.body) : undefined;
    const seg = path.split("/").filter(Boolean); // e.g. ["releases","rel_1"] or ["ledgers","l","announced"]

    const single = (map: Map<string, unknown>, idKey: string) => {
      const id = decodeURIComponent(seg[1]!);
      if (method === "GET") return map.has(id) ? json(map.get(id)) : new Response(null, { status: 404 });
      if (method === "PUT") { map.set(id, body); return noContent(); }
      return new Response(null, { status: 405 });
    };

    if (seg[0] === "releases") return seg.length === 1 ? json([...releases.keys()]) : single(releases, "release_id");
    if (seg[0] === "launches") return seg.length === 1 ? json([...launches.keys()]) : single(launches, "launch_id");
    if (seg[0] === "proposals") return seg.length === 1 ? json([...proposals.values()]) : single(proposals, "proposal_id");

    if (seg[0] === "ledgers") {
      const lid = decodeURIComponent(seg[1]!);
      if (seg.length === 2 && method === "GET") {
        return ledgers.has(lid) ? json([...ledgers.get(lid)!]) : new Response(null, { status: 404 });
      }
      if (seg[2] === "announced" && method === "POST") {
        const set = ledgers.get(lid) ?? new Set<string>();
        set.add(body.key); // server-side set-union — the one accumulating endpoint
        ledgers.set(lid, set);
        return noContent();
      }
    }

    if (seg[0] === "canon" && method === "PUT") {
      const id = decodeURIComponent(seg[1]!);
      if (canon.has(id)) return json({ created: false });
      canon.set(id, body);
      return json({ created: true });
    }

    return new Response(null, { status: 404 });
  }) as typeof fetch;

  return { fetchFn, stores: { releases, launches, proposals, ledgers, canon } };
}
