// web/tests/helpers/request-event.ts
import { vi } from "vitest";

/** Minimal RequestEvent fake for hooks/action unit tests. */
export function makeEvent(opts: {
  routeId?: string | null;
  path?: string;
  isDataRequest?: boolean;
  clientAddress?: string;
  headers?: Record<string, string>;
  cookies?: Record<string, string>;
  origin?: string;
} = {}) {
  const headers = new Headers(opts.headers ?? {});
  const jar = new Map<string, string>(Object.entries(opts.cookies ?? {}));
  const setCookies: { name: string; value: string; opts: any }[] = [];
  const url = new URL(opts.path ?? "/", opts.origin ?? "http://127.0.0.1:3000");
  const event: any = {
    route: { id: opts.routeId ?? null },
    isDataRequest: opts.isDataRequest ?? false,
    url,
    request: new Request(url, { headers }),
    getClientAddress: () => opts.clientAddress ?? "127.0.0.1",
    locals: {},
    cookies: {
      get: (n: string) => jar.get(n),
      set: (n: string, v: string, o: any) => { setCookies.push({ name: n, value: v, opts: o }); jar.set(n, v); },
      delete: (n: string, o: any) => { setCookies.push({ name: n, value: "", opts: o }); jar.delete(n); },
    },
  };
  return { event, setCookies };
}

/** A resolve() spy that returns a 200. */
export const okResolve = () => vi.fn(async () => new Response("ok", { status: 200 }));
