import type { OpenClawConfig } from "../config/config.js";
import { dispatchReplyWithBufferedBlockDispatcher } from "../auto-reply/reply/provider-dispatcher.js";
import type { RuntimeEnv } from "../runtime.js";
import { sendMessageQQ, type QQSendResult } from "./send.js";
import type { ResolvedQQAccount } from "./accounts.js";
import type { QQMessageContext } from "./message-context.js";

const EMPTY_RESPONSE_FALLBACK = "No response generated. Please try again.";

export type QQDispatchOptions = {
  context: QQMessageContext;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedQQAccount;
  accountId: string;
  textLimit?: number;
};

export async function dispatchQQMessage(params: QQDispatchOptions): Promise<void> {
  const { context, cfg, runtime, account } = params;
  const { ctxPayload, chatId, messageId } = context;
  

  
  const deliveryState = {
    delivered: false,
    skippedNonSilent: 0,
  };
  
  await dispatchReplyWithBufferedBlockDispatcher({
    ctx: ctxPayload,
    cfg,
    dispatcherOptions: {
      deliver: async (payload, info) => {
        if (info.kind === "final" && payload.text) {
          const result = await deliverQQReply({
            text: payload.text,
            to: chatId,
            account,
            replyToId: messageId,
          });
          if (result?.messageId) {
            deliveryState.delivered = true;
          }
        }
      },
      onSkip: (_payload, info) => {
        if (info.reason !== "silent") deliveryState.skippedNonSilent += 1;
      },
      onError: (err, info) => {
        runtime.error?.(`qq ${info.kind} reply failed: ${String(err)}`);
      },
      onReplyStart: () => {
        // QQ does not have a typing indicator API in NapCatQQ
      },
    },
    replyOptions: {
      onPartialReply: undefined,
      onReasoningStream: undefined,
    },
  });
  
  // Send fallback if no response was delivered
  if (!deliveryState.delivered && deliveryState.skippedNonSilent > 0) {
    await deliverQQReply({
      text: EMPTY_RESPONSE_FALLBACK,
      to: chatId,
      account,
    });
  }
}

async function deliverQQReply(params: {
  text: string;
  to: string;
  account: ResolvedQQAccount;
  replyToId?: string;
}): Promise<QQSendResult | null> {
  const { text, to, account, replyToId } = params;
  
  try {
    const result = await sendMessageQQ(to, text, account, {
      replyToId,
    });
    return result;
  } catch (error) {
    console.error("Failed to send QQ message:", error);
    return null;
  }
}

export async function handleQQInboundMessage(params: {
  message: QQInboundMessage;
  cfg: OpenClawConfig;
  runtime: RuntimeEnv;
  account: ResolvedQQAccount;
  accountId: string;
}): Promise<void> {
  const { message, cfg, runtime, account, accountId } = params;
  
  const { buildQQMessageContext, parseQQInboundMessage } = await import("./message-context.js");
  const parsedMessage = parseQQInboundMessage(message.raw, accountId);
  const context = await buildQQMessageContext({
    message: parsedMessage,
    cfg,
    account,
    accountId,
  });
  
  if (!context) {
    runtime.log?.("[qq] Failed to build message context");
    return;
  }
  
  await dispatchQQMessage({
    context,
    cfg,
    runtime,
    account,
    accountId,
  });
}

import type { QQInboundMessage } from "./types.js";
