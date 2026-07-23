/**
 * Payment processing as a configurable third-party integration (one stop on the path to
 * production). Like every other external system in Halyard it sits behind a port with a
 * swappable adapter, and config carries only a `SECRET:NAME` reference to the key.
 *
 * Scope guardrail: a PaymentProvider in Halyard is for **configuration and verification** —
 * confirming the integration is wired and reachable, and (later) provisioning/verifying the
 * product catalog. It never moves money. Any future mutating action (creating a product or
 * price) must be gated like publish/merge — dry-run by default, armed explicitly, or staged
 * as a proposal for human approval. Halyard never charges anyone automatically.
 */
export interface PaymentStatus {
  provider: string;
  /** A credential/config is present (a key resolved from the secret store). */
  configured: boolean;
  /** The provider authenticated successfully on a read-only access check. */
  reachable: boolean;
  /** Human-readable detail — e.g. "livemode" / "testmode" / an error string. */
  detail?: string | undefined;
}

export interface PaymentProvider {
  /** Read-only access check: confirm the configured key authenticates. Never mutates. */
  verifyAccess(): Promise<PaymentStatus>;
}
