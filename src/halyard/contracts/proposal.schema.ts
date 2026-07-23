import { z } from "zod";

/**
 * A Proposal is something an agent or a deterministic check *suggests* a human do —
 * never an action the system takes on its own (invariants #2, #5). M4 introduces the
 * flag-removal (graduation) proposal; M6 adds Sentry-triage and rejection-response
 * kinds onto the same queue. The mobile approval surface (M5) renders these.
 */

// flag_removal (M4); social_post = third-party draft (M5); crash_triage +
// rejection_response = the two M6 agents proposing into the same queue.
export const PROPOSAL_KINDS = [
  "flag_removal",
  "social_post",
  "crash_triage",
  "rejection_response",
  "cert_expiry", // M7 maintenance
  "platform_deadline", // M7 maintenance
  "dependency_update", // M7 maintenance
  "coordinator_error", // a reconcile source is failing — alert that self-resolves on recovery
] as const;
export const ProposalKindSchema = z.enum(PROPOSAL_KINDS);
export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

// open = needs a human; approved/dismissed = a human acted (never auto-changed);
// resolved = the system auto-closed it because the condition cleared (may auto-reopen on
// recurrence — unlike a human `dismissed`, which is never auto-reopened).
export const PROPOSAL_STATUSES = ["open", "approved", "dismissed", "resolved"] as const;
export const ProposalStatusSchema = z.enum(PROPOSAL_STATUSES);

// Triage classification (agent output). Recorded on the proposal for the human to act on.
export const SEVERITIES = ["critical", "high", "medium", "low"] as const;
export const SeveritySchema = z.enum(SEVERITIES);
export type Severity = (typeof SEVERITIES)[number];

export const RECOMMENDATIONS = ["flag_kill", "hotfix", "ignore"] as const;
export const RecommendationSchema = z.enum(RECOMMENDATIONS);
export type Recommendation = (typeof RECOMMENDATIONS)[number];

export const ProposalSchema = z
  .object({
    proposal_id: z.string().min(1), // stable id → one proposal per subject (idempotent)
    kind: ProposalKindSchema,
    app: z.string().min(1),
    release_id: z.string().optional(),
    launch_id: z.string().nullable().optional(),
    flag: z.string().optional(),
    channel: z.string().optional(), // social_post: the third-party channel (x, linkedin, hn)
    surface: z.string().optional(),
    severity: SeveritySchema.optional(), // crash_triage
    recommendation: RecommendationSchema.optional(), // crash_triage
    title: z.string().min(1),
    body: z.string().min(1),
    status: ProposalStatusSchema,
    created_at: z.string().datetime(),
  })
  .strict();

export type Proposal = z.infer<typeof ProposalSchema>;
