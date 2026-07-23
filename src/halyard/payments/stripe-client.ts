import type { PaymentProvider, PaymentStatus } from "./types.js";
import { fetchWithTimeout } from "../net.js";

type FetchFn = typeof fetch;

/**
 * Stripe adapter — the reference PaymentProvider. `verifyAccess` does a single read-only
 * call (`GET /v1/balance`) to confirm the key authenticates and to report live vs test mode.
 * It performs NO mutation and moves NO money (see the port's scope guardrail). A different
 * processor implements the same `PaymentProvider` port with its own client.
 *
 * The key comes from the secret store at runtime (config holds only the reference). `fetchFn`
 * is injectable so the adapter is unit-testable without a network call.
 */
export interface StripeOptions {
  apiKey: string;
  fetchFn?: FetchFn;
}

export class StripePaymentProvider implements PaymentProvider {
  private readonly fetchFn: FetchFn;

  constructor(private readonly opts: StripeOptions) {
    this.fetchFn = opts.fetchFn ?? fetch;
  }

  async verifyAccess(): Promise<PaymentStatus> {
    const res = await fetchWithTimeout(this.fetchFn, "https://api.stripe.com/v1/balance", {
      headers: { authorization: `Bearer ${this.opts.apiKey}` },
    });
    if (!res.ok) {
      return { provider: "stripe", configured: true, reachable: false, detail: `Stripe API ${res.status}` };
    }
    const body = (await res.json().catch(() => ({}))) as { livemode?: boolean };
    return {
      provider: "stripe",
      configured: true,
      reachable: true,
      detail: body.livemode ? "livemode" : "testmode",
    };
  }
}
