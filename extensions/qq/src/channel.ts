import {
  applyAccountNameToChannelSection,
  buildChannelConfigSchema,
  DEFAULT_ACCOUNT_ID,
  deleteAccountFromConfigSection,
  formatPairingApproveHint,
  getChatChannelMeta,
  listQQAccountIds,
  migrateBaseNameToDefaultAccount,
  normalizeAccountId,
  PAIRING_APPROVED_MESSAGE,
  probeQQ,
  qqOnboardingAdapter,
  resolveDefaultQQAccountId,
  resolveQQAccount,
  sendMessageQQ,
  setAccountEnabledInConfigSection,
  monitorQQProvider,
  buildQQMessageContext,
  dispatchQQMessage,
  parseQQInboundMessage,
  getNapCatQuickLoginList,
  setNapCatQuickLogin,
  readNapCatConfig,
  startNapCatQQ,
  stopNapCatQQ,
  getNapCatStatus,
  type ChannelPlugin,
  type OpenClawConfig,
  type ResolvedQQAccount,
  type QQEvent,
  type QQMessageEvent,
  type QuickLoginItem,
} from "openclaw/plugin-sdk";

import { QQConfigSchema } from "./config-schema.js";

import { getQQRuntime } from "./runtime.js";

const meta = getChatChannelMeta("qq");

function parseReplyToMessageId(replyToId?: string | null): string | undefined {
  if (!replyToId) return undefined;
  return replyToId;
}

