import { z } from "zod";
import { CronSchema } from "./primitives.js";
import { SecretRefSchema } from "./secret-ref.js";

/**
 * Org-level config — `halyard.config.yml` (§4). One file, shared across every app.
 * Holds the coordinator backend, the mobile approval surface, the drafting model,
 * and the channel registry with its trust classes + gates.
 */

export const ANNOUNCE_POLICIES = ["per_surface", "first_surface", "all_surfaces"] as const;
export const AnnouncePolicySchema = z.enum(ANNOUNCE_POLICIES);
export type AnnouncePolicy = (typeof ANNOUNCE_POLICIES)[number];

export const CHANNEL_CLASSES = ["owned", "third_party"] as const;
export const ChannelClassSchema = z.enum(CHANNEL_CLASSES);
export type ChannelClass = (typeof CHANNEL_CLASSES)[number];

/** Gate strength. `auto` is only permissible on owned channels (enforced below). */
export const CHANNEL_GATES = ["auto", "human"] as const;
export const ChannelGateSchema = z.enum(CHANNEL_GATES);
export type ChannelGate = (typeof CHANNEL_GATES)[number];

export const TIERS = ["standard", "launch"] as const;
export const TierSchema = z.enum(TIERS);
export type Tier = (typeof TIERS)[number];

const CoordinatorSchema = z
  .object({
    backend: z.enum(["git", "service"]),
    state_dir: z.string().min(1), // required for git; an ignored placeholder for service
    // Present iff backend: service. The DB lives behind this API (the hub owns it); the
    // library is a thin HTTP client. URL is non-secret; the token comes from api_key_ref at runtime.
    service: z
      .object({ api_url: z.string().url(), api_key_ref: SecretRefSchema })
      .strict()
      .optional(),
    reconcile_cron: CronSchema,
    dedup: z.boolean().default(true), // currently inert: invariant #3 is hardwired in appendTransition
  })
  .strict()
  .superRefine((c, ctx) => {
    if (c.backend === "git" && c.service) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service"], message: 'service config is not allowed for backend "git"' });
    }
    if (c.backend === "service" && !c.service) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ["service"], message: 'service config is required for backend "service"' });
    }
  });

const NotificationsSchema = z
  .object({
    // The mobile-reachable approval surface. A secret *reference*, never the webhook URL.
    approval_channel_ref: SecretRefSchema,
  })
  .strict();

const DraftingSchema = z
  .object({
    provider: z.literal("anthropic"),
    model: z.string().min(1), // current model string verified at M5/M6, not assumed here
    api_key_ref: SecretRefSchema,
    voice_canon: z.string().min(1),
  })
  .strict();

const HttpPublishSchema = z
  .object({
    type: z.literal("http"),
    endpoint_ref: SecretRefSchema, // never the literal endpoint
  })
  .strict();

const ManualPublishSchema = z
  .object({
    type: z.literal("manual"),
  })
  .strict();

const PublishSchema = z.discriminatedUnion("type", [HttpPublishSchema, ManualPublishSchema]);

const ChannelSchema = z
  .object({
    class: ChannelClassSchema,
    gate: ChannelGateSchema,
    requires_tier: TierSchema.optional(),
    publish: PublishSchema,
  })
  .strict()
  .superRefine((channel, ctx) => {
    // Invariant #5: only owned channels may auto-publish; third-party stays human.
    if (channel.class === "third_party" && channel.gate === "auto") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate"],
        message:
          'third_party channels may not use gate "auto" — the post button must stay a human action.',
      });
    }
    // A manual publish target must never be paired with an auto gate (nothing to call).
    if (channel.publish.type === "manual" && channel.gate === "auto") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["gate"],
        message: 'gate "auto" requires an http publish target, not "manual".',
      });
    }
  });

export const OrgConfigSchema = z
  .object({
    version: z.literal(1),
    org: z.object({ name: z.string().min(1) }).strict(),
    coordinator: CoordinatorSchema,
    notifications: NotificationsSchema,
    drafting: DraftingSchema,
    channels: z.record(z.string(), ChannelSchema),
    defaults: z
      .object({
        announce_policy: AnnouncePolicySchema,
      })
      .strict(),
  })
  .strict();

export type OrgConfig = z.infer<typeof OrgConfigSchema>;
