import type { OpenClawConfig } from "../config/config.js";
import type { RuntimeEnv } from "../runtime.js";
import type { ResolvedQQAccount } from "./accounts.js";
import type { QQEvent, QQMessageEvent } from "./types.js";
import { WebSocket } from "ws";

export type QQMonitorOptions = {
  account: ResolvedQQAccount;
  config: OpenClawConfig;
  runtime: RuntimeEnv;
  abortSignal: AbortSignal;
  onEvent: (event: QQEvent) => Promise<void> | void;
  onMessage?: (event: QQMessageEvent) => Promise<void> | void;
  onError?: (error: Error) => void;
};

export type QQMonitorResult = {
  close: () => void;
};

export function monitorQQProvider(options: QQMonitorOptions): QQMonitorResult {
  const { account, abortSignal, onEvent, onMessage, onError } = options;
  
  const wsUrl = account.wsUrl;
  if (!wsUrl) {
    throw new Error("WebSocket URL not configured for QQ account");
  }

  let ws: WebSocket | null = null;
  let reconnectTimer: NodeJS.Timeout | null = null;
  let isClosing = false;

  const connect = () => {
    if (isClosing || abortSignal.aborted) return;

    try {
      const headers: Record<string, string> = {};
      if (account.accessToken) {
        headers["Authorization"] = `Bearer ${account.accessToken}`;
      }

      ws = new WebSocket(wsUrl, { headers });

      ws.on("open", () => {
        console.log(`[qq:${account.accountId}] WebSocket connected`);
      });

      ws.on("message", async (data) => {
        try {
          const event = JSON.parse(
            typeof data === "string" ? data : Buffer.from(data as Buffer).toString(),
          ) as QQEvent;
          await onEvent(event);
          
          if (event.post_type === "message" && onMessage) {
            await onMessage(event as QQMessageEvent);
          }
        } catch (error) {
          console.error(`[qq:${account.accountId}] Failed to process event:`, error);
        }
      });

      ws.on("close", (code) => {
        if (!isClosing && !abortSignal.aborted) {
          console.log(`[qq:${account.accountId}] WebSocket closed (${code}), reconnecting...`);
          reconnectTimer = setTimeout(connect, account.config.reconnectIntervalMs ?? 5000);
        }
      });

      ws.on("error", (error) => {
        onError?.(error);
      });
    } catch (error) {
      onError?.(error instanceof Error ? error : new Error(String(error)));
    }
  };

  connect();

  abortSignal.addEventListener("abort", () => {
    isClosing = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
    }
    if (ws) {
      ws.close();
    }
  });

  return {
    close: () => {
      isClosing = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
      }
      if (ws) {
        ws.close();
      }
    },
  };
}
