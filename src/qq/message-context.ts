import type { OpenClawConfig } from "../config/config.js";
import { resolveAgentRoute, type ResolvedAgentRoute } from "../routing/resolve-route.js";
import { resolveThreadSessionKeys } from "../routing/session-key.js";

import type { MsgContext } from "../auto-reply/templating.js";
import type { QQMessageEvent, QQInboundMessage } from "./types.js";
import type { ResolvedQQAccount } from "./accounts.js";

export type QQMessageContext = {
  ctxPayload: MsgContext;
  route: ResolvedAgentRoute;
  chatId: string;
  isGroup: boolean;
  senderId: string;
  senderName: string;
  messageId: string;
  text: string;
  replyToId?: string;
};

function buildQQGroupPeerId(groupId: number | string, userId?: number): string {
  const baseId = String(groupId);
  if (userId) {
    return `${baseId}:${userId}`;
  }
  return baseId;
}

function resolveQQPeerId(event: QQMessageEvent): { peerId: string; isGroup: boolean } {
  if (event.message_type === "group" && event.group_id) {
    return {
      peerId: buildQQGroupPeerId(event.group_id, event.sender?.user_id),
      isGroup: true,
    };
  }
  return {
    peerId: String(event.user_id),
    isGroup: false,
  };
}

function extractTextFromMessage(
  message: string | Array<{ type: string; data?: Record<string, unknown> }>,
): string {
  if (typeof message === "string") {
    return message;
  }

  return message
    .filter(
      (seg): seg is { type: string; data: Record<string, unknown> } =>
        seg.type === "text" && typeof seg.data === "object" && seg.data !== null,
    )
    .map((seg) => String(typeof seg.data.text === "string" ? seg.data.text : ""))
    .join("");
}

function extractReplyToId(
  message: Array<{ type: string; data?: Record<string, unknown> }>,
): string | undefined {
  const replySegment = message.find((seg) => seg.type === "reply");
  if (replySegment && typeof replySegment.data === "object" && replySegment.data !== null) {
    const id = replySegment.data.id;
    if (typeof id === "string" || typeof id === "number") {
      return String(id);
    }
  }
  return undefined;
}

export function parseQQInboundMessage(event: QQMessageEvent, accountId: string): QQInboundMessage {
  const { peerId, isGroup } = resolveQQPeerId(event);
  const text = extractTextFromMessage(event.message);
  const replyToId = Array.isArray(event.message) ? extractReplyToId(event.message) : undefined;

  return {
    channel: "qq",
    accountId,
    chatType: isGroup ? "group" : "direct",
    peerId,
    senderId: String(event.user_id),
    senderName: event.sender.nickname || event.sender.card || String(event.user_id),
    text,
    messageId: String(event.message_id),
    timestamp: event.time * 1000,
    replyToId,
    groupId: event.group_id ? String(event.group_id) : undefined,
    raw: event,
  };
}

export async function buildQQMessageContext(params: {
  message: QQInboundMessage;
  cfg: OpenClawConfig;
  account: ResolvedQQAccount;
  accountId: string;
}): Promise<QQMessageContext | null> {
  const { message, cfg, accountId } = params;

  const isGroup = message.chatType === "group";
  const peerKind = isGroup ? "group" : "dm";

  const route = resolveAgentRoute({
    cfg,
    channel: "qq",
    accountId,
    peer: { kind: peerKind, id: message.peerId },
  });

  const threadKeys = isGroup
    ? resolveThreadSessionKeys({ baseSessionKey: route.sessionKey, threadId: message.groupId })
    : null;
  const sessionKey = threadKeys?.sessionKey ?? route.sessionKey;

  const ctxPayload: MsgContext = {
    Body: message.text,
    BodyForAgent: message.text,
    RawBody: message.text,
    CommandBody: message.text,
    BodyForCommands: message.text,
    From: message.senderId,
    To: message.peerId,
    SessionKey: sessionKey,
    AccountId: accountId,
    MessageSid: message.messageId,
    MessageSidFull: message.messageId,
    ReplyToId: message.replyToId,
    SenderName: message.senderName,
    SenderId: message.senderId,
    Timestamp: message.timestamp,
    Provider: "qq",
    Surface: "qq",
    ChatType: isGroup ? "group" : "direct",
  };

  // Prefix chatId to distinguish between private and group chats
  const chatId = isGroup ? `group:${message.peerId}` : `user:${message.senderId}`;

  return {
    ctxPayload,
    route,
    chatId,
    isGroup,
    senderId: message.senderId,
    senderName: message.senderName,
    messageId: message.messageId,
    text: message.text,
    replyToId: message.replyToId,
  };
}
