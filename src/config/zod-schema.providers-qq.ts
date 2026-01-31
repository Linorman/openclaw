import { z } from "zod";

import {
  DmConfigSchema,
  DmPolicySchema,
  GroupPolicySchema,
  MarkdownConfigSchema,
  ReplyToModeSchema,
  RetryConfigSchema,
} from "./zod-schema.core.js";
import { ToolPolicySchema } from "./zod-schema.agent-runtime.js";
import { ChannelHeartbeatVisibilitySchema } from "./zod-schema.channels.js";

const ToolPolicyBySenderSchema = z.record(z.string(), ToolPolicySchema).optional();

const QQGroupConfigSchema = z
  .object({
    requireMention: z.boolean().optional(),
    tools: ToolPolicySchema,
    toolsBySender: ToolPolicyBySenderSchema,
    skills: z.array(z.string()).optional(),
    enabled: z.boolean().optional(),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    systemPrompt: z.string().optional(),
  })
  .strict();

export const QQAccountSchema = z
  .object({
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    commands: z.union([z.boolean(), z.literal("auto")]).optional(),
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    httpUrl: z.string().optional(),
    wsUrl: z.string().optional(),
    accessToken: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), QQGroupConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    retry: RetryConfigSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    linkPreview: z.boolean().optional(),
    connectionTimeoutMs: z.number().int().positive().optional(),
    reconnectIntervalMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dmPolicy !== "open") return;
    const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (allow.includes("*")) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowFrom"],
      message: 'channels.qq.accounts.*.dmPolicy="open" requires allowFrom to include "*"',
    });
  });

export const QQConfigSchema = z
  .object({
    accounts: z.record(z.string(), QQAccountSchema.optional()).optional(),
    name: z.string().optional(),
    capabilities: z.array(z.string()).optional(),
    markdown: MarkdownConfigSchema,
    commands: z.union([z.boolean(), z.literal("auto")]).optional(),
    configWrites: z.boolean().optional(),
    enabled: z.boolean().optional(),
    httpUrl: z.string().optional(),
    wsUrl: z.string().optional(),
    accessToken: z.string().optional(),
    tokenFile: z.string().optional(),
    dmPolicy: DmPolicySchema.optional().default("pairing"),
    groupPolicy: GroupPolicySchema.optional().default("allowlist"),
    allowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groupAllowFrom: z.array(z.union([z.string(), z.number()])).optional(),
    groups: z.record(z.string(), QQGroupConfigSchema.optional()).optional(),
    textChunkLimit: z.number().int().positive().optional(),
    chunkMode: z.enum(["length", "newline"]).optional(),
    replyToMode: ReplyToModeSchema.optional(),
    historyLimit: z.number().int().min(0).optional(),
    dmHistoryLimit: z.number().int().min(0).optional(),
    dms: z.record(z.string(), DmConfigSchema.optional()).optional(),
    retry: RetryConfigSchema,
    heartbeat: ChannelHeartbeatVisibilitySchema,
    linkPreview: z.boolean().optional(),
    connectionTimeoutMs: z.number().int().positive().optional(),
    reconnectIntervalMs: z.number().int().positive().optional(),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (value.dmPolicy !== "open") return;
    const allow = (value.allowFrom ?? []).map((v) => String(v).trim()).filter(Boolean);
    if (allow.includes("*")) return;
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["allowFrom"],
      message: 'channels.qq.dmPolicy="open" requires allowFrom to include "*"',
    });
  });
