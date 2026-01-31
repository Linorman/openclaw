import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
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

    if (!accountConfigured) {
      await noteQQSetupHelp(prompter);
    }

    const httpUrl = await prompter.text({
      message: "NapCatQQ HTTP URL",
      placeholder: "http://localhost:3000",
      initialValue: resolvedAccount.config.httpUrl ?? "http://localhost:3000",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) return "Required";
        if (!trimmed.startsWith("http://") && !trimmed.startsWith("https://")) {
          return "Must start with http:// or https://";
        }
        return undefined;
      },
    });

    const wsUrl = await prompter.text({
      message: "NapCatQQ WebSocket URL",
      placeholder: "ws://localhost:3001",
      initialValue: resolvedAccount.config.wsUrl ?? "ws://localhost:3001",
      validate: (value) => {
        const trimmed = String(value ?? "").trim();
        if (!trimmed) return "Required";
        if (!trimmed.startsWith("ws://") && !trimmed.startsWith("wss://")) {
          return "Must start with ws:// or wss://";
        }
        return undefined;
      },
    });

    const hasAccessToken = await prompter.confirm({
      message: "Does NapCatQQ require an access token?",
      initialValue: Boolean(resolvedAccount.config.accessToken),
    });

    let accessToken: string | undefined;
    if (hasAccessToken) {
      accessToken = String(
        await prompter.text({
          message: "Enter access token",
          initialValue: resolvedAccount.config.accessToken ?? undefined,
          validate: (value) => (String(value ?? "").trim() ? undefined : "Required"),
        }),
      ).trim();
    }

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
