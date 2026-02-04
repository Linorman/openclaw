/**
 * NapCat Installation Commands
 *
 * This module provides NapCat installation functionality.
 * For lifecycle management, use src/qq/napcat-lifecycle.ts instead.
 *
 * @deprecated Many functions have been moved to src/qq/napcat-lifecycle.ts
 */

import type { RuntimeEnv } from "../runtime.js";

// Re-export everything from the new lifecycle module for backward compatibility
export {
  // Types
  type NapCatInstallResult,
  type NapCatStatus,
  type NapCatStartResult,
  type QuickLoginItem,
  // Installation
  installNapCatQQ,
  // Detection and status
  detectNapCatQQ,
  getNapCatStatus,
  // Lifecycle management
  startNapCatQQ,
  stopNapCatQQ,
  killExistingNapCat,
  // Configuration
  readNapCatConfig,
  updateNapCatConfig,
  // QR Code
  getCapturedQRCode as getCapturedNapCatQRCode,
  resetQRCodeCapture,
  waitForQRCode as waitForNapCatQRCode,
  // Port management
  isPortAvailable,
  findAvailablePorts,
  // Login API
  checkNapCatLoginViaOneBot,
  waitForNapCatLogin,
  // WebUI API
  getNapCatQuickLoginList,
  setNapCatQuickLogin,
} from "../qq/napcat-lifecycle.js";

// Import for local use
import {
  installNapCatQQ as installNapCatQQInternal,
  detectNapCatQQ,
  startNapCatQQ,
  stopNapCatQQ,
  getNapCatStatus,
  type NapCatInstallResult,
} from "../qq/napcat-lifecycle.js";

/**
 * Install NapCatQQ interactively
 * This is a convenience wrapper for CLI usage
 */
export async function installNapCatInteractive(
  runtime: RuntimeEnv,
  options?: {
    httpPort?: number;
    wsPort?: number;
    accessToken?: string;
  },
): Promise<NapCatInstallResult> {
  runtime.log("Starting NapCatQQ installation...");

  // Check if already installed
  const existingPath = await detectNapCatQQ();
  if (existingPath) {
    runtime.log(`NapCatQQ is already installed at: ${existingPath}`);
    const status = await getNapCatStatus();
    if (status.running) {
      runtime.log(`NapCatQQ is currently running (PID: ${status.pid})`);
    }
  }

  // Run installation
  const result = await installNapCatQQInternal(runtime, options);

  if (result.ok) {
    runtime.log("✓ NapCatQQ installed successfully!");
    runtime.log(`  Location: ${result.installPath}`);
    runtime.log(`  Config: ${result.configPath}`);
    runtime.log(`  HTTP API: http://localhost:${result.httpPort}`);
    runtime.log(`  WebSocket: ws://localhost:${result.wsPort}`);
    if (result.webuiPort) {
      runtime.log(`  WebUI: http://localhost:${result.webuiPort}`);
    }
  } else {
    runtime.log(`✗ Installation failed: ${result.error}`);
  }

  return result;
}

/**
 * Start NapCatQQ interactively
 * This is a convenience wrapper for CLI usage
 */
export async function startNapCatInteractive(
  runtime: RuntimeEnv,
  options?: {
    qqNumber?: string;
    waitForQrCode?: boolean;
  },
): Promise<{ ok: boolean; error?: string }> {
  runtime.log("Starting NapCatQQ...");

  const result = await startNapCatQQ(runtime, {
    killExisting: true,
    waitForQrCode: options?.waitForQrCode ?? false,
  });

  if (result.ok) {
    runtime.log("✓ NapCatQQ started successfully!");
    if (result.pid) {
      runtime.log(`  Screen PID: ${result.pid}`);
    }
    if (result.httpPort) {
      runtime.log(`  HTTP Port: ${result.httpPort}`);
    }
    if (result.wsPort) {
      runtime.log(`  WebSocket Port: ${result.wsPort}`);
    }
    if (result.webuiPort) {
      runtime.log(`  WebUI: http://localhost:${result.webuiPort}`);
    }
    if (result.qrCode) {
      runtime.log("  QR Code captured (use --show-qr to display)");
    }
  } else {
    runtime.log(`✗ Failed to start: ${result.error}`);
  }

  return { ok: result.ok, error: result.error };
}