export const qqPlugin: ChannelPlugin<ResolvedQQAccount> = {
  id: "qq",
  meta: {
    ...meta,
    quickstartAllowFrom: true,
  },
  onboarding: qqOnboardingAdapter,
  pairing: {
    idLabel: "qqNumber",
    normalizeAllowEntry: (entry) => entry.replace(/^qq:/i, ""),
    notifyApproval: async ({ cfg, id }) => {
      const account = resolveQQAccount({ cfg });
      await sendMessageQQ(id, PAIRING_APPROVED_MESSAGE, account);
    },
  },
  capabilities: {
    chatTypes: ["direct", "group"],
    reactions: false,
    threads: false,
    media: true,
    nativeCommands: false,
    blockStreaming: false,
  },
  reload: { configPrefixes: ["channels.qq"] },
  configSchema: buildChannelConfigSchema(QQConfigSchema),
  config: {
    listAccountIds: (cfg) => listQQAccountIds(cfg),
    resolveAccount: (cfg, accountId) => resolveQQAccount({ cfg, accountId }),
    defaultAccountId: (cfg) => resolveDefaultQQAccountId(cfg),
    setAccountEnabled: ({ cfg, accountId, enabled }) =>
      setAccountEnabledInConfigSection({
        cfg,
        sectionKey: "qq",
        accountId,
        enabled,
        allowTopLevel: true,
      }),
    deleteAccount: ({ cfg, accountId }) =>
      deleteAccountFromConfigSection({
        cfg,
        sectionKey: "qq",
        accountId,
        clearBaseFields: ["httpUrl", "wsUrl", "accessToken", "name"],
      }),
    isConfigured: (account) => Boolean(account.httpUrl?.trim()),
    describeAccount: (account) => ({
      accountId: account.accountId,
      name: account.name,
      enabled: account.enabled,
      configured: Boolean(account.httpUrl?.trim()),
      tokenSource: account.tokenSource,
    }),
    resolveAllowFrom: ({ cfg, accountId }) =>
      (resolveQQAccount({ cfg, accountId }).config.allowFrom ?? []).map((entry) =>
        String(entry),
      ),
    formatAllowFrom: ({ allowFrom }) =>
      allowFrom
        .map((entry) => String(entry).trim())
        .filter(Boolean)
        .map((entry) => entry.replace(/^qq:/i, "")),
  },
  security: {
    resolveDmPolicy: ({ cfg, accountId, account }) => {
      const resolvedAccountId = accountId ?? account.accountId ?? DEFAULT_ACCOUNT_ID;
      const useAccountPath = Boolean(cfg.channels?.qq?.accounts?.[resolvedAccountId]);
      const basePath = useAccountPath
        ? `channels.qq.accounts.${resolvedAccountId}.`
        : "channels.qq.";
      return {
        policy: account.config.dmPolicy ?? "pairing",
        allowFrom: account.config.allowFrom ?? [],
        policyPath: `${basePath}dmPolicy`,
        allowFromPath: basePath,
        approveHint: formatPairingApproveHint("qq"),
        normalizeEntry: (raw) => raw.replace(/^qq:/i, ""),
      };
    },
    collectWarnings: ({ account }) => {
      const warnings: string[] = [];
      if (!account.httpUrl) {
        warnings.push("QQ HTTP URL not configured");
      }
      if (!account.wsUrl) {
        warnings.push("QQ WebSocket URL not configured (required for receiving messages)");
      }
      return warnings;
    },
  },
  threading: {
    resolveReplyToMode: ({ cfg }) => cfg.channels?.qq?.replyToMode ?? "first",
  },
  messaging: {
    normalizeTarget: (target) => {
      const normalized = target.trim().toLowerCase();
      if (normalized.startsWith("qq:")) {
        return target.replace(/^qq:/i, "");
      }
      return target;
    },
    targetResolver: {
      looksLikeId: (target) => /^-?\d+$/.test(target.trim()),
      hint: "<qqNumber> or group:<groupId>",
    },
  },
  setup: {
    resolveAccountId: ({ accountId }) => normalizeAccountId(accountId),
    applyAccountName: ({ cfg, accountId, name }) =>
      applyAccountNameToChannelSection({
        cfg,
        channelKey: "qq",
        accountId,
        name,
      }),
    validateInput: ({ input }) => {
      if (!input.httpUrl && !input.wsUrl) {
        return "QQ requires httpUrl or wsUrl (NapCatQQ endpoints).";
      }
      return null;
    },
    applyAccountConfig: ({ cfg, accountId, input }) => {
      const namedConfig = applyAccountNameToChannelSection({
        cfg,
        channelKey: "qq",
        accountId,
        name: input.name,
      });
      const next =
        accountId !== DEFAULT_ACCOUNT_ID
          ? migrateBaseNameToDefaultAccount({
              cfg: namedConfig,
              channelKey: "qq",
            })
          : namedConfig;
      
      const accountConfig = {
        enabled: true,
        ...(input.httpUrl ? { httpUrl: input.httpUrl } : {}),
        ...(input.wsUrl ? { wsUrl: input.wsUrl } : {}),
        ...(input.accessToken ? { accessToken: input.accessToken } : {}),
        ...(input.tokenFile ? { tokenFile: input.tokenFile } : {}),
      };
      
      if (accountId === DEFAULT_ACCOUNT_ID) {
        return {
          ...next,
          channels: {
            ...next.channels,
            qq: {
              ...next.channels?.qq,
              ...accountConfig,
            },
          },
        };
      }
      return {
        ...next,
        channels: {
          ...next.channels,
          qq: {
            ...next.channels?.qq,
            accounts: {
              ...next.channels?.qq?.accounts,
              [accountId]: {
                ...next.channels?.qq?.accounts?.[accountId],
                ...accountConfig,
              },
            },
          },
        },
      };
    },
  },
  outbound: {
    deliveryMode: "direct",
    chunkerMode: "length",
    textChunkLimit: 4000,
    sendText: async ({ to, text, accountId, deps, replyToId }) => {
      const send = deps?.sendQQ ?? sendMessageQQ;
      const account = resolveQQAccount({
        cfg: getQQRuntime().config.loadConfig(),
        accountId: accountId ?? undefined,
      });
      const parsedReplyToId = parseReplyToMessageId(replyToId);
      const result = await send(to, text, account, {
        replyToId: parsedReplyToId,
      });
      return { channel: "qq", ...result };
    },
    sendMedia: async ({ to, text, mediaUrl, accountId, deps, replyToId }) => {
      const send = deps?.sendQQ ?? sendMessageQQ;
      const account = resolveQQAccount({
        cfg: getQQRuntime().config.loadConfig(),
        accountId: accountId ?? undefined,
      });
      const parsedReplyToId = parseReplyToMessageId(replyToId);
      const result = await send(to, text, account, {
        mediaUrl,
        replyToId: parsedReplyToId,
      });
      return { channel: "qq", ...result };
    },
  },
  status: {
    defaultRuntime: {
      accountId: DEFAULT_ACCOUNT_ID,
      running: false,
      lastStartAt: null,
      lastStopAt: null,
      lastError: null,
    },
    buildChannelSummary: ({ snapshot }) => ({
      configured: snapshot.configured ?? false,
      tokenSource: snapshot.tokenSource ?? "none",
      running: snapshot.running ?? false,
      mode: snapshot.mode ?? null,
      lastStartAt: snapshot.lastStartAt ?? null,
      lastStopAt: snapshot.lastStopAt ?? null,
      lastError: snapshot.lastError ?? null,
      probe: snapshot.probe,
      lastProbeAt: snapshot.lastProbeAt ?? null,
    }),
    probeAccount: async ({ account, timeoutMs }) =>
      probeQQ(account, timeoutMs),
    buildAccountSnapshot: ({ account, runtime, probe }) => {
      const configured = Boolean(account.httpUrl?.trim());
      return {
        accountId: account.accountId,
        name: account.name,
        enabled: account.enabled,
        configured,
        tokenSource: account.tokenSource,
        running: runtime?.running ?? false,
        lastStartAt: runtime?.lastStartAt ?? null,
        lastStopAt: runtime?.lastStopAt ?? null,
        lastError: runtime?.lastError ?? null,
        mode: runtime?.mode ?? (account.wsUrl ? "websocket" : "http"),
        probe,
        lastInboundAt: runtime?.lastInboundAt ?? null,
        lastOutboundAt: runtime?.lastOutboundAt ?? null,
      };
    },
  },
  gateway: {
    startAccount: async (ctx) => {
      const account = ctx.account;
      if (!account.wsUrl) {
        throw new Error("WebSocket URL required for QQ gateway");
      }
      
      ctx.log?.info(`[${account.accountId}] starting QQ provider`);
      
      // Check if NapCat/QQ is already running, start it if not
      const napcatStatus = await getNapCatStatus();
      if (!napcatStatus.running) {
        ctx.log?.info(`[${account.accountId}] NapCat not running, starting it...`);
        const startResult = await startNapCatQQ(ctx.runtime, { killExisting: true });
        if (!startResult.ok) {
          throw new Error(`Failed to start NapCat: ${startResult.error || "Unknown error"}`);
        }
        ctx.log?.info(`[${account.accountId}] NapCat started (ports: HTTP ${startResult.httpPort}, WS ${startResult.wsPort})`);
        
        // Wait for NapCat to fully initialize
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        ctx.log?.info(`[${account.accountId}] NapCat already running (PID: ${napcatStatus.pid})`);
      }
      
      const probe = await probeQQ(account, 2500);
      let botLabel = "";
      if (probe.ok) {
        botLabel = ` (${probe.nickname})`;
      }
      ctx.log?.info(`[${account.accountId}] QQ provider started${botLabel}`);
      
      return monitorQQProvider({
        account,
        config: ctx.cfg,
        runtime: ctx.runtime,
        abortSignal: ctx.abortSignal,
        onEvent: async (event) => {
          if (event.post_type === "message") {
            const msgEvent = event as QQMessageEvent;
            ctx.log?.info(`[${account.accountId}] Received message from ${msgEvent.sender.nickname}`);
          }
        },
        onMessage: async (event) => {
          const message = parseQQInboundMessage(event, account.accountId);
          const messageContext = await buildQQMessageContext({
            message,
            cfg: ctx.cfg,
            account,
            accountId: account.accountId,
          });
          
          if (!messageContext) {
            ctx.log?.info(`[${account.accountId}] Failed to build message context`);
            return;
          }
          
          await dispatchQQMessage({
            context: messageContext,
            cfg: ctx.cfg,
            runtime: ctx.runtime,
            account,
            accountId: account.accountId,
          });
        },
        onError: (error) => {
          ctx.log?.error(`[${account.accountId}] QQ WebSocket error: ${error.message}`);
        },
      });
    },
    stopAccount: async (ctx) => {
      ctx.log?.info(`[${ctx.accountId}] stopping QQ provider`);
      await stopNapCatQQ(ctx.runtime);
      ctx.log?.info(`[${ctx.accountId}] QQ provider stopped`);
    },
    loginWithQrStart: async (params) => {
      const napCatConfig = await readNapCatConfig(params.accountId);
      if (!napCatConfig?.webuiPort) {
        return {
          message: "NapCat WebUI not configured. Please run onboarding first.",
        };
      }

      const webuiPort = napCatConfig.webuiPort;
      const webuiToken = napCatConfig.webuiToken;

      // Try to get quick login list
      const quickLoginResult = await getNapCatQuickLoginList(webuiPort, webuiToken);
      
      if (quickLoginResult.success && quickLoginResult.list && quickLoginResult.list.length > 0) {
        // Find the first account that supports quick login
        const quickLoginAccount = quickLoginResult.list.find((item: QuickLoginItem) => item.isQuickLogin);
        
        if (quickLoginAccount) {
          // Attempt quick login
          const loginResult = await setNapCatQuickLogin(quickLoginAccount.uin, webuiPort, webuiToken);
          
          if (loginResult.success) {
            return {
              message: `Quick login initiated for QQ ${quickLoginAccount.uin} (${quickLoginAccount.nickName}). Waiting for login to complete...`,
            };
          }
        }
      }

      // If quick login is not available, fall back to QR code
      return {
        message: "No quick login available. Please use NapCat WebUI to scan QR code for login.",
      };
    },
    loginWithQrWait: async (params) => {
      const napCatConfig = await readNapCatConfig(params.accountId);
      if (!napCatConfig?.httpPort) {
        return {
          connected: false,
          message: "NapCat HTTP API not configured. Please run onboarding first.",
        };
      }

      const httpPort = napCatConfig.httpPort;
      const accessToken = napCatConfig.httpToken;

      // Poll for login status via OneBot API
      const maxAttempts = params.timeoutMs ? Math.ceil(params.timeoutMs / 3000) : 60;
      
      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        const probe = await probeQQ(
          resolveQQAccount({
            cfg: getQQRuntime().config.loadConfig(),
            accountId: params.accountId ?? undefined,
          }),
          5000,
        );

        if (probe.ok && probe.status === "online") {
          return {
            connected: true,
            message: `QQ logged in successfully as ${probe.nickname} (${probe.selfId})`,
          };
        }

        await new Promise((resolve) => setTimeout(resolve, 3000));
      }

      return {
        connected: false,
        message: "Timeout waiting for QQ login. Please check NapCat WebUI for QR code.",
      };
    },
    logoutAccount: async ({ accountId, cfg }) => {
      const nextCfg = { ...cfg } as OpenClawConfig;
      const nextQQ = cfg.channels?.qq ? { ...cfg.channels.qq } : undefined;
      let cleared = false;
      let changed = false;
      
      if (nextQQ) {
        if (accountId === DEFAULT_ACCOUNT_ID) {
          if (nextQQ.accessToken) {
            delete nextQQ.accessToken;
            cleared = true;
            changed = true;
          }
          if (nextQQ.httpUrl) {
            delete nextQQ.httpUrl;
            changed = true;
          }
          if (nextQQ.wsUrl) {
            delete nextQQ.wsUrl;
            changed = true;
          }
        }
        
        const accounts =
          nextQQ.accounts && typeof nextQQ.accounts === "object"
            ? { ...nextQQ.accounts }
            : undefined;
        if (accounts && accountId in accounts) {
          const entry = accounts[accountId];
          if (entry && typeof entry === "object") {
            const nextEntry = { ...entry } as Record<string, unknown>;
            if ("accessToken" in nextEntry) {
              delete nextEntry.accessToken;
              cleared = true;
              changed = true;
            }
            if ("httpUrl" in nextEntry) {
              delete nextEntry.httpUrl;
              changed = true;
            }
            if ("wsUrl" in nextEntry) {
              delete nextEntry.wsUrl;
              changed = true;
            }
            if (Object.keys(nextEntry).length === 0) {
              delete accounts[accountId];
              changed = true;
            } else {
              accounts[accountId] = nextEntry as typeof entry;
            }
          }
        }
        
        if (accounts) {
          if (Object.keys(accounts).length === 0) {
            delete nextQQ.accounts;
            changed = true;
          } else {
            nextQQ.accounts = accounts;
          }
        }
      }
      
      if (changed) {
        if (nextQQ && Object.keys(nextQQ).length > 0) {
          nextCfg.channels = { ...nextCfg.channels, qq: nextQQ };
        } else {
          const nextChannels = { ...nextCfg.channels };
          delete nextChannels.qq;
          if (Object.keys(nextChannels).length > 0) {
            nextCfg.channels = nextChannels;
          } else {
            delete nextCfg.channels;
          }
        }
      }
      
      const resolved = resolveQQAccount({
        cfg: changed ? nextCfg : cfg,
        accountId,
      });
      const loggedOut = !resolved.httpUrl;
      
      if (changed) {
        await getQQRuntime().config.writeConfigFile(nextCfg);
      }
      
      return { cleared, envToken: false, loggedOut };
    },
  },
};
