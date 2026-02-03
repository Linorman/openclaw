import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { runCommandWithTimeout, runExec } from "../process/exec.js";
import type { RuntimeEnv } from "../runtime.js";
import { CONFIG_DIR } from "../utils.js";

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

export type NapCatInstallResult = {
  ok: boolean;
  installPath?: string;
  qqPath?: string;
  version?: string;
  configPath?: string;
  webuiToken?: string;
  webuiPort?: number;
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

const NAPCAT_BASE_DIR = path.join(os.homedir(), "Napcat");
const QQ_BASE_PATH = path.join(NAPCAT_BASE_DIR, "opt", "QQ");
const QQ_EXECUTABLE = path.join(QQ_BASE_PATH, "qq");
const QQ_PACKAGE_JSON_PATH = path.join(QQ_BASE_PATH, "resources", "app", "package.json");
const NAPCAT_FOLDER = path.join(QQ_BASE_PATH, "resources", "app", "app_launcher", "napcat");
const NAPCAT_CONFIG_DIR = path.join(NAPCAT_FOLDER, "config");

const OPENCLAW_NAPCAT_DIR = path.join(CONFIG_DIR, "tools", "napcatqq");

let napcatProcess: ReturnType<typeof import("node:child_process").spawn> | null = null;

let capturedQRCode: string | null = null;

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

      proc.on("error", () => {
        resolve(true);
      });

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
    console.log(`[Port Check] Port ${httpPort} is in use, trying ${httpPort + 1}`);
    httpPort++;
    if (httpPort > 65535) {
      throw new Error("No available ports found for HTTP server");
    }
  }

  while (!(await isPortAvailable(wsPort)) || wsPort === httpPort) {
    console.log(`[Port Check] Port ${wsPort} is in use, trying ${wsPort + 1}`);
    wsPort++;
    if (wsPort > 65535) {
      throw new Error("No available ports found for WebSocket server");
    }
  }

  return { httpPort, wsPort };
}

function looksLikeArchive(name: string): boolean {
  return name.endsWith(".zip");
}

