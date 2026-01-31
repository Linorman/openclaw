import type {
  DmPolicy,
  GroupPolicy,
  MarkdownConfig,
  OutboundRetryConfig,
  ReplyToMode,
} from "./types.base.js";
import type { ChannelHeartbeatVisibilityConfig } from "./types.channels.js";
import type { DmConfig, ProviderCommandsConfig } from "./types.messages.js";
import type { GroupToolPolicyBySenderConfig, GroupToolPolicyConfig } from "./types.tools.js";

export type QQGroupConfig = {
  requireMention?: boolean;
  /** Optional tool policy overrides for this group. */
  tools?: GroupToolPolicyConfig;
  toolsBySender?: GroupToolPolicyBySenderConfig;
  /** If specified, only load these skills for this group. Omit = all skills; empty = no skills. */
  skills?: string[];
  /** If false, disable the bot for this group. */
  enabled?: boolean;
  /** Optional allowlist for group senders (QQ numbers). */
  allowFrom?: Array<string | number>;
  /** Optional system prompt snippet for this group. */
  systemPrompt?: string;
};

export type QQAccountConfig = {
  /** Optional display name for this account (used in CLI/UI lists). */
  name?: string;
  /** Optional provider capability tags used for agent/runtime guidance. */
  capabilities?: string[];
  /** Markdown formatting overrides (tables). */
  markdown?: MarkdownConfig;
  /** Override native command registration for QQ (bool or "auto"). */
  commands?: ProviderCommandsConfig;
  /** Allow channel-initiated config writes (default: true). */
  configWrites?: boolean;
  /**
   * Controls how QQ direct chats (DMs) are handled:
   * - "pairing" (default): unknown senders get a pairing code; owner must approve
   * - "allowlist": only allow senders in allowFrom (or paired allow store)
   * - "open": allow all inbound DMs (requires allowFrom to include "*")
   * - "disabled": ignore all inbound DMs
   */
  dmPolicy?: DmPolicy;
  /** If false, do not start this QQ account. Default: true. */
  enabled?: boolean;
  /** NapCatQQ HTTP API endpoint (e.g., http://localhost:3000). */
  httpUrl?: string;
  /** NapCatQQ WebSocket endpoint (e.g., ws://localhost:3001). */
  wsUrl?: string;
  /** Access token for NapCatQQ API authentication. */
  accessToken?: string;
  /**
   * Controls how group messages are handled:
   * - "open": groups bypass allowFrom, only mention-gating applies
   * - "disabled": block all group messages entirely
   * - "allowlist": only allow group messages from senders in groupAllowFrom/allowFrom
   */
  groupPolicy?: GroupPolicy;
  /** Outbound text chunk size (chars). Default: 4000. */
  textChunkLimit?: number;
  /** Chunking mode: "length" (default) splits by size; "newline" splits on every newline. */
  chunkMode?: "length" | "newline";
  /** Control reply threading when reply tags are present (off|first|all). */
  replyToMode?: ReplyToMode;
  groups?: Record<string, QQGroupConfig>;
  allowFrom?: Array<string | number>;
  /** Optional allowlist for QQ group senders (QQ numbers). */
  groupAllowFrom?: Array<string | number>;
  /** Max group messages to keep as history context (0 disables). */
  historyLimit?: number;
  /** Max DM turns to keep as history context. */
  dmHistoryLimit?: number;
  /** Per-DM config overrides keyed by user QQ number. */
  dms?: Record<string, DmConfig>;
  /** Retry policy for outbound NapCatQQ API calls. */
  retry?: OutboundRetryConfig;
  /** Heartbeat visibility settings for this channel. */
  heartbeat?: ChannelHeartbeatVisibilityConfig;
  /** Controls whether link previews are shown in outbound messages. Default: true. */
  linkPreview?: boolean;
  /** Connection timeout in milliseconds. Default: 30000. */
  connectionTimeoutMs?: number;
  /** Reconnection interval in milliseconds. Default: 5000. */
  reconnectIntervalMs?: number;
  /** Path to file containing access token (for secret managers like agenix). */
  tokenFile?: string;
};

export type QQConfig = {
  /** Optional per-account QQ configuration (multi-account). */
  accounts?: Record<string, QQAccountConfig>;
} & QQAccountConfig;
