import type { ResolvedQQAccount } from "./accounts.js";

export type QQSendResult = {
  messageId: string;
  timestamp?: number;
};

export type QQSendOptions = {
  userId?: string | number;
  groupId?: string | number;
  message: string | QQMessageSegment[];
  accessToken?: string;
};

import type { QQMessageSegment } from "./types.js";

export type { QQMessageSegment };

async function makeQQApiRequest<T>(
  httpUrl: string,
  endpoint: string,
  accessToken: string,
  body: unknown,
): Promise<T> {
  const url = `${httpUrl.replace(/\/$/, "")}/${endpoint}`;
  
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  
  if (accessToken) {
    headers["Authorization"] = `Bearer ${accessToken}`;
  }

  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`QQ API error (${response.status}): ${errorText}`);
  }

  return response.json() as Promise<T>;
}

export async function sendPrivateMessageQQ(
  userId: string | number,
  message: string,
  account: ResolvedQQAccount,
  options?: {
    mediaUrl?: string;
    replyToId?: string;
  },
): Promise<QQSendResult> {
  const messageSegments: QQMessageSegment[] = [];

  if (options?.replyToId) {
    messageSegments.push({ type: "reply", data: { id: options.replyToId } });
  }

  if (options?.mediaUrl) {
    messageSegments.push({ type: "image", data: { file: options.mediaUrl } });
  }

  if (message) {
    messageSegments.push({ type: "text", data: { text: message } });
  }

  const response = await makeQQApiRequest<{ data?: { message_id: number } }>(
    account.httpUrl,
    "send_private_msg",
    account.accessToken,
    {
      user_id: userId,
      message: messageSegments,
    },
  );

  return {
    messageId: String(response.data?.message_id ?? ""),
  };
}

export async function sendGroupMessageQQ(
  groupId: string | number,
  message: string,
  account: ResolvedQQAccount,
  options?: {
    mediaUrl?: string;
    replyToId?: string;
  },
): Promise<QQSendResult> {
  const messageSegments: QQMessageSegment[] = [];

  if (options?.replyToId) {
    messageSegments.push({ type: "reply", data: { id: options.replyToId } });
  }

  if (options?.mediaUrl) {
    messageSegments.push({ type: "image", data: { file: options.mediaUrl } });
  }

  if (message) {
    messageSegments.push({ type: "text", data: { text: message } });
  }

  const response = await makeQQApiRequest<{ data?: { message_id: number } }>(
    account.httpUrl,
    "send_group_msg",
    account.accessToken,
    {
      group_id: groupId,
      message: messageSegments,
    },
  );

  return {
    messageId: String(response.data?.message_id ?? ""),
  };
}

export async function sendMessageQQ(
  to: string,
  text: string,
  account: ResolvedQQAccount,
  options?: {
    mediaUrl?: string;
    replyToId?: string;
    messageThreadId?: string;
  },
): Promise<QQSendResult> {
  const isGroup = to.startsWith("group:") || /^-?\d+$/.test(to);
  
  if (isGroup) {
    const groupId = to.replace(/^group:/, "");
    return sendGroupMessageQQ(groupId, text, account, options);
  } else {
    const userId = to.replace(/^user:/, "");
    return sendPrivateMessageQQ(userId, text, account, options);
  }
}
