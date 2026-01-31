import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  detectNapCatQQ,
  installNapCatQQ,
  startNapCatQQ,
} from "../../../commands/napcat-install.js";
import {
  listQQAccountIds,
  resolveDefaultQQAccountId,
  resolveQQAccount,
} from "../../../qq/accounts.js";
import { formatDocsLink } from "../../../terminal/links.js";
import { formatCliCommand } from "../../../cli/command-format.js";
import type { WizardPrompter } from "../../../wizard/prompts.js";
import type { ChannelOnboardingAdapter, ChannelOnboardingDmPolicy } from "../onboarding-types.js";
import { addWildcardAllowFrom, promptAccountId } from "./helpers.js";
import type { RuntimeEnv } from "../../../runtime.js";

const channel = "qq" as const;

function setQQDmPolicy(cfg: OpenClawConfig, dmPolicy: DmPolicy) {
  const allowFrom =
    dmPolicy === "open" ? addWildcardAllowFrom(cfg.channels?.qq?.allowFrom) : undefined;
  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qq: {
        ...cfg.channels?.qq,
        dmPolicy,
        ...(allowFrom ? { allowFrom } : {}),
      },
    },
  };
}

async function noteQQSetupHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      "1) Install NapCatQQ following the official guide",
      "2) Start NapCatQQ and note the HTTP API URL (default: http://localhost:3000)",
      "3) Note the WebSocket URL (default: ws://localhost:3001)",
      "4) Configure access token if NapCatQQ requires authentication",
      `Docs: ${formatDocsLink("/qq")}`,
      "NapCatQQ Docs: https://napneko.github.io/",
    ].join("\n"),
    "NapCatQQ Setup",
  );
}

async function noteQQUserIdHelp(prompter: WizardPrompter): Promise<void> {
  await prompter.note(
    [
      `1) Start the gateway and check logs with \`${formatCliCommand("openclaw logs --follow")}\``,
      "2) Have someone message your QQ bot",
      "3) The user ID will appear in the logs as sender.user_id",
      `Docs: ${formatDocsLink("/qq")}`,
    ].join("\n"),
    "QQ user id",
  );
}

async function promptQQAllowFrom(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId: string;
}): Promise<OpenClawConfig> {
  const { cfg, prompter, accountId } = params;
  const resolved = resolveQQAccount({ cfg, accountId });
  const existingAllowFrom = resolved.config.allowFrom ?? [];
  await noteQQUserIdHelp(prompter);

  const parseInput = (value: string) =>
    value
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  let resolvedIds: string[] = [];
  while (resolvedIds.length === 0) {
    const entry = await prompter.text({
      message: "QQ allowFrom (QQ numbers)",
      placeholder: "123456789",
      initialValue: existingAllowFrom[0] ? String(existingAllowFrom[0]) : undefined,
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) return "Required";
        const parts = parseInput(trimmed);
        const invalid = parts.filter((p) => !/^\d+$/.test(p));
        if (invalid.length > 0) {
          return `Invalid QQ number(s): ${invalid.join(", ")}. Use numeric IDs only.`;
        }
        return undefined;
      },
    });
    const parts = parseInput(String(entry));
    resolvedIds = parts.filter((p) => /^\d+$/.test(p));
  }

  const merged = [
    ...existingAllowFrom.map((item) => String(item).trim()).filter(Boolean),
    ...resolvedIds,
  ];
  const unique = [...new Set(merged)];

  if (accountId === DEFAULT_ACCOUNT_ID) {
    return {
      ...cfg,
      channels: {
        ...cfg.channels,
        qq: {
          ...cfg.channels?.qq,
          enabled: true,
          dmPolicy: "allowlist",
          allowFrom: unique,
        },
      },
    };
  }

  return {
    ...cfg,
    channels: {
      ...cfg.channels,
      qq: {
        ...cfg.channels?.qq,
        enabled: true,
        accounts: {
          ...cfg.channels?.qq?.accounts,
          [accountId]: {
            ...cfg.channels?.qq?.accounts?.[accountId],
            enabled: cfg.channels?.qq?.accounts?.[accountId]?.enabled ?? true,
            dmPolicy: "allowlist",
            allowFrom: unique,
          },
        },
      },
    },
  };
}

