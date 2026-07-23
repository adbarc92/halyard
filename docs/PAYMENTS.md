# Payment processing (third-party integration)

Halyard helps configure the third-party services an app needs to reach production. Payment
processing is one of them (monitoring is another — see [OBSERVABILITY.md](OBSERVABILITY.md)),
wired the same way as every other integration: **behind a port, configured by reference, with
a verify-only first step.**

> **Scope guardrail.** A payment provider in Halyard is for **configuration and verification**
> — confirming the integration is wired and reachable (and, later, provisioning/verifying the
> product catalog). It **never moves money**. Any future *mutating* action (create a product
> or price) will be gated like publish/merge: dry-run by default, armed explicitly, or staged
> as a proposal for human approval. Halyard never charges anyone automatically.
>
> Monetizing *Halyard itself* (billing for the tool) is a separate, future roadmap item — not
> what this integration is.

## Configure (per app)

```yaml
# apps/<slug>/app.yml
payments:
  provider: stripe                      # the concrete adapter is wired at runtime
  api_key_ref: SECRET:STRIPE_API_KEY_AURORA   # reference only; resolved from the secret store
```

The key is never stored in config — only a `SECRET:NAME` reference (invariant #4). Supply the
value via env / your `SecretStore`.

## Verify (production-readiness preflight)

```bash
halyard payments verify [--apps <slug,slug>]
```

For each app with a `payments` block it does a single read-only access check (Stripe:
`GET /v1/balance`) and reports `{ configured, reachable, detail }`. It exits non-zero if a
*configured* provider is unreachable (so it can gate a go-live check); an app with no payments
configured is reported, not failed. Fits the launch-readiness flow in
[LAUNCH-READINESS.md](LAUNCH-READINESS.md).

## Adding a provider

Implement the `PaymentProvider` port (`verifyAccess(): Promise<PaymentStatus>`) with your
processor's client and wire it in the CLI's `choosePaymentProvider` switch (Stripe is the
reference adapter). The verify command, config shape, and readiness flow are unchanged — this
is the first adapter in Halyard's broader third-party-provisioning capability.