/**
 * Stop NapCatQQ interactively
 * This is a convenience wrapper for CLI usage
 */
export async function stopNapCatInteractive(
  runtime: RuntimeEnv,
): Promise<{ ok: boolean; error?: string }> {
  runtime.log("Stopping NapCatQQ...");

  const result = await stopNapCatQQ();

  if (result.ok) {
    runtime.log("✓ NapCatQQ stopped successfully!");
  } else {
    runtime.log(`✗ Failed to stop: ${result.error}`);
  }

  return result;
}

/**
 * Get NapCatQQ status in a format suitable for CLI display
 */
export async function getNapCatStatusForCLI(
  _runtime: RuntimeEnv,
): Promise<{ installed: boolean; running: boolean; details: string[] }> {
  const status = await getNapCatStatus();
  const details: string[] = [];

  if (status.installed) {
    details.push(`Installation: ${status.installPath || "Unknown"}`);
    details.push(`Status: ${status.running ? "Running" : "Stopped"}`);
    if (status.running && status.pid) {
      details.push(`PID: ${status.pid}`);
    }
  } else {
    details.push("NapCatQQ is not installed");
  }

  return {
    installed: status.installed,
    running: status.running,
    details,
  };
}

// Legacy exports for backward compatibility
/** @deprecated Use getCapturedQRCode from napcat-lifecycle instead */
export async function getNapCatQRCode(
  _webuiPort: number = 6099,
  _webuiToken?: string,
): Promise<{ success: boolean; qrCode?: string; message?: string }> {
  // This function was previously used to fetch QR code from WebUI API
  // Now we capture it from logs, so this is a compatibility shim
  const { getCapturedQRCode } = await import("../qq/napcat-lifecycle.js");
  const qr = getCapturedQRCode();
  if (qr) {
    return { success: true, qrCode: qr };
  }
  return { success: false, message: "No QR code captured yet" };
}

/** @deprecated Use checkNapCatLoginViaOneBot instead */
export async function checkNapCatLogin(
  _webuiPort: number = 6099,
  _webuiToken?: string,
): Promise<{ loggedIn: boolean; userId?: string; nickname?: string; error?: string }> {
  // Redirect to OneBot API
  const { readNapCatConfig, checkNapCatLoginViaOneBot } = await import("../qq/napcat-lifecycle.js");
  const config = await readNapCatConfig();
  return checkNapCatLoginViaOneBot(config?.httpPort ?? 3000, config?.httpToken);
}

/** @deprecated Use WebUI API directly if needed */
export async function checkNapCatWebUI(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ accessible: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5000);

    const response = await fetch(`http://localhost:${webuiPort}/api/test`, {
      method: "GET",
      ...(webuiToken && { headers: { Authorization: `Bearer ${webuiToken}` } }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (response.ok) {
      return { accessible: true };
    }
    return { accessible: false, error: `HTTP ${response.status}` };
  } catch (error) {
    return {
      accessible: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

/** @deprecated Use getNapCatQuickLoginList instead */
export async function getNapCatQQLoginInfo(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ success: boolean; userId?: string; nickname?: string; error?: string }> {
  const { getNapCatQuickLoginList } = await import("../qq/napcat-lifecycle.js");
  const result = await getNapCatQuickLoginList(webuiPort, webuiToken);

  if (result.success && result.list && result.list.length > 0) {
    const first = result.list[0];
    return {
      success: true,
      userId: first.uin,
      nickname: first.nickName,
    };
  }

  return {
    success: false,
    error: result.error || "No login info available",
  };
}
