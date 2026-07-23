// web/server.js
// Custom adapter-node entry: fail-fast bind guard, then hand off to the adapter's real server
// (so graceful shutdown / body limits / compression are retained). Run via `npm run web:start`.
import { bindGuard } from "./src/lib/server/loopback.js";

const host = process.env.HOST || "127.0.0.1"; // adapter defaults 0.0.0.0; force a safe default and
process.env.HOST = host;                       // make the guard's host identical to what it will bind.
const port = process.env.PORT || "3000";
// Standalone CSRF: with ORIGIN unset, SvelteKit defaults url scheme to https and rejects the
// http-loopback login form. Setting ORIGIN to the real http origin makes url.origin match.
process.env.ORIGIN ||= `http://${host}:${port}`;

if (bindGuard({ token: process.env.HALYARD_CONSOLE_TOKEN, host, env: process.env }) === "refuse") {
  console.error("refusing to bind non-loopback host without HALYARD_CONSOLE_TOKEN");
  process.exit(1);
}

await import("./build/index.js"); // adapter-node's real entry; binds using the HOST/ORIGIN set above
