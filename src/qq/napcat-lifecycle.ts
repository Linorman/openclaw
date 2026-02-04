/**
 * NapCat Lifecycle Management
 *
 * This module manages NapCat/QQ lifecycle, ensuring it starts and stops
 * together with the gateway. It provides:
 * - Installation and setup
 * - Lifecycle management (start/stop with gateway)
 * - QR code capture and display for login
 * - Login status monitoring
 */

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";

import type { RuntimeEnv } from "../runtime.js";
import { runCommandWithTimeout, runExec } from "../process/exec.js";
import { CONFIG_DIR } from "../utils.js";

// NapCat installation paths
const NAPCAT_BASE_DIR = path.join(os.homedir(), "Napcat");
const QQ_BASE_PATH = path.join(NAPCAT_BASE_DIR, "opt", "QQ");
const QQ_EXECUTABLE = path.join(QQ_BASE_PATH, "qq");
const QQ_PACKAGE_JSON_PATH = path.join(QQ_BASE_PATH, "resources", "app", "package.json");
const NAPCAT_FOLDER = path.join(QQ_BASE_PATH, "resources", "app", "app_launcher", "napcat");
const NAPCAT_CONFIG_DIR = path.join(NAPCAT_FOLDER, "config");

const OPENCLAW_NAPCAT_DIR = path.join(CONFIG_DIR, "tools", "napcatqq");
const NAPCAT_SCREEN_NAME = "openclaw-napcat";
const NAPCAT_LOG_DIR = path.join(CONFIG_DIR, "logs");

// QR Code capture state
let capturedQRCode: string | null = null;
let qrCodePromise: Promise<string | null> | null = null;
let qrCodeResolver: ((qr: string | null) => void) | null = null;

export type NapCatInstallResult = {
  ok: boolean;
  installPath?: string;
  qqPath?: string;
  version?: string;
  configPath?: string;
  webuiToken?: string;
  webuiPort?: number;
  httpPort?: number;
  wsPort?: number;
  httpToken?: string;
  error?: string;
};

export type NapCatStatus = {
  installed: boolean;
  running: boolean;
  version?: string;
  installPath?: string;
  configPath?: string;
  pid?: number;
};

export type NapCatStartResult = {
  ok: boolean;
  pid?: number;
  webuiToken?: string;
  webuiPort?: number;
  httpPort?: number;
  wsPort?: number;
  qrCode?: string | null;
  error?: string;
};

type ReleaseAsset = {
  name?: string;
  browser_download_url?: string;
};

type NamedAsset = {
  name: string;
  browser_download_url: string;
};

type ReleaseResponse = {
  tag_name?: string;
  assets?: ReleaseAsset[];
};

// ============================================================================
// File System Helpers
// ============================================================================

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureDir(dirPath: string): Promise<void> {
  await fs.mkdir(dirPath, { recursive: true });
}

// ============================================================================
// Package Manager Helpers
// ============================================================================

async function detectPackageManager(): Promise<"apt" | "dnf" | null> {
  try {
    await runExec("which", ["apt-get"], 5000);
    return "apt";
  } catch {}
  try {
    await runExec("which", ["dnf"], 5000);
    return "dnf";
  } catch {}
  return null;
}

async function detectPackageInstaller(): Promise<"dpkg" | "rpm" | null> {
  try {
    await runExec("which", ["dpkg"], 5000);
    return "dpkg";
  } catch {}
  try {
    await runExec("which", ["rpm"], 5000);
    return "rpm";
  } catch {}
  return null;
}

// ============================================================================
// Network and Download Helpers
// ============================================================================

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
  const { request } = await import("node:https");
  await new Promise<void>((resolve, reject) => {
    const options = new URL(url);
    const req = request(options, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400) {
        const location = res.headers.location;
        if (!location || maxRedirects <= 0) {
          reject(new Error("Redirect loop or missing Location header"));
          return;
        }
        const redirectUrl = new URL(location, url).href;
        resolve(downloadToFile(redirectUrl, dest, maxRedirects - 1));
        return;
      }
      if (!res.statusCode || res.statusCode >= 400) {
        reject(new Error(`HTTP ${res.statusCode ?? "?"} downloading file`));
        return;
      }
      const out = createWriteStream(dest);
      pipeline(res, out).then(resolve).catch(reject);
    });
    req.on("error", reject);
    req.end();
  });
}

async function findWorkingProxy(): Promise<string | null> {
  const proxies = [
    "https://ghfast.top",
    "https://gh.wuliya.xin",
    "https://gh-proxy.com",
    "https://github.moeyy.xyz",
  ];
  const checkUrl = "https://raw.githubusercontent.com/NapNeko/NapCatQQ/main/package.json";

  for (const proxy of proxies) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      const response = await fetch(`${proxy}/${checkUrl}`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      if (response.ok) {
        return proxy;
      }
    } catch {
      // Continue to next proxy
    }
  }
  return null;
}

// ============================================================================
// Port Management
// ============================================================================

