import type { OpenClawConfig } from "../config/config.js";
import type { QQAccountConfig } from "../config/types.qq.js";
import { isTruthyEnvValue } from "../infra/env.js";
import { listBoundAccountIds, resolveDefaultAgentBoundAccountId } from "../routing/bindings.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../routing/session-key.js";

const debugAccounts = (...args: unknown[]) => {
  if (isTruthyEnvValue(process.env.OPENCLAW_DEBUG_QQ_ACCOUNTS)) {
    console.warn("[qq:accounts]", ...args);
  }
};

export type ResolvedQQAccount = {
  accountId: string;
  enabled: boolean;
  name?: string;
  httpUrl: string;
  wsUrl?: string;
  accessToken: string;
  tokenSource: "env" | "tokenFile" | "config" | "none";
  config: QQAccountConfig;
};

function listConfiguredAccountIds(cfg: OpenClawConfig): string[] {
  const accounts = cfg.channels?.qq?.accounts;
  if (!accounts || typeof accounts !== "object") return [];
  const ids = new Set<string>();
  for (const key of Object.keys(accounts)) {
    if (!key) continue;
    ids.add(normalizeAccountId(key));
  }
  return [...ids];
}

export function listQQAccountIds(cfg: OpenClawConfig): string[] {
  const ids = Array.from(
    new Set([...listConfiguredAccountIds(cfg), ...listBoundAccountIds(cfg, "qq")]),
  );
  debugAccounts("listQQAccountIds", ids);
  if (ids.length === 0) return [DEFAULT_ACCOUNT_ID];
  return ids.sort((a, b) => a.localeCompare(b));
}

export function resolveDefaultQQAccountId(cfg: OpenClawConfig): string {
  const boundDefault = resolveDefaultAgentBoundAccountId(cfg, "qq");
  if (boundDefault) return boundDefault;
  const ids = listQQAccountIds(cfg);
  if (ids.includes(DEFAULT_ACCOUNT_ID)) return DEFAULT_ACCOUNT_ID;
  return ids[0] ?? DEFAULT_ACCOUNT_ID;
}

function resolveAccountConfig(
  cfg: OpenClawConfig,
  accountId: string,
): QQAccountConfig | undefined {
  const accounts = cfg.channels?.qq?.accounts;
  if (!accounts || typeof accounts !== "object") return undefined;
  const direct = accounts[accountId] as QQAccountConfig | undefined;
  if (direct) return direct;
  const normalized = normalizeAccountId(accountId);
  const matchKey = Object.keys(accounts).find((key) => normalizeAccountId(key) === normalized);
  return matchKey ? (accounts[matchKey] as QQAccountConfig | undefined) : undefined;
}

function mergeQQAccountConfig(cfg: OpenClawConfig, accountId: string): QQAccountConfig {
  const { accounts: _ignored, ...base } = (cfg.channels?.qq ?? {}) as QQAccountConfig & {
    accounts?: unknown;
  };
  const account = resolveAccountConfig(cfg, accountId) ?? {};
  return { ...base, ...account };
}

function resolveQQAccessToken(
  cfg: OpenClawConfig,
  accountId?: string | null,
): { token: string; source: "env" | "tokenFile" | "config" | "none" } {
  const envToken = process.env.QQ_ACCESS_TOKEN?.trim();
  if (envToken) {
    return { token: envToken, source: "env" };
  }

  const merged = mergeQQAccountConfig(cfg, accountId ?? DEFAULT_ACCOUNT_ID);
  
  if (merged.tokenFile) {
    try {
      const fs = require("fs");
      const fileToken = fs.readFileSync(merged.tokenFile, "utf8").trim();
      if (fileToken) {
        return { token: fileToken, source: "tokenFile" };
      }
    } catch {
      // fall through
    }
  }
  
  if (merged.accessToken?.trim()) {
    return { token: merged.accessToken.trim(), source: "config" };
  }

  return { token: "", source: "none" };
}

export function resolveQQAccount(params: {
  cfg: OpenClawConfig;
  accountId?: string | null;
}): ResolvedQQAccount {
  const hasExplicitAccountId = Boolean(params.accountId?.trim());
  const baseEnabled = params.cfg.channels?.qq?.enabled !== false;

  const resolve = (accountId: string) => {
    const merged = mergeQQAccountConfig(params.cfg, accountId);
    const accountEnabled = merged.enabled !== false;
    const enabled = baseEnabled && accountEnabled;
    const tokenResolution = resolveQQAccessToken(params.cfg, accountId);
    
    const httpUrl = merged.httpUrl?.trim() || "http://localhost:3000";
    const wsUrl = merged.wsUrl?.trim();
    
    debugAccounts("resolve", {
      accountId,
      enabled,
      tokenSource: tokenResolution.source,
      httpUrl,
      wsUrl,
    });
    
    return {
      accountId,
      enabled,
      name: merged.name?.trim() || undefined,
      httpUrl,
      wsUrl,
      accessToken: tokenResolution.token,
      tokenSource: tokenResolution.source,
      config: merged,
    } satisfies ResolvedQQAccount;
  };

  const normalized = normalizeAccountId(params.accountId);
  const primary = resolve(normalized);
  if (hasExplicitAccountId) return primary;
  if (primary.tokenSource !== "none" || primary.httpUrl !== "http://localhost:3000") return primary;

  const fallbackId = resolveDefaultQQAccountId(params.cfg);
  if (fallbackId === primary.accountId) return primary;
  const fallback = resolve(fallbackId);
  if (fallback.tokenSource !== "none") return fallback;
  return primary;
}

export function listEnabledQQAccounts(cfg: OpenClawConfig): ResolvedQQAccount[] {
  return listQQAccountIds(cfg)
    .map((accountId) => resolveQQAccount({ cfg, accountId }))
    .filter((account) => account.enabled);
}
