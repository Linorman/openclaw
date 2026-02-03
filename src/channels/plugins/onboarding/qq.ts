import os from "node:os";

import type { OpenClawConfig } from "../../../config/config.js";
import type { DmPolicy } from "../../../config/types.js";
import { DEFAULT_ACCOUNT_ID, normalizeAccountId } from "../../../routing/session-key.js";
import {
  checkNapCatLoginViaOneBot,
  checkNapCatWebUI,
  detectNapCatQQ,
  getCapturedNapCatQRCode,
  getNapCatQRCode,
  getNapCatStatus,
  installNapCatQQ,
  killExistingNapCat,
  readNapCatConfig,
  startNapCatQQ,
  waitForNapCatLogin,
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
  // Use OneBot HTTP API to check login status
  console.log(
    `[detectQQLinked] Port: ${onebotPort}, Token: ${accessToken ? accessToken.substring(0, 8) + "..." : "(none)"}`,
  );
  const result = await checkNapCatLoginViaOneBot(onebotPort, accessToken);

  console.log(
    `[detectQQLinked] Result: loggedIn=${result.loggedIn}, error=${result.error || "none"}`,
  );

  if (result.loggedIn && result.userId) {
    return {
      linked: true,
      nickname: result.nickname,
      qqNumber: result.userId,
    };
  }

  return { linked: false, error: result.error };
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
    // Check if httpUrl is explicitly configured (not the default from resolveQQAccount)
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
      console.log(
        `[getStatus] NapCat config: httpPort=${napCatConfig?.httpPort}, httpToken=${napCatConfig?.httpToken ? "(set)" : "(none)"}`,
      );
      if (napCatConfig?.httpPort) {
        const result = await detectQQLinked(napCatConfig.httpPort, napCatConfig.httpToken);
        console.log(
          `[getStatus] detectQQLinked result: linked=${result.linked}, error=${result.error || "none"}`,
        );
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
      return { cfg: next, accountId: qqAccountId };
    }

    // Step 1: Check NapCat installation
    let installPath = await detectNapCatQQ(runtime);

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
              `HTTP Token: ${installResult.httpToken ? "(configured)" : "(none)"}`,
              "HTTP API: http://localhost:3000",
              "WebSocket: ws://localhost:3001",
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

    // Step 2: Kill any existing NapCat processes and start fresh
    let webuiToken: string | undefined;
    let webuiPort = 6099;

    await prompter.note("Stopping any existing NapCat processes...", "QQ Setup");
    await killExistingNapCat();

    await prompter.note("Starting NapCatQQ...", "QQ Setup");
    const startResult = await startNapCatQQ(runtime, { killExisting: false });

    if (!startResult.ok) {
      await prompter.note(
        ["✗ Failed to start NapCatQQ:", startResult.error || "Unknown error"].join("\n"),
        "Error",
      );
      return { cfg: next, accountId: qqAccountId };
    }

    webuiToken = startResult.webuiToken;
    webuiPort = startResult.webuiPort ?? 6099;

    // Show port information if they were changed
    const portInfo = [];
    if (startResult.httpPort) portInfo.push(`HTTP: ${startResult.httpPort}`);
    if (startResult.wsPort) portInfo.push(`WS: ${startResult.wsPort}`);

    await prompter.note(
      `✓ NapCatQQ started (PID: ${startResult.pid})${portInfo.length > 0 ? `\nPorts: ${portInfo.join(", ")}` : ""}`,
      "QQ Setup",
    );

    // Step 3: Wait for NapCat to be fully ready
    await prompter.note("Waiting for NapCatQQ to initialize...", "QQ Setup");
    await new Promise((resolve) => setTimeout(resolve, 5000));

    // Check if WebUI is accessible
    let webuiCheck = await checkNapCatWebUI(webuiPort, webuiToken);
    let webuiAttempts = 0;
    while (!webuiCheck.accessible && webuiAttempts < 5) {
      webuiAttempts++;
      await new Promise((resolve) => setTimeout(resolve, 2000));
      webuiCheck = await checkNapCatWebUI(webuiPort, webuiToken);
    }

    // Read NapCat config (will use account-specific if available)
    let napCatConfig = await readNapCatConfig();

    // If no HTTP token is configured, generate one and update all configs
    console.log(
      `[configure] NapCat config before: httpToken=${napCatConfig?.httpToken ? "(set)" : "(none)"}`,
    );
    if (!napCatConfig?.httpToken) {
      const { updateNapCatConfig } = await import("../../../commands/napcat-install.js");
      const newToken =
        Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
      console.log(`[configure] Generating new HTTP token: ${newToken.substring(0, 8)}...`);

      // Update default config
      await updateNapCatConfig({ accessToken: newToken });

      // Also try to update account-specific configs if we can detect QQ numbers
      // For now, we update after detecting login

      // Re-read config to get updated token
      napCatConfig = await readNapCatConfig();
      console.log(
        `[configure] NapCat config after: httpToken=${napCatConfig?.httpToken ? "(set)" : "(none)"}`,
      );
    }

    const httpUrl = napCatConfig?.httpPort
      ? `http://localhost:${napCatConfig.httpPort}`
      : "http://localhost:3000";
    const wsUrl = napCatConfig?.wsPort
      ? `ws://localhost:${napCatConfig.wsPort}`
      : "ws://localhost:3001";
    const httpToken = napCatConfig?.httpToken;

    // Update config with endpoints and token
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

    // Step 4: Check if already logged in (via OneBot HTTP API)
    const httpPort = napCatConfig?.httpPort ?? 3000;
    console.log(
      `[configure] Checking login with port=${httpPort}, token=${httpToken ? httpToken.substring(0, 8) + "..." : "(none)"}`,
    );
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

      // Update account-specific NapCat config
      if (loginCheck.qqNumber && httpToken) {
        const { updateNapCatConfig } = await import("../../../commands/napcat-install.js");
        await updateNapCatConfig({
          qqNumber: loginCheck.qqNumber,
          httpPort,
          wsPort: napCatConfig?.wsPort ?? 3001,
          accessToken: httpToken,
        });
        console.log(`[configure] Updated NapCat config for QQ ${loginCheck.qqNumber}`);
      }
    } else {
      // Guide user through WebUI login
      const webuiUrl = `http://localhost:${webuiPort}/webui`;

      // Try to get QR code (first from logs, then from WebUI API)
      await prompter.note(["Fetching QR code for QQ login..."].join("\n"), "QQ Login");

      let qrDisplayed = false;
      let qrCode: string | undefined;

      // First, check if we captured QR code from logs
      const capturedQR = getCapturedNapCatQRCode();
      if (capturedQR) {
        qrCode = capturedQR;
      } else {
        // Fallback to WebUI API
        const qrResult = await getNapCatQRCode(webuiPort, webuiToken);
        if (qrResult.success && qrResult.qrCode) {
          qrCode = qrResult.qrCode;
        }
      }

      if (qrCode) {
        // Display QR code in terminal
        console.log("\n");
        console.log("╔══════════════════════════════════════════════════════════╗");
        console.log("║          Scan this QR code with QQ mobile app            ║");
        console.log("╚══════════════════════════════════════════════════════════╝");
        console.log("\n");

        // Import qrcode-terminal dynamically
        try {
          const qrcode = await import("qrcode-terminal");
          qrcode.default.generate(qrCode, { small: true });
          console.log("\n");
          qrDisplayed = true;
        } catch {
          // qrcode-terminal not available, show URL instead
          console.log("QR Code URL:");
          console.log(qrCode);
          console.log("\n");
          qrDisplayed = true;
        }
      }

      await prompter.note(
        [
          qrDisplayed ? "QR code displayed above." : "Please use WebUI to get QR code.",
          "",
          `WebUI URL: ${webuiUrl}`,
          webuiToken ? `Token: ${webuiToken}` : "",
          "",
          "Steps:",
          "1) Open the WebUI URL in your browser (if QR not shown above)",
          "2) Click 'QRCode' button",
          "3) Scan the QR code with QQ mobile app",
          "4) Confirm login on your phone",
          "5) Wait for this process to detect the login",
        ].join("\n"),
        "QQ Login Required",
      );

      // Wait for user to complete login with polling
      await prompter.note(
        "Waiting for QQ login (this may take 1-2 minutes)...",
        "Waiting for Login",
      );

      let loggedIn = false;
      let lastError = "";

      // Poll for login status via OneBot HTTP API
      console.log(
        `[configure] Starting login poll with httpToken=${httpToken ? httpToken.substring(0, 8) + "..." : "(none)"}`,
      );
      const pollResult = await waitForNapCatLogin(
        httpPort,
        httpToken,
        60, // 60 attempts * 3 seconds = 3 minutes max
        (attempt, result) => {
          // Update every 10 attempts
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

        // Update account-specific NapCat config with the logged-in QQ number
        if (pollResult.userId && httpToken) {
          const { updateNapCatConfig } = await import("../../../commands/napcat-install.js");
          await updateNapCatConfig({
            qqNumber: pollResult.userId,
            httpPort,
            wsPort: napCatConfig?.wsPort ?? 3001,
            accessToken: httpToken,
          });
          console.log(`[configure] Updated NapCat config for QQ ${pollResult.userId}`);
        }
      } else {
        // Timed out, ask user to confirm
        await prompter.note(
          [
            "Automatic login detection timed out.",
            "",
            "This can happen if:",
            "- QQ login is still processing",
            "- NapCat WebUI is not responding",
            "",
            lastError ? `Last error: ${lastError}` : "",
          ].join("\n"),
          "Login Check",
        );

        const manualConfirm = await prompter.confirm({
          message: "Have you completed QQ login in WebUI?",
          initialValue: false,
        });

        if (manualConfirm) {
          // Try a few more times using OneBot API
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

              // Update account-specific NapCat config
              if (verifyResult.qqNumber && httpToken) {
                const { updateNapCatConfig } = await import("../../../commands/napcat-install.js");
                await updateNapCatConfig({
                  qqNumber: verifyResult.qqNumber,
                  httpPort,
                  wsPort: napCatConfig?.wsPort ?? 3001,
                  accessToken: httpToken,
                });
                console.log(`[configure] Updated NapCat config for QQ ${verifyResult.qqNumber}`);
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
                "1) You scanned the QR code in WebUI",
                "2) You confirmed login on your phone",
                "3) WebUI shows QQ as 'online'",
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
            "You can complete login later:",
            `1) Open ${webuiUrl}`,
            "2) Click QRCode and scan with QQ mobile app",
            `3) Run ${formatCliCommand("openclaw onboard")} again to verify`,
            "",
            "Configuration has been saved.",
          ].join("\n"),
          "Incomplete Setup",
        );
        return { cfg: next, accountId: qqAccountId };
      }
    }

    // Step 5: Configure allowFrom
    if (forceAllowFrom) {
      next = await promptQQAllowFrom({
        cfg: next,
        prompter,
        accountId: qqAccountId,
      });
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