export async function isPortAvailable(port: number): Promise<boolean> {
  try {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn("ss", ["-tln"], { stdio: ["ignore", "pipe", "ignore"] });
      let output = "";
      proc.stdout?.on("data", (data) => {
        output += data.toString();
      });
      proc.on("close", () => {
        const portInUse = output.includes(`:${port}`);
        resolve(!portInUse);
      });
      proc.on("error", () => resolve(true));
      setTimeout(() => {
        proc.kill();
        resolve(true);
      }, 2000);
    });
  } catch {
    return true;
  }
}

export async function findAvailablePorts(
  preferredHttpPort: number = 3000,
  preferredWsPort: number = 3001,
): Promise<{ httpPort: number; wsPort: number }> {
  let httpPort = preferredHttpPort;
  let wsPort = preferredWsPort;

  while (!(await isPortAvailable(httpPort))) {
    httpPort++;
    if (httpPort > 65535) throw new Error("No available ports for HTTP");
  }

  while (!(await isPortAvailable(wsPort)) || wsPort === httpPort) {
    wsPort++;
    if (wsPort > 65535) throw new Error("No available ports for WebSocket");
  }

  return { httpPort, wsPort };
}

// ============================================================================
// System Dependencies
// ============================================================================

async function checkXvfbAvailable(): Promise<boolean> {
  try {
    const { spawn } = await import("node:child_process");
    return new Promise((resolve) => {
      const proc = spawn("xvfb-run", ["--help"], { stdio: "ignore" });
      proc.on("error", () => resolve(false));
      proc.on("exit", (code) => resolve(code === 0));
      setTimeout(() => {
        proc.kill();
        resolve(false);
      }, 2000);
    });
  } catch {
    return false;
  }
}

async function installSystemDependencies(
  runtime: RuntimeEnv,
  packageManager: "apt" | "dnf",
): Promise<boolean> {
  try {
    runtime.log("[NapCat] Installing system dependencies...");

    if (packageManager === "apt") {
      try {
        await runCommandWithTimeout(["sudo", "apt-get", "update", "-y", "-qq"], {
          timeoutMs: 60_000,
        });
      } catch {
        runtime.log("[NapCat] Warning: Failed to update package list, continuing...");
      }

      const packages = [
        "zip",
        "unzip",
        "jq",
        "curl",
        "xvfb",
        "screen",
        "xauth",
        "procps",
        "g++",
        "libnss3",
        "libgbm1",
        "libasound2",
      ];

      await runCommandWithTimeout(["sudo", "apt-get", "install", "-y", "-qq", ...packages], {
        timeoutMs: 300_000,
      });
    } else if (packageManager === "dnf") {
      try {
        await runCommandWithTimeout(["sudo", "dnf", "install", "-y", "epel-release"], {
          timeoutMs: 60_000,
        });
      } catch {}

      const packages = [
        "zip",
        "unzip",
        "jq",
        "curl",
        "xorg-x11-server-Xvfb",
        "screen",
        "procps-ng",
        "gcc-c++",
        "nss",
        "mesa-libgbm",
        "alsa-lib",
      ];

      await runCommandWithTimeout(["sudo", "dnf", "install", "--allowerasing", "-y", ...packages], {
        timeoutMs: 300_000,
      });
    }

    runtime.log("[NapCat] System dependencies installed successfully");
    return true;
  } catch (error) {
    runtime.log(
      `[NapCat] Failed to install dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ============================================================================
// Configuration Generation
// ============================================================================

function generateSecureToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

function generateNapCatOneBotConfig(
  httpPort: number = 3000,
  wsPort: number = 3001,
  accessToken?: string,
): object {
  return {
    network: {
      httpServers: [
        {
          name: "httpServer",
          enable: true,
          port: httpPort,
          host: "0.0.0.0",
          enableCors: true,
          enableWebsocket: false,
          messagePostFormat: "array",
          token: accessToken || "",
          debug: false,
        },
      ],
      httpClients: [],
      websocketServers: [
        {
          name: "WsServer",
          enable: true,
          host: "0.0.0.0",
          port: wsPort,
          messagePostFormat: "array",
          reportSelfMessage: false,
          token: accessToken || "",
          enableForcePushEvent: true,
          debug: false,
          heartInterval: 30000,
        },
      ],
      websocketClients: [],
    },
    musicSignUrl: "",
    enableLocalFile2Url: false,
    parseMultMsg: false,
  };
}

function generateWebUIConfig(): { host: string; port: number; token: string; loginRate: number } {
  return {
    host: "0.0.0.0",
    port: 6099,
    token: generateSecureToken(),
    loginRate: 3,
  };
}

// ============================================================================
// Linux QQ Installation
// ============================================================================

function getLinuxQQDownloadUrl(arch: string, installer: "dpkg" | "rpm"): string | null {
  const version = "3.2.20-40990";

  if (arch === "amd64") {
    if (installer === "rpm") {
      return `https://dldir1.qq.com/qqfile/qq/QQNT/ec800879/linuxqq_${version}_x86_64.rpm`;
    }
    return `https://dldir1.qq.com/qqfile/qq/QQNT/ec800879/linuxqq_${version}_amd64.deb`;
  }

  if (arch === "arm64") {
    if (installer === "rpm") {
      return `https://dldir1.qq.com/qqfile/qq/QQNT/ec800879/linuxqq_${version}_aarch64.rpm`;
    }
    return `https://dldir1.qq.com/qqfile/qq/QQNT/ec800879/linuxqq_${version}_arm64.deb`;
  }

  return null;
}

