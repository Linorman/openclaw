import { z } from "zod";

import {
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
} from "openclaw/plugin-sdk";

const allowFromEntry = z.union([z.string(), z.number()]);

/**
 * Zod schema for individual QQ account configuration
 */
const QQAccountSchema = z.object({
  /** HTTP URL for NapCatQQ API */
  httpUrl: z.string().optional(),

  /** WebSocket URL for NapCatQQ events */
  wsUrl: z.string().optional(),

  /** Access token for NapCatQQ authentication */
  accessToken: z.string().optional(),

  /** Path to file containing access token */
  tokenFile: z.string().optional(),

  /** Whether this account is enabled */
  enabled: z.boolean().optional(),

  /** Display name for this account */
  name: z.string().optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: DmPolicySchema.optional(),

  /** Group chat policy: open, disabled, or allowlist */
  groupPolicy: GroupPolicySchema.optional(),

  /** Allowed sender QQ numbers */
  allowFrom: z.array(allowFromEntry).optional(),

  /** Allowed group IDs */
  groupAllowFrom: z.array(allowFromEntry).optional(),
});

/**
 * Zod schema for channels.qq.* configuration
 */
export const QQConfigSchema = z.object({
  /** HTTP URL for NapCatQQ API */
  httpUrl: z.string().optional(),

  /** WebSocket URL for NapCatQQ events */
  wsUrl: z.string().optional(),

  /** Access token for NapCatQQ authentication */
  accessToken: z.string().optional(),

  /** Path to file containing access token */
  tokenFile: z.string().optional(),

  /** Whether this channel is enabled */
  enabled: z.boolean().optional(),

  /** Display name for this channel */
  name: z.string().optional(),

  /** DM access policy: pairing, allowlist, open, or disabled */
  dmPolicy: z.enum(["pairing", "allowlist", "open", "disabled"]).optional(),

  /** Group chat policy: open, disabled, or allowlist */
  groupPolicy: z.enum(["open", "disabled", "allowlist"]).optional(),

  /** Allowed sender QQ numbers */
  allowFrom: z.array(allowFromEntry).optional(),

  /** Allowed group IDs */
  groupAllowFrom: z.array(allowFromEntry).optional(),

  /** Maximum characters per message chunk */
  textChunkLimit: z.number().optional(),

  /** Chunking mode: length or newline */
  chunkMode: z.enum(["length", "newline"]).optional(),

  /** Reply mode for threading: off, first, or all */
  replyToMode: z.enum(["off", "first", "all"]).optional(),

  /** Maximum history entries for group chats */
  historyLimit: z.number().optional(),

  /** Maximum history entries for DMs */
  dmHistoryLimit: z.number().optional(),

  /** Connection timeout in milliseconds */
  connectionTimeoutMs: z.number().optional(),

  /** Reconnection interval in milliseconds */
  reconnectIntervalMs: z.number().optional(),

  /** Whether to enable link preview */
  linkPreview: z.boolean().optional(),

  /** Markdown formatting overrides */
  markdown: MarkdownConfigSchema,

  /** Additional named accounts */
  accounts: z.record(z.string(), QQAccountSchema.optional()).optional(),
});

export type QQConfig = z.infer<typeof QQConfigSchema>;
