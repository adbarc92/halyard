declare global {
  namespace App {
    interface Locals {
      /** Set by hooks.server.ts: is this request authenticated (or trusted-loopback no-token)? */
      authed: boolean;
    }
  }
}
export {};
