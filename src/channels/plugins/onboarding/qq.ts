import os from "node:os";

import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  checkNapCatLoginViaOneBot,
  detectNapCatQQ,
  installNapCatQQ,
  killExistingNapCat,
  readNapCatConfig,
  startNapCatQQ,
  updateNapCatConfig,
  waitForNapCatLogin,
  type NapCatStartResult,
} from "../../../qq/napcat-lifecycle.js";
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

async function detectQQLinked(
  onebotPort: number,
  accessToken?: string,
): Promise<{ linked: boolean; nickname?: string; qqNumber?: string; error?: string }> {
  const result = await checkNapCatLoginViaOneBot(onebotPort, accessToken);

  if (result.loggedIn && result.userId) {
    return {
      linked: true,
      nickname: result.nickname,
      qqNumber: result.userId,
    };
  }

  return { linked: false, error: result.error };
}

/**
 * Display QR code in terminal
 */
async function displayQRCodeInTerminal(qrCode: string, prompter: WizardPrompter): Promise<void> {
  console.log("\n");
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║          Scan this QR code with QQ mobile app            ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log("\n");

  // Try to display QR code using qrcode-terminal
  try {
    const qrcode = await import("qrcode-terminal");
    qrcode.default.generate(qrCode, { small: true });
    console.log("\n");
  } catch {
    // Fallback: show URL
    console.log("QR Code URL:");
    console.log(qrCode);
    console.log("\n");
  }

  await prompter.note(
    [
      "Please scan the QR code above with your QQ mobile app.",
      "",
      "Steps:",
      "1) Open QQ on your phone",
      "2) Tap the '+' icon and select 'Scan'",
      "3) Scan the QR code displayed above",
      "4) Confirm login on your phone",
      "",
      `Need help? ${formatDocsLink("/qq")}`,
    ].join("\n"),
    "QQ Login",
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

  await prompter.note(
    [
      "We need your QQ number to allowlist you as the owner.",
      "You can find this in your QQ mobile app profile.",
      `Docs: ${formatDocsLink("/qq")}`,
    ].join("\n"),
    "QQ Owner Number",
  );

  const parseInput = (value: string) =>
    value
      .split(/[\n,;]+/g)
      .map((entry) => entry.trim())
      .filter(Boolean);

  let resolvedIds: string[] = [];
  while (resolvedIds.length === 0) {
    const entry = await prompter.text({
      message: "Your QQ number (for allowlist)",
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
    // Check if httpUrl is explicitly configured
    const qqConfig = cfg.channels?.qq;
    const hasExplicitHttpUrl = Boolean(qqConfig?.httpUrl?.trim());
    const hasAccountWithHttpUrl = Object.values(qqConfig?.accounts || {}).some((account) =>
      Boolean(account && typeof account === "object" && account.httpUrl?.trim()),
    );
    const hasConfig = hasExplicitHttpUrl || hasAccountWithHttpUrl;

    // Check if actually linked (logged in) via OneBot HTTP API
    let linked = false;
    if (hasConfig) {
      const napCatConfig = await readNapCatConfig();
      if (napCatConfig?.httpPort) {
        const result = await detectQQLinked(napCatConfig.httpPort, napCatConfig.httpToken);
        linked = result.linked;
      }
    }

    return {
      channel,
      configured: linked,
      statusLines: [
        `QQ: ${linked ? "linked" : hasConfig ? "configured but not linked" : "not configured"}`,
      ],
      selectionHint: linked ? "linked" : hasConfig ? "configured" : "not linked",
      quickstartScore: linked ? 10 : hasConfig ? 5 : 20,
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
    let qqAccountId = qqOverride ? normalizeAccountId(qqOverride) : defaultQQAccountId;
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

    // Ensure account exists in config
    if (qqAccountId !== DEFAULT_ACCOUNT_ID) {
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
                enabled: next.channels?.qq?.accounts?.[qqAccountId]?.enabled ?? true,
              },
            },
          },
        },
      };
    }

    if (!runtime) {
      await prompter.note(
        [
          "QQ onboarding requires a runtime environment.",
          "Please run this command from an interactive session.",
        ].join("\n"),
        "QQ Setup",
      );
      await killExistingNapCat();
      return { cfg: next, accountId: qqAccountId };
    }

    // Step 1: Check NapCat installation
    let installPath = await detectNapCatQQ();

    if (!installPath && os.platform() === "linux") {
      // Auto-install NapCat on Linux
      await prompter.note(
        [
          "NapCatQQ is not installed.",
          "OpenClaw can automatically install it for you.",
          "",
          "This will:",
          "  1) Install system dependencies (requires sudo)",
          "  2) Download and install Linux QQ",
          "  3) Download and install NapCatQQ",
          "  4) Configure OneBot services",
        ].join("\n"),
        "NapCatQQ Installation",
      );

      const installConfirm = await prompter.confirm({
        message: "Install NapCatQQ automatically?",
        initialValue: true,
      });

      if (installConfirm) {
        const installResult = await installNapCatQQ(runtime, {
          httpPort: 3000,
          wsPort: 3001,
        });

        if (installResult.ok) {
          await prompter.note(
            [
              "✓ NapCatQQ installed successfully!",
              "",
              `Location: ${installResult.installPath}`,
              `Config: ${installResult.configPath}`,
              `HTTP API: http://localhost:${installResult.httpPort}`,
              `WebSocket: ws://localhost:${installResult.wsPort}`,
            ].join("\n"),
            "Installation Complete",
          );
          installPath = installResult.installPath ?? null;
        } else {
          await prompter.note(
            [
              "✗ Installation failed:",
              installResult.error || "Unknown error",
              "",
              "Please install manually:",
              "https://napneko.github.io/",
            ].join("\n"),
            "Installation Failed",
          );
          await killExistingNapCat();
          return { cfg: next, accountId: qqAccountId };
        }
      } else {
        await prompter.note(
          [
            "NapCatQQ is required for QQ support.",
            "",
            "To install manually:",
            "https://napneko.github.io/",
            "",
            `Or run ${formatCliCommand("openclaw onboard")} again and choose to auto-install.`,
          ].join("\n"),
          "QQ Setup",
        );
        await killExistingNapCat();
        return { cfg: next, accountId: qqAccountId };
      }
    } else if (!installPath) {
      await prompter.note(
        [
          "NapCatQQ is not installed.",
          "",
          "Automatic installation is only available on Linux.",
          "Please install NapCatQQ manually:",
          "https://napneko.github.io/",
        ].join("\n"),
        "QQ Setup",
      );
      return { cfg: next, accountId: qqAccountId };
    }

    // Step 2: Stop any existing NapCat and start fresh
    await prompter.note("Preparing NapCatQQ...", "QQ Setup");
    await killExistingNapCat();

    await prompter.note("Starting NapCatQQ...", "QQ Setup");
    const startResult: NapCatStartResult = await startNapCatQQ(runtime, {
      killExisting: false,
      waitForQrCode: true,
    });

    if (!startResult.ok) {
      await prompter.note(
        ["✗ Failed to start NapCatQQ:", startResult.error || "Unknown error"].join("\n"),
        "Error",
      );
      await killExistingNapCat();
      return { cfg: next, accountId: qqAccountId };
    }

    // Show startup info
    const portInfo = [];
    if (startResult.httpPort) portInfo.push(`HTTP: ${startResult.httpPort}`);
    if (startResult.wsPort) portInfo.push(`WS: ${startResult.wsPort}`);

    await prompter.note(
      `✓ NapCatQQ started${portInfo.length > 0 ? `\nPorts: ${portInfo.join(", ")}` : ""}`,
      "QQ Setup",
    );

    // Step 3: Ensure HTTP token is configured
    let napCatConfig = await readNapCatConfig();

    if (!napCatConfig?.httpToken) {
      const newToken = generateSecureToken();
      runtime.log(`[QQ Onboarding] Generating new HTTP token`);

      await updateNapCatConfig({
        httpPort: startResult.httpPort ?? 3000,
        wsPort: startResult.wsPort ?? 3001,
        accessToken: newToken,
      });

      // Re-read config
      napCatConfig = await readNapCatConfig();
    }

    const httpUrl = napCatConfig?.httpPort
      ? `http://localhost:${napCatConfig.httpPort}`
      : "http://localhost:3000";
    const wsUrl = napCatConfig?.wsPort
      ? `ws://localhost:${napCatConfig.wsPort}`
      : "ws://localhost:3001";
    const httpToken = napCatConfig?.httpToken;

    // Update config with endpoints
    const accountConfig: Record<string, unknown> = {
      enabled: true,
      httpUrl,
      wsUrl,
      accessToken: httpToken,
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

    // Step 4: Check if already logged in
    const httpPort = napCatConfig?.httpPort ?? 3000;
    const loginCheck = await detectQQLinked(httpPort, httpToken);

    if (loginCheck.linked) {
      await prompter.note(
        [
          `✓ QQ is already logged in!`,
          "",
          `QQ Number: ${loginCheck.qqNumber}`,
          `Nickname: ${loginCheck.nickname || "Unknown"}`,
        ].join("\n"),
        "QQ Linked",
      );

      // Update config with QQ number
      if (loginCheck.qqNumber && httpToken) {
        await updateNapCatConfig({
          qqNumber: loginCheck.qqNumber,
          httpPort,
          wsPort: napCatConfig?.wsPort ?? 3001,
          accessToken: httpToken,
        });
      }
    } else {
      // Need to login - display QR code
      if (startResult.qrCode) {
        await displayQRCodeInTerminal(startResult.qrCode, prompter);
      } else {
        await prompter.note(
          [
            "QR code not yet available.",
            "",
            "Please use NapCat WebUI to login:",
            `http://localhost:${startResult.webuiPort ?? 6099}/webui`,
            startResult.webuiToken ? `Token: ${startResult.webuiToken}` : "",
          ].join("\n"),
          "QQ Login Required",
        );
      }

      // Wait for user to complete login
      await prompter.note("Waiting for QQ login...", "Waiting for Login");

      let loggedIn = false;
      let lastError = "";

      const pollResult = await waitForNapCatLogin(
        httpPort,
        httpToken,
        60, // 60 attempts * 3 seconds = 3 minutes max
        (attempt, result) => {
          if (attempt % 10 === 0 && runtime) {
            runtime.log(`Login check ${attempt}/60... ${result.error || "waiting"}`);
          }
          if (result.error && result.error !== lastError) {
            lastError = result.error;
          }
        },
      );

      if (pollResult.success) {
        loggedIn = true;
        await prompter.note(
          [
            "✓ QQ login successful!",
            "",
            `QQ Number: ${pollResult.userId}`,
            `Nickname: ${pollResult.nickname || "Unknown"}`,
          ].join("\n"),
          "Login Success",
        );

        // Update account-specific NapCat config
        if (pollResult.userId && httpToken) {
          await updateNapCatConfig({
            qqNumber: pollResult.userId,
            httpPort,
            wsPort: napCatConfig?.wsPort ?? 3001,
            accessToken: httpToken,
          });
        }
      } else {
        // Timed out
        await prompter.note(
          [
            "Automatic login detection timed out.",
            "",
            "This can happen if:",
            "- QQ login is still processing",
            "- NapCat WebUI is not responding",
            lastError ? `\nLast error: ${lastError}` : "",
          ].join("\n"),
          "Login Check",
        );

        const manualConfirm = await prompter.confirm({
          message: "Have you completed QQ login?",
          initialValue: false,
        });

        if (manualConfirm) {
          // Try a few more times
          for (let i = 0; i < 5; i++) {
            const verifyResult = await detectQQLinked(httpPort, httpToken);
            if (verifyResult.linked) {
              loggedIn = true;
              await prompter.note(
                [
                  "✓ QQ login verified!",
                  "",
                  `QQ Number: ${verifyResult.qqNumber}`,
                  `Nickname: ${verifyResult.nickname || "Unknown"}`,
                ].join("\n"),
                "Success",
              );

              if (verifyResult.qqNumber && httpToken) {
                await updateNapCatConfig({
                  qqNumber: verifyResult.qqNumber,
                  httpPort,
                  wsPort: napCatConfig?.wsPort ?? 3001,
                  accessToken: httpToken,
                });
              }

              break;
            }
            await new Promise((resolve) => setTimeout(resolve, 2000));
          }

          if (!loggedIn) {
            await prompter.note(
              [
                "✗ QQ login not detected.",
                "",
                "Please make sure:",
                "1) You scanned the QR code",
                "2) You confirmed login on your phone",
              ].join("\n"),
              "Not Linked",
            );
          }
        }
      }

      if (!loggedIn) {
        await prompter.note(
          [
            "QQ login was not completed.",
            "",
            "You can complete login later by visiting:",
            `http://localhost:${startResult.webuiPort ?? 6099}/webui`,
            "",
            "Configuration has been saved.",
          ].join("\n"),
          "Incomplete Setup",
        );
        // Keep NapCat running for user to complete login
        return { cfg: next, accountId: qqAccountId };
      }
    }

    // Step 5: Configure allowFrom
    if (!forceAllowFrom) {
      const shouldConfigureAllowFrom = await prompter.confirm({
        message: "Configure QQ owner allowlist now?",
        initialValue: true,
      });
      if (shouldConfigureAllowFrom) {
        next = await promptQQAllowFrom({
          cfg: next,
          prompter,
          accountId: qqAccountId,
        });
      }
    }

    await prompter.note(
      [
        "✓ QQ channel setup complete!",
        "",
        `Configuration saved for account: ${qqAccountId}`,
        "",
        `Test it: ${formatCliCommand("openclaw message send qq:<your-qq-number> 'Hello from OpenClaw'")}`,
      ].join("\n"),
      "Setup Complete",
    );

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

/**
 * Generate a secure random token
 */
function generateSecureToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}
