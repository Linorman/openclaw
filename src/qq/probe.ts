import type { ResolvedQQAccount } from "./accounts.js";

export type QQProbeResult =
  | {
      ok: true;
      selfId: number;
      nickname: string;
      status: string;
    }
  | {
      ok: false;
      error: string;
    };

export async function probeQQ(
  account: ResolvedQQAccount,
  timeoutMs: number = 5000,
): Promise<QQProbeResult> {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    const url = `${account.httpUrl.replace(/\/$/, "")}/get_login_info`;
    
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    
    if (account.accessToken) {
      headers["Authorization"] = `Bearer ${account.accessToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
    });

    clearTimeout(timeoutId);

    if (!response.ok) {
      return {
        ok: false,
        error: `HTTP ${response.status}: ${await response.text()}`,
      };
    }

    const data = await response.json() as {
      data?: {
        user_id?: number;
        nickname?: string;
      };
    };

    if (!data.data?.user_id) {
      return {
        ok: false,
        error: "Invalid response from NapCatQQ API",
      };
    }

    // Get status
    const statusUrl = `${account.httpUrl.replace(/\/$/, "")}/get_status`;
    const statusResponse = await fetch(statusUrl, {
      method: "POST",
      headers,
    });
    
    const statusData = await statusResponse.json() as {
      data?: {
        online?: boolean;
        good?: boolean;
      };
    };

    return {
      ok: true,
      selfId: data.data.user_id,
      nickname: data.data.nickname ?? "",
      status: statusData.data?.online ? "online" : "offline",
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
