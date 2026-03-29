import {
  AllowFromListSchema,
  DmPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import { buildChannelConfigSchema } from "openclaw/plugin-sdk/nostr";
import { z } from "zod";

/**
 * Validates https:// URLs only
 */
const safeUrlSchema = z
  .string()
  .url()
  .refine(
    (url) => {
      try {
        const parsed = new URL(url);
        return parsed.protocol === "https:";
      } catch {
        return false;
      }
    },
    { message: "URL must use https:// protocol" },
  );

/**
 * NIP-01 profile metadata schema
 */
export const NostrProfileSchema = z.object({
  name: z.string().max(256).optional(),
  displayName: z.string().max(256).optional(),
  about: z.string().max(2000).optional(),
  picture: safeUrlSchema.optional(),
  banner: safeUrlSchema.optional(),
  website: safeUrlSchema.optional(),
  nip05: z.string().optional(),
  lud16: z.string().optional(),
});

export type NostrProfile = z.infer<typeof NostrProfileSchema>;

/**
 * Per-account config schema
 */
export const NostrAccountConfigSchema = z.object({
  enabled: z.boolean().optional(),
  name: z.string().optional(),
  privateKey: z.string().optional(),
  relays: z.array(z.string()).optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  profile: NostrProfileSchema.optional(),
}).passthrough();

/**
 * Top-level channels.nostr config schema (with multi-account support)
 */
export const NostrConfigSchema = z.object({
  name: z.string().optional(),
  defaultAccount: z.string().optional(),
  enabled: z.boolean().optional(),
  markdown: MarkdownConfigSchema,
  privateKey: z.string().optional(),
  relays: z.array(z.string()).optional(),
  dmPolicy: DmPolicySchema.optional(),
  allowFrom: AllowFromListSchema,
  profile: NostrProfileSchema.optional(),
  accounts: z.record(z.string(), NostrAccountConfigSchema).optional(),
});

export type NostrConfig = z.infer<typeof NostrConfigSchema>;

export const nostrChannelConfigSchema = buildChannelConfigSchema(NostrConfigSchema);