async function installLinuxQQ(
  runtime: RuntimeEnv,
  tmpDir: string,
  arch: string,
  installer: "dpkg" | "rpm",
  _packageManager: "apt" | "dnf",
): Promise<boolean> {
  try {
    const downloadUrl = getLinuxQQDownloadUrl(arch, installer);
    if (!downloadUrl) {
      runtime.log("[NapCat] Unsupported architecture for Linux QQ");
      return false;
    }

    const filename = installer === "rpm" ? "QQ.rpm" : "QQ.deb";
    const packagePath = path.join(tmpDir, filename);

    runtime.log(`[NapCat] Downloading Linux QQ...`);
    await downloadToFile(downloadUrl, packagePath);

    // Clean old installation
    if (await fileExists(NAPCAT_BASE_DIR)) {
      runtime.log("[NapCat] Removing old NapCat installation...");
      await fs.rm(NAPCAT_BASE_DIR, { recursive: true, force: true });
    }

    await fs.mkdir(NAPCAT_BASE_DIR, { recursive: true });

    runtime.log("[NapCat] Extracting Linux QQ...");
    if (installer === "dpkg") {
      await runCommandWithTimeout(["dpkg", "-x", packagePath, NAPCAT_BASE_DIR], {
        timeoutMs: 60_000,
      });
    } else {
      // For rpm, we need to extract manually using rpm2cpio | cpio
      const { spawn } = await import("node:child_process");
      await new Promise<void>((resolve, reject) => {
        const rpm2cpio = spawn("rpm2cpio", [packagePath], { cwd: NAPCAT_BASE_DIR });
        const cpio = spawn("cpio", ["-idm"], { cwd: NAPCAT_BASE_DIR });
        rpm2cpio.stdout?.pipe(cpio.stdin);

        let errorOutput = "";
        rpm2cpio.stderr?.on("data", (data) => {
          errorOutput += data.toString();
        });
        cpio.stderr?.on("data", (data) => {
          errorOutput += data.toString();
        });

        cpio.on("close", (code) => {
          if (code === 0) resolve();
          else reject(new Error(`cpio exited with code ${code}: ${errorOutput}`));
        });

        rpm2cpio.on("error", (err) => {
          reject(new Error(`rpm2cpio failed: ${err.message}`));
        });

        cpio.on("error", (err) => {
          reject(new Error(`cpio failed: ${err.message}`));
        });

        // Timeout
        setTimeout(() => {
          rpm2cpio.kill();
          cpio.kill();
          reject(new Error("rpm extraction timeout"));
        }, 60_000);
      });
    }

    return true;
  } catch (error) {
    runtime.log(
      `[NapCat] Failed to install Linux QQ: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ============================================================================
// NapCat Installation (Simplified - direct download)
// ============================================================================

async function downloadAndInstallNapCat(
  runtime: RuntimeEnv,
  tmpDir: string,
): Promise<{ ok: boolean; version?: string; error?: string }> {
  try {
    runtime.log("[NapCat] Downloading NapCatQQ...");

    // Use proxy if available, directly download from GitHub releases
    const proxy = await findWorkingProxy();
    const downloadUrl = proxy
      ? `${proxy}/https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip`
      : "https://github.com/NapNeko/NapCatQQ/releases/latest/download/NapCat.Shell.zip";

    const archivePath = path.join(tmpDir, "NapCat.Shell.zip");

    runtime.log(
      `[NapCat] Downloading from: ${downloadUrl.replace(/^(https:\/\/[^\/]+).*$/, "$1/...")}`,
    );
    await downloadToFile(downloadUrl, archivePath);

    runtime.log("[NapCat] Verifying archive...");
    await runCommandWithTimeout(["unzip", "-t", archivePath], { timeoutMs: 30_000 });

    const napcatExtractDir = path.join(tmpDir, "napcat");
    await fs.mkdir(napcatExtractDir, { recursive: true });

    runtime.log("[NapCat] Extracting...");
    await runCommandWithTimeout(["unzip", "-q", "-o", "-d", napcatExtractDir, archivePath], {
      timeoutMs: 60_000,
    });

    await fs.mkdir(NAPCAT_FOLDER, { recursive: true });

    runtime.log("[NapCat] Installing files...");
    await runCommandWithTimeout(["cp", "-r", "-f", `${napcatExtractDir}/.`, NAPCAT_FOLDER], {
      timeoutMs: 30_000,
    });

    await runCommandWithTimeout(["chmod", "-R", "+x", NAPCAT_FOLDER], { timeoutMs: 10_000 });

    // Create loader script
    const loadNapCatPath = path.join(QQ_BASE_PATH, "resources", "app", "loadNapCat.js");
    const loadScript = `(async () => {await import('file:///${NAPCAT_FOLDER}/napcat.mjs');})();\n`;
    await fs.writeFile(loadNapCatPath, loadScript, "utf-8");

    // Update package.json
    const packageJsonContent = await fs.readFile(QQ_PACKAGE_JSON_PATH, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    packageJson.main = "./loadNapCat.js";
    await fs.writeFile(QQ_PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2), "utf-8");

    return { ok: true, version: "latest" };
  } catch (error) {
    return {
      ok: false,
      error: `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

async function downloadAndCompileLauncher(
  runtime: RuntimeEnv,
  tmpDir: string,
  arch: string,
): Promise<boolean> {
  try {
    if (arch !== "amd64" && arch !== "arm64") {
      runtime.log(`[NapCat] Unsupported architecture for launcher: ${arch}`);
      return false;
    }

    const proxy = await findWorkingProxy();
    const cppUrl = `${proxy ? `${proxy}/` : ""}https://raw.githubusercontent.com/NapNeko/napcat-linux-launcher/refs/heads/main/launcher.cpp`;
    const cppPath = path.join(tmpDir, "launcher.cpp");
    const soPath = path.join(NAPCAT_BASE_DIR, "libnapcat_launcher.so");

    runtime.log("[NapCat] Downloading launcher source...");
    await downloadToFile(cppUrl, cppPath);

    runtime.log("[NapCat] Compiling launcher...");
    await runCommandWithTimeout(["g++", "-shared", "-fPIC", cppPath, "-o", soPath, "-ldl"], {
      timeoutMs: 60_000,
    });

    return true;
  } catch (error) {
    runtime.log(
      `[NapCat] Failed to compile launcher: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

// ============================================================================
// Main Installation
// ============================================================================

export async function installNapCatQQ(
  runtime: RuntimeEnv,
  options?: {
    httpPort?: number;
    wsPort?: number;
    accessToken?: string;
  },
): Promise<NapCatInstallResult> {
  if (os.platform() !== "linux") {
    return {
      ok: false,
      error: "NapCatQQ installation is only supported on Linux",
    };
  }

  const arch = os.arch() === "x64" ? "amd64" : os.arch() === "arm64" ? "arm64" : "none";
  if (arch === "none") {
    return {
      ok: false,
      error: `Unsupported architecture: ${os.arch()}`,
    };
  }

  const packageManager = await detectPackageManager();
  if (!packageManager) {
    return {
      ok: false,
      error: "No supported package manager found (apt or dnf required)",
    };
  }

  const packageInstaller = await detectPackageInstaller();
  if (!packageInstaller) {
    return {
      ok: false,
      error: "No supported package installer found (dpkg or rpm required)",
    };
  }

  const httpPort = options?.httpPort ?? 3000;
  const wsPort = options?.wsPort ?? 3001;
  const accessToken = options?.accessToken ?? generateSecureToken();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-napcat-"));

  try {
    // Install system dependencies
    const depsOk = await installSystemDependencies(runtime, packageManager);
    if (!depsOk) {
      return { ok: false, error: "Failed to install system dependencies" };
    }

    // Download and install NapCat
    const napcatResult = await downloadAndInstallNapCat(runtime, tmpDir);
    if (!napcatResult.ok) {
      return { ok: false, error: napcatResult.error };
    }

    // Install Linux QQ
    const qqOk = await installLinuxQQ(runtime, tmpDir, arch, packageInstaller, packageManager);
    if (!qqOk) {
      return { ok: false, error: "Failed to install Linux QQ" };
    }

    // Download and compile launcher
    const launcherOk = await downloadAndCompileLauncher(runtime, tmpDir, arch);
    if (!launcherOk) {
      return { ok: false, error: "Failed to compile NapCat launcher" };
    }

    // Create configurations
    await fs.mkdir(NAPCAT_CONFIG_DIR, { recursive: true });

    const onebotConfig = generateNapCatOneBotConfig(httpPort, wsPort, accessToken);
    const onebotConfigPath = path.join(NAPCAT_CONFIG_DIR, "onebot11.json");
    await fs.writeFile(onebotConfigPath, JSON.stringify(onebotConfig, null, 2), "utf-8");

    const webuiConfig = generateWebUIConfig();
    const webuiConfigPath = path.join(NAPCAT_CONFIG_DIR, "webui.json");
    await fs.writeFile(webuiConfigPath, JSON.stringify(webuiConfig, null, 2), "utf-8");

    // Save installation metadata
    const openclawConfigDir = path.join(OPENCLAW_NAPCAT_DIR, "system");
    await fs.mkdir(openclawConfigDir, { recursive: true });

    const launcherConfig = {
      version: "system",
      installPath: NAPCAT_BASE_DIR,
      qqPath: QQ_EXECUTABLE,
      configPath: NAPCAT_CONFIG_DIR,
      httpPort,
      wsPort,
      httpToken: accessToken,
      webuiPort: webuiConfig.port,
      webuiToken: webuiConfig.token,
      installedAt: new Date().toISOString(),
    };

    const launcherPath = path.join(openclawConfigDir, "openclaw-launcher.json");
    await fs.writeFile(launcherPath, JSON.stringify(launcherConfig, null, 2), "utf-8");

    runtime.log("[NapCat] Installation completed successfully!");

    return {
      ok: true,
      installPath: NAPCAT_BASE_DIR,
      qqPath: QQ_EXECUTABLE,
      version: napcatResult.version,
      configPath: NAPCAT_CONFIG_DIR,
      webuiToken: webuiConfig.token,
      webuiPort: webuiConfig.port,
      httpPort,
      wsPort,
      httpToken: accessToken,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Installation failed: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
    } catch {}
  }
}

// ============================================================================
// Detection and Status
// ============================================================================

export async function detectNapCatQQ(): Promise<string | null> {
  // Check standard installation path
  if (await fileExists(QQ_EXECUTABLE)) {
    if (await fileExists(path.join(NAPCAT_FOLDER, "napcat.mjs"))) {
      return NAPCAT_BASE_DIR;
    }
  }

  // Check metadata directory
  try {
    const entries = await fs.readdir(OPENCLAW_NAPCAT_DIR, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of versions) {
      const launcherPath = path.join(OPENCLAW_NAPCAT_DIR, version, "openclaw-launcher.json");
      try {
        const launcherContent = await fs.readFile(launcherPath, "utf-8");
        const launcher = JSON.parse(launcherContent);
        if (launcher.installPath && (await fileExists(launcher.installPath))) {
          return launcher.installPath;
        }
      } catch {}
    }
  } catch {}

  // Check system paths
  const systemPaths = ["/usr/local/bin/napcat", "/usr/bin/napcat", "/opt/napcat"];
  for (const p of systemPaths) {
    if (await fileExists(p)) {
      return p;
    }
  }

  return null;
}

export async function getNapCatStatus(): Promise<NapCatStatus> {
  const installPath = await detectNapCatQQ();
  const status: NapCatStatus = {
    installed: Boolean(installPath),
    running: false,
  };

  if (!installPath) {
    return status;
  }

  status.installPath = installPath;

  try {
    const { stdout } = await runExec("pgrep", ["-f", "qq.*napcat|napcat.*qq"], 5000);
    if (stdout.trim()) {
      status.running = true;
      status.pid = parseInt(stdout.split("\n")[0].trim(), 10);
    }
  } catch {}

  return status;
}

// ============================================================================
// Process Management
// ============================================================================

export async function killExistingNapCat(): Promise<void> {
  const processesToKill = ["qq", "xvfb-run", "Xvfb", "napcat"];

  try {
    // Kill screen session first
    try {
      await runExec("screen", ["-S", NAPCAT_SCREEN_NAME, "-X", "quit"], 3000);
    } catch {}

    // Kill processes gracefully
    for (const proc of processesToKill) {
      try {
        await runExec("pkill", ["-f", proc], 2000);
      } catch {}
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    // Force kill if still running
    for (const proc of processesToKill) {
      try {
        await runExec("pgrep", ["-f", proc], 1000);
        await runExec("pkill", ["-9", "-f", proc], 2000);
      } catch {}
    }

    // Reset QR code capture
    capturedQRCode = null;
    qrCodePromise = null;
    qrCodeResolver = null;
  } catch {}
}

// ============================================================================
// QR Code Capture
// ============================================================================

export function resetQRCodeCapture(): void {
  capturedQRCode = null;
  qrCodePromise = null;
  qrCodeResolver = null;
}

export function getCapturedQRCode(): string | null {
  return capturedQRCode;
}

export async function waitForQRCode(timeoutMs: number = 60000): Promise<string | null> {
  // Return existing QR code immediately
  if (capturedQRCode) {
    return capturedQRCode;
  }

  // Create new promise if not exists
  if (!qrCodePromise) {
    qrCodePromise = new Promise((resolve) => {
      qrCodeResolver = resolve;
      // Auto-resolve after timeout and cleanup
      setTimeout(() => {
        if (!capturedQRCode) {
          resolve(null);
        }
      }, timeoutMs);
    });
  }

  return qrCodePromise;
}

// ============================================================================
// NapCat Startup
// ============================================================================

async function waitForLogFile(logPath: string, timeoutMs: number = 10000): Promise<boolean> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      await fs.access(logPath);
      const stats = await fs.stat(logPath);
      if (stats.size > 0) return true;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

function startQRCodeMonitoring(logPaths: string[], runtime: RuntimeEnv): () => void {
  const { spawn } = require("node:child_process");

  // Start tail process to monitor logs
  const tailProcess = spawn("tail", ["-n", "0", "-f", ...logPaths], {
    stdio: ["ignore", "pipe", "ignore"],
  });

  const cleanup = () => {
    try {
      tailProcess.kill();
    } catch {}
  };

  tailProcess.stdout?.on("data", (data: Buffer) => {
    const lines = data.toString().split("\n");
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed) continue;

      // QR code patterns
      const qrPatterns = [
        /二维码解码URL:\s*(https:\/\/txz\.qq\.com\/[^\s]+)/,
        /二维码URL:\s*(https:\/\/txz\.qq\.com\/[^\s]+)/,
        /QRCode:\s*(https:\/\/txz\.qq\.com\/[^\s]+)/,
        /(https:\/\/txz\.qq\.com\/[^\s]+)/,
      ];

      for (const pattern of qrPatterns) {
        const match = trimmed.match(pattern);
        if (match?.[1]) {
          capturedQRCode = match[1];
          runtime.log(`[NapCat] QR Code captured`);
          if (qrCodeResolver) {
            qrCodeResolver(match[1]);
            qrCodeResolver = null;
          }
          return;
        }
      }
    }
  });

  return cleanup;
}

export async function startNapCatQQ(
  runtime: RuntimeEnv,
  options?: {
    killExisting?: boolean;
    waitForQrCode?: boolean;
  },
): Promise<NapCatStartResult> {
  const installPath = await detectNapCatQQ();
  if (!installPath) {
    return {
      ok: false,
      error: "NapCatQQ not found. Please install it first.",
    };
  }

  if (options?.killExisting !== false) {
    await killExistingNapCat();
  }

  try {
    // Read or create config
    const napCatConfig = await readNapCatConfig();
    let httpPort = napCatConfig?.httpPort ?? 3000;
    let wsPort = napCatConfig?.wsPort ?? 3001;

    // Check port availability
    const availablePorts = await findAvailablePorts(httpPort, wsPort);
    if (availablePorts.httpPort !== httpPort || availablePorts.wsPort !== wsPort) {
      runtime.log(`[NapCat] Using ports ${availablePorts.httpPort}/${availablePorts.wsPort}`);
      httpPort = availablePorts.httpPort;
      wsPort = availablePorts.wsPort;
      await updateNapCatConfig({ httpPort, wsPort });
    }

    // Ensure xvfb is available
    const xvfbAvailable = await checkXvfbAvailable();
    if (!xvfbAvailable) {
      return {
        ok: false,
        error:
          "xvfb-run not found. Please install xvfb:\n" +
          "  - Debian/Ubuntu: sudo apt-get install xvfb\n" +
          "  - RHEL/CentOS: sudo dnf install xorg-x11-server-Xvfb",
      };
    }

    const { spawn } = await import("node:child_process");

    // Chromium/Electron flags for headless environment
    const chromiumFlags = [
      "--no-sandbox",
      "--disable-gpu",
      "--disable-software-rasterizer",
      "--disable-dev-shm-usage",
      "--disable-setuid-sandbox",
      "--disable-accelerated-2d-canvas",
      "--disable-accelerated-jpeg-decoding",
      "--disable-accelerated-mjpeg-decode",
      "--disable-accelerated-video-decode",
      "--disable-gpu-compositing",
      "--disable-gpu-rasterization",
      "--disable-gpu-sandbox",
    ];

    // Setup log directory
    await ensureDir(NAPCAT_LOG_DIR);
    const outLog = path.join(NAPCAT_LOG_DIR, "napcat.stdout.log");
    const errLog = path.join(NAPCAT_LOG_DIR, "napcat.stderr.log");

    // Clean old logs
    try {
      await fs.writeFile(outLog, "", "utf-8");
      await fs.writeFile(errLog, "", "utf-8");
    } catch {}

    // Kill existing screen session
    try {
      await runExec("screen", ["-S", NAPCAT_SCREEN_NAME, "-X", "quit"], 3000);
    } catch {}

    // Start NapCat with screen and xvfb
    const launcherSoPath = path.join(NAPCAT_BASE_DIR, "libnapcat_launcher.so");
    const hasLauncher = await fileExists(launcherSoPath);

    let command: string;
    if (hasLauncher) {
      // Use launcher.so method (newer NapCat versions)
      const xvfbCommand = `Xvfb :1 -screen 0 1x1x8 +extension GLX +render > /dev/null 2>&1 &`;
      const qqCommand = `export DISPLAY=:1 && LD_PRELOAD=${launcherSoPath} ${QQ_EXECUTABLE} ${chromiumFlags.join(" ")}`;
      command = `${xvfbCommand} && ${qqCommand}`;
    } else {
      // Fallback to xvfb-run method
      command = `xvfb-run -a ${QQ_EXECUTABLE} ${chromiumFlags.join(" ")}`;
    }

    runtime.log(`[NapCat] Starting with screen session: ${NAPCAT_SCREEN_NAME}`);

    const child = spawn(
      "screen",
      ["-dmS", NAPCAT_SCREEN_NAME, "bash", "-c", `${command} > ${outLog} 2> ${errLog}`],
      {
        detached: false,
        stdio: "ignore",
        cwd: NAPCAT_BASE_DIR,
        env: {
          ...process.env,
          ELECTRON_DISABLE_GPU: "1",
          ELECTRON_DISABLE_SANDBOX: "1",
        },
      },
    );

    child.on("error", (err) => {
      runtime.log(`[NapCat] Screen error: ${err.message}`);
    });

    // Wait for screen to create session
    await new Promise((resolve) => setTimeout(resolve, 3000));

    // Get screen PID
    let screenPid: number | undefined;
    try {
      const { stdout: pidOut } = await runExec("screen", ["-ls"], 3000);
      const pidMatch = pidOut.match(
        new RegExp(`(\\d+)\\.${NAPCAT_SCREEN_NAME}\\s+\\((?:Detached|Attached)\\)`),
      );
      if (pidMatch) {
        screenPid = parseInt(pidMatch[1], 10);
      }
    } catch {}

    // Reset and start QR code capture
    resetQRCodeCapture();
    const cleanupQRMonitoring = startQRCodeMonitoring([outLog, errLog], runtime);

    // Wait for logs to be created
    await waitForLogFile(outLog, 5000);

    // Wait for QQ process to start
    let qqRunning = false;
    for (let i = 0; i < 10; i++) {
      try {
        const { stdout: psOut } = await runExec("ps", ["aux"], 5000);
        const qqProcesses = psOut
          .split("\n")
          .filter(
            (line) => line.includes("qq") && !line.includes("grep") && !line.includes("ps aux"),
          );
        if (qqProcesses.length > 0) {
          qqRunning = true;
          break;
        }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }

    if (!qqRunning) {
      cleanupQRMonitoring();
      return {
        ok: false,
        error: "NapCat QQ process not detected after starting. Check logs for details.",
      };
    }

    // Get WebUI config
    let webuiToken: string | undefined;
    let webuiPort = 6099;
    try {
      const webuiPath = path.join(NAPCAT_CONFIG_DIR, "webui.json");
      if (await fileExists(webuiPath)) {
        const content = await fs.readFile(webuiPath, "utf-8");
        const config = JSON.parse(content);
        webuiToken = config.token;
        webuiPort = config.port || 6099;
      }
    } catch {}

    runtime.log(`[NapCat] Started successfully (screen: ${NAPCAT_SCREEN_NAME})`);

    // Wait for QR code if requested
    let qrCode: string | null = null;
    if (options?.waitForQrCode) {
      runtime.log("[NapCat] Waiting for QR code (up to 60s)...");
      qrCode = await waitForQRCode(60000);
      if (qrCode) {
        runtime.log("[NapCat] QR code captured successfully");
      } else {
        runtime.log("[NapCat] QR code not captured yet, may appear later");
      }
    }

    return {
      ok: true,
      pid: screenPid,
      webuiToken,
      webuiPort,
      httpPort,
      wsPort,
      qrCode,
    };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to start NapCat: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function stopNapCatQQ(): Promise<{ ok: boolean; error?: string }> {
  try {
    // Stop screen session
    try {
      await runExec("screen", ["-S", NAPCAT_SCREEN_NAME, "-X", "quit"], 5000);
    } catch {}

    // Kill remaining processes
    await killExistingNapCat();

    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

// ============================================================================
// Configuration Management
// ============================================================================

export async function readNapCatConfig(qqNumber?: string): Promise<{
  httpPort?: number;
  wsPort?: number;
  httpToken?: string;
  webuiPort?: number;
  webuiToken?: string;
} | null> {
  try {
    const result: {
      httpPort?: number;
      wsPort?: number;
      httpToken?: string;
      webuiPort?: number;
      webuiToken?: string;
    } = {};

    // Read WebUI config
    const webuiPath = path.join(NAPCAT_CONFIG_DIR, "webui.json");
    if (await fileExists(webuiPath)) {
      const content = await fs.readFile(webuiPath, "utf-8");
      const config = JSON.parse(content);
      result.webuiPort = config.port;
      result.webuiToken = config.token;
    }

    // Read OneBot config (account-specific or default)
    const configsToCheck: string[] = [];
    if (qqNumber) {
      configsToCheck.push(path.join(NAPCAT_CONFIG_DIR, `onebot11_${qqNumber}.json`));
    }
    configsToCheck.push(path.join(NAPCAT_CONFIG_DIR, "onebot11.json"));

    for (const onebotPath of configsToCheck) {
      if (await fileExists(onebotPath)) {
        const content = await fs.readFile(onebotPath, "utf-8");
        const config = JSON.parse(content);
        if (config.network?.httpServers?.[0]?.port) {
          result.httpPort = config.network.httpServers[0].port;
        }
        if (config.network?.httpServers?.[0]?.token !== undefined) {
          result.httpToken = config.network.httpServers[0].token;
        }
        if (config.network?.websocketServers?.[0]?.port) {
          result.wsPort = config.network.websocketServers[0].port;
        }
        if (onebotPath.includes(`onebot11_${qqNumber}`)) {
          break;
        }
      }
    }

    return result;
  } catch {
    return null;
  }
}

export async function updateNapCatConfig(options: {
  httpPort?: number;
  wsPort?: number;
  accessToken?: string;
  qqNumber?: string;
}): Promise<boolean> {
  try {
    const configsToUpdate: string[] = [];
    configsToUpdate.push(path.join(NAPCAT_CONFIG_DIR, "onebot11.json"));

    if (options.qqNumber) {
      configsToUpdate.push(path.join(NAPCAT_CONFIG_DIR, `onebot11_${options.qqNumber}.json`));
    }

    for (const onebotPath of configsToUpdate) {
      if (onebotPath.includes(`onebot11_${options.qqNumber}`) && !(await fileExists(onebotPath))) {
        continue;
      }

      let config: object;
      if (await fileExists(onebotPath)) {
        const content = await fs.readFile(onebotPath, "utf-8");
        config = JSON.parse(content);
      } else {
        config = generateNapCatOneBotConfig();
      }

      const updated = { ...config } as Record<string, unknown>;

      if (options.httpPort !== undefined) {
        const network = updated.network as Record<string, unknown> | undefined;
        const httpServers = network?.httpServers as Array<Record<string, unknown>> | undefined;
        if (httpServers?.[0]) {
          httpServers[0].port = options.httpPort;
        }
      }

      if (options.wsPort !== undefined) {
        const network = updated.network as Record<string, unknown> | undefined;
        const wsServers = network?.websocketServers as Array<Record<string, unknown>> | undefined;
        if (wsServers?.[0]) {
          wsServers[0].port = options.wsPort;
        }
      }

      if (options.accessToken !== undefined) {
        const network = updated.network as Record<string, unknown> | undefined;
        const httpServers = network?.httpServers as Array<Record<string, unknown>> | undefined;
        const wsServers = network?.websocketServers as Array<Record<string, unknown>> | undefined;
        if (httpServers?.[0]) {
          httpServers[0].token = options.accessToken;
        }
        if (wsServers?.[0]) {
          wsServers[0].token = options.accessToken;
        }
      }

      await fs.writeFile(onebotPath, JSON.stringify(updated, null, 2), "utf-8");
    }

    return true;
  } catch {
    return false;
  }
}

// ============================================================================
// Login Status API
// ============================================================================

export async function checkNapCatLoginViaOneBot(
  httpPort: number = 3000,
  accessToken?: string,
): Promise<{ loggedIn: boolean; userId?: string; nickname?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const url = `http://localhost:${httpPort}/get_login_info`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (accessToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    const response = await fetch(url, {
      method: "POST",
      headers,
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseText = await response.text();

    if (!response.ok) {
      return { loggedIn: false, error: `HTTP ${response.status}: ${responseText}` };
    }

    const data = JSON.parse(responseText) as {
      data?: { user_id?: number; nickname?: string };
      retcode?: number;
      status?: string;
    };

    if (data.data?.user_id) {
      return {
        loggedIn: true,
        userId: String(data.data.user_id),
        nickname: data.data.nickname,
      };
    }

    return {
      loggedIn: false,
      error: data.status === "failed" ? "Not logged in" : `retcode: ${data.retcode}`,
    };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { loggedIn: false, error: "Request timeout" };
    }
    return {
      loggedIn: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function waitForNapCatLogin(
  httpPort: number = 3000,
  accessToken?: string,
  maxAttempts: number = 60,
  onAttempt?: (attempt: number, result: { loggedIn: boolean; error?: string }) => void,
): Promise<{ success: boolean; userId?: string; nickname?: string; error?: string }> {
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await checkNapCatLoginViaOneBot(httpPort, accessToken);

    if (onAttempt) {
      onAttempt(attempt + 1, result);
    }

    if (result.loggedIn) {
      return {
        success: true,
        userId: result.userId,
        nickname: result.nickname,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  return { success: false, error: "Timeout waiting for login" };
}

// ============================================================================
// Quick Login API
// ============================================================================

export interface QuickLoginItem {
  uin: string;
  uid: string;
  nickName: string;
  faceUrl: string;
  facePath: string;
  loginType: 1;
  isQuickLogin: boolean;
  isAutoLogin: boolean;
}

export async function getNapCatQuickLoginList(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ success: boolean; list?: QuickLoginItem[]; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`http://localhost:${webuiPort}/api/QQLogin/GetQuickLoginList`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webuiToken ? { Authorization: `Bearer ${webuiToken}` } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: QuickLoginItem[];
      message?: string;
    };

    if (data.data && Array.isArray(data.data)) {
      return { success: true, list: data.data };
    }

    return { success: false, error: data.message || "No quick login list available" };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "Request timeout" };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function setNapCatQuickLogin(
  uin: string,
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ success: boolean; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`http://localhost:${webuiPort}/api/QQLogin/SetQuickLogin`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webuiToken ? { Authorization: `Bearer ${webuiToken}` } : {}),
      },
      body: JSON.stringify({ uin }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: null;
      message?: string;
    };

    if (!data.message) {
      return { success: true };
    }

    return { success: false, error: data.message };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") {
      return { success: false, error: "Request timeout" };
    }
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