function pickNapCatAsset(assets: ReleaseAsset[], platform: NodeJS.Platform) {
  const withName = assets.filter((asset): asset is NamedAsset =>
    Boolean(asset.name && asset.browser_download_url),
  );
  const byName = (pattern: RegExp) =>
    withName.find((asset) => pattern.test(asset.name.toLowerCase()));

  if (platform === "linux" || platform === "darwin") {
    return (
      byName(/shell\.zip$/) || withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  if (platform === "win32") {
    return (
      byName(/shell\.windows\.node\.zip/) ||
      byName(/shell\.zip/) ||
      withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  return withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()));
}

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
  const { request } = await import("node:https");
  await new Promise<void>((resolve, reject) => {
    const req = request(url, (res) => {
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

function getLinuxQQDownloadUrl(): { url: string; filename: string } | null {
  const platform = os.platform();
  const arch = os.arch();

  const version = "3.2.21-42086";

  if (platform === "linux") {
    if (arch === "x64") {
      return {
        url: `https://dldir1.qq.com/qqfile/qq/QQNT/8015ff90/linuxqq_${version}_amd64.deb`,
        filename: "QQ.deb",
      };
    }
    if (arch === "arm64") {
      return {
        url: `https://dldir1.qq.com/qqfile/qq/QQNT/8015ff90/linuxqq_${version}_arm64.deb`,
        filename: "QQ.deb",
      };
    }
  }

  return null;
}

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

async function installSystemDependencies(
  runtime: RuntimeEnv,
  packageManager: "apt" | "dnf",
): Promise<boolean> {
  try {
    runtime.log("Installing system dependencies...");

    if (packageManager === "apt") {
      try {
        await runCommandWithTimeout(["sudo", "apt-get", "update", "-y", "-qq"], {
          timeoutMs: 60_000,
        });
      } catch {
        runtime.log("Warning: Failed to update package list, continuing anyway...");
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
        "rpm2cpio",
        "cpio",
        "libnss3",
        "libgbm1",
        "libglib2.0-0",
        "libatk1.0-0",
        "libatspi2.0-0",
        "libgtk-3-0",
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
        "screen",
        "procps-ng",
        "cpio",
        "nss",
        "mesa-libgbm",
        "atk",
        "at-spi2-atk",
        "gtk3",
        "alsa-lib",
        "pango",
        "cairo",
        "libdrm",
        "libXcursor",
        "libXrandr",
        "libXdamage",
        "libXcomposite",
        "libXfixes",
        "libXrender",
        "libXi",
        "libXtst",
        "libXScrnSaver",
        "cups-libs",
        "libxkbcommon",
        "libX11-xcb",
        "mesa-dri-drivers",
        "mesa-libEGL",
        "mesa-libGL",
        "xcb-util",
        "xcb-util-image",
        "xcb-util-wm",
        "xcb-util-keysyms",
        "xcb-util-renderutil",
        "fontconfig",
        "dejavu-sans-fonts",
        "xorg-x11-server-Xvfb",
      ];

      await runCommandWithTimeout(["sudo", "dnf", "install", "--allowerasing", "-y", ...packages], {
        timeoutMs: 300_000,
      });
    }

    return true;
  } catch (error) {
    runtime.log(
      `Failed to install system dependencies: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function installLinuxQQ(runtime: RuntimeEnv, tmpDir: string): Promise<boolean> {
  try {
    const downloadInfo = getLinuxQQDownloadUrl();
    if (!downloadInfo) {
      runtime.log("Unsupported platform for Linux QQ installation");
      return false;
    }

    const { url, filename } = downloadInfo;
    const packagePath = path.join(tmpDir, filename);

    runtime.log(`Downloading Linux QQ from ${url}...`);
    await downloadToFile(url, packagePath);

    if (await fileExists(NAPCAT_BASE_DIR)) {
      runtime.log("Removing old NapCat installation...");
      await fs.rm(NAPCAT_BASE_DIR, { recursive: true, force: true });
    }

    await fs.mkdir(NAPCAT_BASE_DIR, { recursive: true });

    runtime.log("Extracting Linux QQ...");
    await runCommandWithTimeout(["dpkg", "-x", packagePath, NAPCAT_BASE_DIR], {
      timeoutMs: 60_000,
    });

    return true;
  } catch (error) {
    runtime.log(
      `Failed to install Linux QQ: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function installNapCat(runtime: RuntimeEnv, tmpDir: string): Promise<boolean> {
  try {
    runtime.log("Fetching NapCatQQ release info...");

    const apiUrl = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest";
    const response = await fetch(apiUrl, {
      headers: {
        "User-Agent": "openclaw",
        Accept: "application/vnd.github+json",
      },
    });

    if (!response.ok) {
      throw new Error(`Failed to fetch release info (${response.status})`);
    }

    const payload = (await response.json()) as ReleaseResponse;
    const assets = payload.assets ?? [];
    const asset = pickNapCatAsset(assets, process.platform);

    if (!asset?.browser_download_url) {
      throw new Error("No compatible NapCat release asset found");
    }

    const archivePath = path.join(tmpDir, "NapCat.Shell.zip");
    runtime.log(`Downloading NapCatQQ ${payload.tag_name}...`);
    await downloadToFile(asset.browser_download_url, archivePath);

    runtime.log("Verifying NapCat archive...");
    await runCommandWithTimeout(["unzip", "-t", archivePath], { timeoutMs: 30_000 });

    const napcatExtractDir = path.join(tmpDir, "NapCat");
    await fs.mkdir(napcatExtractDir, { recursive: true });

    runtime.log("Extracting NapCat...");
    await runCommandWithTimeout(["unzip", "-q", "-o", "-d", napcatExtractDir, archivePath], {
      timeoutMs: 60_000,
    });

    await fs.mkdir(NAPCAT_FOLDER, { recursive: true });

    runtime.log("Installing NapCat files...");
    await runCommandWithTimeout(["cp", "-r", "-f", `${napcatExtractDir}/.`, NAPCAT_FOLDER], {
      timeoutMs: 30_000,
    });

    await runCommandWithTimeout(["chmod", "-R", "+x", NAPCAT_FOLDER], { timeoutMs: 10_000 });

    const loadNapCatPath = path.join(QQ_BASE_PATH, "resources", "app", "loadNapCat.js");
    const loadScript = `(async () => {await import('file:///${NAPCAT_FOLDER}/napcat.mjs');})();\n`;
    await fs.writeFile(loadNapCatPath, loadScript, "utf-8");

    const packageJsonContent = await fs.readFile(QQ_PACKAGE_JSON_PATH, "utf-8");
    const packageJson = JSON.parse(packageJsonContent);
    packageJson.main = "./loadNapCat.js";
    await fs.writeFile(QQ_PACKAGE_JSON_PATH, JSON.stringify(packageJson, null, 2), "utf-8");

    return true;
  } catch (error) {
    runtime.log(
      `Failed to install NapCat: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
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
    token:
      Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15),
    loginRate: 3,
  };
}

function generateSecureToken(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let token = "";
  for (let i = 0; i < 32; i++) {
    token += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return token;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function installNapCatQQ(
  runtime: RuntimeEnv,
  options?: {
    httpPort?: number;
    wsPort?: number;
    accessToken?: string;
    skipSystemDeps?: boolean;
  },
): Promise<NapCatInstallResult & { httpToken?: string }> {
  if (os.platform() !== "linux") {
    return {
      ok: false,
      error:
        "Full NapCatQQ installation is only supported on Linux. On other platforms, please install NapCatQQ manually.",
    };
  }

  const httpPort = options?.httpPort ?? 3000;
  const wsPort = options?.wsPort ?? 3001;
  const accessToken = options?.accessToken ?? generateSecureToken();

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-napcat-"));

  try {
    if (!options?.skipSystemDeps) {
      const packageManager = await detectPackageManager();
      if (!packageManager) {
        return {
          ok: false,
          error: "No supported package manager found (apt or dnf required)",
        };
      }

      const depsOk = await installSystemDependencies(runtime, packageManager);
      if (!depsOk) {
        return {
          ok: false,
          error: "Failed to install system dependencies",
        };
      }
    }

    const qqOk = await installLinuxQQ(runtime, tmpDir);
    if (!qqOk) {
      return {
        ok: false,
        error: "Failed to install Linux QQ",
      };
    }

    const napcatOk = await installNapCat(runtime, tmpDir);
    if (!napcatOk) {
      return {
        ok: false,
        error: "Failed to install NapCat",
      };
    }

    await fs.mkdir(NAPCAT_CONFIG_DIR, { recursive: true });

    const onebotConfig = generateNapCatOneBotConfig(httpPort, wsPort, accessToken);
    const onebotConfigPath = path.join(NAPCAT_CONFIG_DIR, "onebot11.json");
    await fs.writeFile(onebotConfigPath, JSON.stringify(onebotConfig, null, 2), "utf-8");

    const webuiConfig = generateWebUIConfig();
    const webuiConfigPath = path.join(NAPCAT_CONFIG_DIR, "webui.json");
    await fs.writeFile(webuiConfigPath, JSON.stringify(webuiConfig, null, 2), "utf-8");

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

    runtime.log("NapCatQQ installation completed successfully!");

    return {
      ok: true,
      installPath: NAPCAT_BASE_DIR,
      qqPath: QQ_EXECUTABLE,
      version: "system",
      configPath: NAPCAT_CONFIG_DIR,
      webuiToken: webuiConfig.token,
      webuiPort: webuiConfig.port,
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

export async function detectNapCatQQ(_runtime?: RuntimeEnv): Promise<string | null> {
  if (await fileExists(QQ_EXECUTABLE)) {
    if (await fileExists(path.join(NAPCAT_FOLDER, "napcat.mjs"))) {
      return NAPCAT_BASE_DIR;
    }
  }

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

  const systemPaths = [
    "/usr/local/bin/napcat",
    "/usr/bin/napcat",
    "/opt/napcat",
    path.join(os.homedir(), "napcat"),
    path.join(os.homedir(), "NapCatQQ"),
  ];

  for (const p of systemPaths) {
    if (await fileExists(p)) {
      return p;
    }
  }

  return null;
}

export async function getNapCatStatus(_runtime?: RuntimeEnv): Promise<NapCatStatus> {
  const installPath = await detectNapCatQQ(_runtime);
  const status: NapCatStatus = {
    installed: Boolean(installPath),
    running: false,
  };

  if (!installPath) {
    return status;
  }

  status.installPath = installPath;

  try {
    const { stdout } = await runExec("pgrep", ["-f", "qq.*napcat"], 5000);
    if (stdout.trim()) {
      status.running = true;
      status.pid = parseInt(stdout.split("\n")[0].trim(), 10);
    }
  } catch {}

  return status;
}

export async function killExistingNapCat(): Promise<void> {
  const processesToKill = [
    "qq", // QQ process
    "xvfb-run", // X11 virtual framebuffer
    "Xvfb", // X virtual framebuffer
    "napcat", // NapCat
  ];

  try {
    for (const proc of processesToKill) {
      try {
        await runExec("pkill", ["-f", proc], 2000);
      } catch {}
    }

    await new Promise((resolve) => setTimeout(resolve, 2000));

    for (const proc of processesToKill) {
      try {
        await runExec("pgrep", ["-f", proc], 1000);
        await runExec("pkill", ["-9", "-f", proc], 2000);
      } catch {}
    }

    capturedQRCode = null;
  } catch {}
}

export async function startNapCatQQ(
  runtime: RuntimeEnv,
  options?: {
    qqNumber?: string;
    killExisting?: boolean;
  },
): Promise<{
  ok: boolean;
  pid?: number;
  webuiToken?: string;
  webuiPort?: number;
  httpPort?: number;
  wsPort?: number;
  error?: string;
}> {
  const installPath = await detectNapCatQQ(runtime);
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
    const napCatConfig = await readNapCatConfig();
    let httpPort = napCatConfig?.httpPort ?? 3000;
    let wsPort = napCatConfig?.wsPort ?? 3001;

    const availablePorts = await findAvailablePorts(httpPort, wsPort);

    if (availablePorts.httpPort !== httpPort || availablePorts.wsPort !== wsPort) {
      runtime.log(
        `Ports ${httpPort}/${wsPort} in use, using ${availablePorts.httpPort}/${availablePorts.wsPort} instead`,
      );

      const { updateNapCatConfig } = await import("./napcat-install.js");
      await updateNapCatConfig({
        httpPort: availablePorts.httpPort,
        wsPort: availablePorts.wsPort,
      });

      httpPort = availablePorts.httpPort;
      wsPort = availablePorts.wsPort;
    }

    const { spawn } = await import("node:child_process");

    const hasDisplay = process.env.DISPLAY !== undefined && process.env.DISPLAY !== "";

    if (!hasDisplay) {
      try {
        await runExec("which", ["xvfb-run"], 5000);
      } catch {
        return {
          ok: false,
          error:
            "xvfb-run not found. Linux QQ requires a display server.\n" +
            "Please either:\n" +
            "  1. Install xvfb: sudo apt-get install xvfb (Debian/Ubuntu) or sudo dnf install xorg-x11-server-Xvfb (RHEL/CentOS)\n" +
            "  2. Or run 'openclaw onboard qq' which will auto-install dependencies\n" +
            "  3. Or connect via SSH with X11 forwarding (ssh -X)",
        };
      }
    }

    const args = hasDisplay
      ? [QQ_EXECUTABLE, "--no-sandbox"]
      : ["-a", QQ_EXECUTABLE, "--no-sandbox"];
    if (options?.qqNumber) {
      args.push("-q", options.qqNumber);
    }

    const spawnCommand = hasDisplay ? QQ_EXECUTABLE : "xvfb-run";
    const child = spawn(spawnCommand, args, {
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...(hasDisplay ? {} : { DISPLAY: ":99" }),
      },
    });

    child.unref();

    napcatProcess = child;

    capturedQRCode = null;

    let logLines = 0;
    child.stdout?.on("data", (data) => {
      const line = data.toString().trim();

      const qrMatch = line.match(/二维码解码URL:\s*(https:\/\/txz\.qq\.com\/[^\s]+)/);
      if (qrMatch && qrMatch[1]) {
        capturedQRCode = qrMatch[1];
      }

      if (line && logLines < 20) {
        logLines++;
        runtime.log(`[napcat] ${line.substring(0, 200)}`);
      }
    });

    child.stderr?.on("data", (data) => {
      const line = data.toString().trim();

      const qrMatch = line.match(/二维码解码URL:\s*(https:\/\/txz\.qq\.com\/[^\s]+)/);
      if (qrMatch && qrMatch[1]) {
        capturedQRCode = qrMatch[1];
      }

      if (line && logLines < 20) {
        logLines++;
        runtime.log(`[napcat:err] ${line.substring(0, 200)}`);
      }
    });

    await new Promise((resolve) => setTimeout(resolve, 8000));

    if (child.pid && !child.killed) {
      try {
        process.kill(child.pid, 0); // Check if process exists
      } catch {
        return {
          ok: false,
          error: "NapCat process exited after starting",
        };
      }
    }

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

    return { ok: true, pid: child.pid, webuiToken, webuiPort, httpPort, wsPort };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to start NapCatQQ: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function stopNapCatQQ(
  _runtime?: RuntimeEnv,
): Promise<{ ok: boolean; error?: string }> {
  if (napcatProcess && !napcatProcess.killed) {
    try {
      napcatProcess.kill("SIGTERM");
      await new Promise((resolve) => setTimeout(resolve, 2000));

      if (!napcatProcess.killed) {
        napcatProcess.kill("SIGKILL");
      }
    } catch {}
    napcatProcess = null;
  }

  await killExistingNapCat();

  return { ok: true };
}

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

    const webuiPath = path.join(NAPCAT_CONFIG_DIR, "webui.json");
    if (await fileExists(webuiPath)) {
      const content = await fs.readFile(webuiPath, "utf-8");
      const config = JSON.parse(content);
      result.webuiPort = config.port;
      result.webuiToken = config.token;
    }

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

export async function checkNapCatLoginViaOneBot(
  httpPort: number = 3000,
  accessToken?: string,
  _runtime?: RuntimeEnv,
): Promise<{ loggedIn: boolean; userId?: string; nickname?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const hasToken = accessToken && accessToken.trim().length > 0;

    console.log(
      `[OneBot API] Checking login at port ${httpPort}, hasToken: ${hasToken}, token: ${accessToken ? accessToken.substring(0, 8) + "..." : "(none)"}`,
    );

    const url = `http://localhost:${httpPort}/get_login_info`;
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
    };
    if (hasToken) {
      headers["Authorization"] = `Bearer ${accessToken}`;
    }

    console.log(`[OneBot API] Request: POST ${url}`);
    console.log(`[OneBot API] Headers: ${JSON.stringify(headers)}`);

    const response = await fetch(url, {
      method: "POST",
      headers,
      ...(hasToken ? { body: JSON.stringify({ access_token: accessToken }) } : {}),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    const responseText = await response.text();
    console.log(`[OneBot API] Response status: ${response.status}`);
    console.log(`[OneBot API] Response body: ${responseText}`);

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

export async function checkNapCatLogin(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ loggedIn: boolean; userId?: string; nickname?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`http://localhost:${webuiPort}/api/QQLogin/CheckLoginStatus`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webuiToken ? { Authorization: `Bearer ${webuiToken}` } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { loggedIn: false, error: `HTTP ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: { isLogin?: boolean; qrcodeurl?: string; loginError?: string };
    };

    if (data.data?.isLogin) {
      const infoResult = await getNapCatQQLoginInfo(webuiPort, webuiToken);
      if (infoResult.success && infoResult.userId) {
        return {
          loggedIn: true,
          userId: infoResult.userId,
          nickname: infoResult.nickname,
        };
      }
      return { loggedIn: true };
    }

    return { loggedIn: false, error: data.data?.loginError };
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

export async function getNapCatQQLoginInfo(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ success: boolean; userId?: string; nickname?: string; error?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`http://localhost:${webuiPort}/api/QQLogin/GetQQLoginInfo`, {
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
      data?: { uin?: string; nick?: string; avatarUrl?: string };
    };

    if (data.data?.uin) {
      return {
        success: true,
        userId: data.data.uin,
        nickname: data.data.nick,
      };
    }

    return { success: false, error: "No login info available" };
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

export function getCapturedNapCatQRCode(): string | null {
  return capturedQRCode;
}

export async function getNapCatQRCode(
  webuiPort: number = 6099,
  webuiToken?: string,
): Promise<{ success: boolean; qrCode?: string; message?: string }> {
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);

    const response = await fetch(`http://localhost:${webuiPort}/api/QQLogin/GetQQLoginQrcode`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(webuiToken ? { Authorization: `Bearer ${webuiToken}` } : {}),
      },
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!response.ok) {
      return { success: false, message: `API returned ${response.status}` };
    }

    const data = (await response.json()) as {
      data?: { qrcode?: string };
      message?: string;
    };

    const qrCode = data.data?.qrcode;
    if (qrCode) {
      return { success: true, qrCode };
    }

    return { success: false, message: data.message || "No QR code available" };
  } catch (error) {
    return {
      success: false,
      message: `Failed to get QR code: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export async function waitForNapCatLogin(
  httpPort: number = 3000,
  accessToken?: string,
  maxAttempts: number = 60,
  onAttempt?: (attempt: number, result: { loggedIn: boolean; error?: string }) => void,
): Promise<{ success: boolean; userId?: string; nickname?: string; error?: string }> {
  console.log(
    `[waitForNapCatLogin] Starting poll on port ${httpPort}, token: ${accessToken ? accessToken.substring(0, 8) + "..." : "(none)"}`,
  );
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const result = await checkNapCatLoginViaOneBot(httpPort, accessToken);

    if (onAttempt) {
      onAttempt(attempt + 1, result);
    }

    if (result.loggedIn) {
      console.log(`[waitForNapCatLogin] Login detected at attempt ${attempt + 1}`);
      return {
        success: true,
        userId: result.userId,
        nickname: result.nickname,
      };
    }

    await new Promise((resolve) => setTimeout(resolve, 3000));
  }

  console.log(`[waitForNapCatLogin] Timeout after ${maxAttempts} attempts`);
  return { success: false, error: "Timeout waiting for login" };
}

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

process.on("exit", () => {
  if (napcatProcess && !napcatProcess.killed) {
    napcatProcess.kill("SIGKILL");
  }
});

process.on("SIGINT", () => {
  if (napcatProcess && !napcatProcess.killed) {
    napcatProcess.kill("SIGTERM");
  }
  process.exit(0);
});

process.on("SIGTERM", () => {
  if (napcatProcess && !napcatProcess.killed) {
    napcatProcess.kill("SIGTERM");
  }
  process.exit(0);
});