async function promptQQAllowFromForAccount(params: {
  cfg: OpenClawConfig;
  prompter: WizardPrompter;
  accountId?: string;
}): Promise<OpenClawConfig> {
  const accountId =
    params.accountId && normalizeAccountId(params.accountId)
      ? (normalizeAccountId(params.accountId) ?? DEFAULT_ACCOUNT_ID)
      : resolveDefaultQQAccountId(params.cfg);
  return promptQQAllowFrom({
    cfg: params.cfg,
    prompter: params.prompter,
    accountId,
  });
}

const dmPolicy: ChannelOnboardingDmPolicy = {
  label: "QQ",
  channel,
  policyKey: "channels.qq.dmPolicy",
  allowFromKey: "channels.qq.allowFrom",
  getCurrent: (cfg) => cfg.channels?.qq?.dmPolicy ?? "pairing",
  setPolicy: (cfg, policy) => setQQDmPolicy(cfg, policy),
  promptAllowFrom: promptQQAllowFromForAccount,
};

export const qqOnboardingAdapter: ChannelOnboardingAdapter = {
  channel,
  getStatus: async ({ cfg }) => {
    const configured = listQQAccountIds(cfg).some((accountId) =>
      Boolean(resolveQQAccount({ cfg, accountId }).httpUrl),
    );
    return {
      channel,
      configured,
      statusLines: [`QQ: ${configured ? "configured" : "needs NapCatQQ setup"}`],
      selectionHint: configured ? "configured" : "requires NapCatQQ",
      quickstartScore: configured ? 1 : 20,
    };
  },
  configure: async ({
    cfg,
    prompter,
    accountOverrides,
    shouldPromptAccountIds,
    forceAllowFrom,
    runtime,
  }) => {
    const qqOverride = accountOverrides.qq?.trim();
    const defaultQQAccountId = resolveDefaultQQAccountId(cfg);
    let qqAccountId = qqOverride
      ? normalizeAccountId(qqOverride)
      : defaultQQAccountId;
    if (shouldPromptAccountIds && !qqOverride) {
      qqAccountId = await promptAccountId({
        cfg,
        prompter,
        label: "QQ",
        currentId: qqAccountId,
        listAccountIds: listQQAccountIds,
        defaultAccountId: defaultQQAccountId,
      });
    }

    let next = cfg;
    const resolvedAccount = resolveQQAccount({
      cfg: next,
      accountId: qqAccountId,
    });
    const accountConfigured = Boolean(resolvedAccount.httpUrl);

    // Check if NapCatQQ is already installed
    const existingInstall = runtime ? await detectNapCatQQ(runtime) : null;

    if (!accountConfigured && !existingInstall) {
      // Ask if user wants to auto-install NapCatQQ
      const autoInstall = await prompter.confirm({
        message: "NapCatQQ not detected. Would you like to auto-install it?",
        initialValue: true,
      });

      if (autoInstall && runtime) {
        await prompter.note(
          "OpenClaw will download and install NapCatQQ from GitHub. " +
            "This may take a few minutes depending on your network.",
          "Auto-installation",
        );

        const httpPort = 3000;
        const wsPort = 3001;

        const installResult = await installNapCatQQ(runtime, {
          httpPort,
          wsPort,
        });

        if (installResult.ok) {
          await prompter.note(
            `NapCatQQ ${installResult.version} installed successfully.\n` +
              `Configuration: ${installResult.configPath}\n` +
              `HTTP API: http://localhost:${httpPort}\n` +
              `WebSocket: ws://localhost:${wsPort}`,
            "Installation Complete",
          );

          // Ask if user wants to start NapCatQQ now
          const startNow = await prompter.confirm({
            message: "Start NapCatQQ now?",
            initialValue: true,
          });

          if (startNow && installResult.installPath) {
            const startResult = await startNapCatQQ(runtime, installResult.installPath);
            if (startResult.ok) {
              await prompter.note(
                `NapCatQQ started with PID ${startResult.pid}.\n` +
                  "You may need to scan a QR code with QQ mobile app to login.",
                "NapCatQQ Started",
              );
            } else {
              await prompter.note(
                `Failed to start NapCatQQ: ${startResult.error}\n` +
                  "You can start it manually later.",
                "Warning",
              );
            }
          }

          // Pre-fill the HTTP and WebSocket URLs
          next = {
            ...next,
            channels: {
              ...next.channels,
              qq: {
                ...next.channels?.qq,
                enabled: true,
                httpUrl: `http://localhost:${httpPort}`,
                wsUrl: `ws://localhost:${wsPort}`,
              },
            },
          };
        } else {
          await prompter.note(
            `Failed to install NapCatQQ: ${installResult.error}\n` +
              "Please install manually following the instructions.",
            "Installation Failed",
          );
          await noteQQSetupHelp(prompter);
        }
      } else {
        await noteQQSetupHelp(prompter);
      }
    } else if (existingInstall && !accountConfigured) {
      await prompter.note(
        `Existing NapCatQQ installation detected at: ${existingInstall}\n` +
          "Please provide the HTTP and WebSocket URLs.",
        "Existing Installation",
      );
    }

    // Get HTTP URL
    const currentHttpUrl = resolveQQAccount({ cfg: next, accountId: qqAccountId }).config
      .httpUrl;
    const httpUrl = await prompter.text({
      message: "NapCatQQ HTTP URL",
      placeholder: "http://localhost:3000",
      initialValue: currentHttpUrl ?? "http://localhost:3000",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) return "Required";
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
          return "Must start with http:// or https://";
        }
        return undefined;
      },
    });

    // Get WebSocket URL
    const currentWsUrl = resolveQQAccount({ cfg: next, accountId: qqAccountId }).config.wsUrl;
    const wsUrl = await prompter.text({
      message: "NapCatQQ WebSocket URL",
      placeholder: "ws://localhost:3001",
      initialValue: currentWsUrl ?? "ws://localhost:3001",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) return "Required";
        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
          return "Must start with ws:// or wss://";
        }
        return undefined;
      },
    });

    // Ask about access token
    const hasAccessToken = await prompter.confirm({
      message: "Does NapCatQQ require an access token?",
      initialValue: false,
    });

    let accessToken: string | undefined;
    if (hasAccessToken) {
      accessToken = String(
        await prompter.text({
          message: "Enter access token (leave empty to generate random)",
          initialValue: "",
        }),
      ).trim();

      // Generate random token if empty
      if (!accessToken) {
        accessToken = Math.random().toString(36).substring(2, 15);
        await prompter.note(
          `Generated random access token: ${accessToken}\n` +
            "Please update your NapCatQQ configuration to use this token.",
          "Access Token",
        );
      }
    }

    // Update config
    const accountConfig = {
      enabled: true,
      httpUrl: String(httpUrl).trim(),
      wsUrl: String(wsUrl).trim(),
      ...(accessToken ? { accessToken } : {}),
    };

    if (qqAccountId === DEFAULT_ACCOUNT_ID) {
      next = {
        ...next,
        channels: {
          ...next.channels,
          qq: {
            ...next.channels?.qq,
            ...accountConfig,
          },
        },
      };
    } else {
      next = {
        ...next,
        channels: {
          ...next.channels,
          qq: {
            ...next.channels?.qq,
            accounts: {
              ...next.channels?.qq?.accounts,
              [qqAccountId]: {
                ...next.channels?.qq?.accounts?.[qqAccountId],
                ...accountConfig,
              },
            },
          },
        },
      };
    }

    // Configure allowFrom if needed
    if (forceAllowFrom) {
      next = await promptQQAllowFrom({
        cfg: next,
        prompter,
        accountId: qqAccountId,
      });
    }

    return { cfg: next, accountId: qqAccountId };
  },
  dmPolicy,
  disable: (cfg) => ({
    ...cfg,
    channels: {
      ...cfg.channels,
      qq: { ...cfg.channels?.qq, enabled: false },
    },
  }),
};
