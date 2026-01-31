import { createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import { request } from "node:https";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";

import { runCommandWithTimeout } from "../process/exec.js";
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
  version?: string;
  configPath?: string;
  error?: string;
};

function looksLikeArchive(name: string): boolean {
  return name.endsWith(".zip");
}

function pickAsset(assets: ReleaseAsset[], platform: NodeJS.Platform) {
  const withName = assets.filter((asset): asset is NamedAsset =>
    Boolean(asset.name && asset.browser_download_url),
  );
  const byName = (pattern: RegExp) =>
    withName.find((asset) => pattern.test(asset.name.toLowerCase()));

  if (platform === "linux" || platform === "darwin") {
    // For Linux/macOS, use the Shell version
    return (
      byName(/shell\.zip$/) ||
      withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  if (platform === "win32") {
    // For Windows, prefer the Node version (includes Node.js runtime)
    return (
      byName(/shell\.windows\.node\.zip/) ||
      byName(/shell\.zip/) ||
      withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()))
    );
  }

  return withName.find((asset) => looksLikeArchive(asset.name.toLowerCase()));
}

async function downloadToFile(url: string, dest: string, maxRedirects = 5): Promise<void> {
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

async function findNapCatBinary(root: string): Promise<string | null> {
  const candidates: string[] = [];
  const enqueue = async (dir: string, depth: number) => {
    if (depth > 3) return;
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await enqueue(full, depth + 1);
      } else if (entry.isFile()) {
        // Look for napcat executables
        const lowerName = entry.name.toLowerCase();
        if (
          lowerName === "napcat" ||
          lowerName === "napcat.exe" ||
          lowerName === "napcat.sh" ||
          lowerName === "main.js"
        ) {
          candidates.push(full);
        }
      }
    }
  };
  await enqueue(root, 0);
  // Prefer napcat executable over main.js
  const napcatExe = candidates.find((p) => /napcat(\.exe)?$/i.test(p));
  return napcatExe ?? candidates[0] ?? null;
}

function generateNapCatConfig(
  httpPort: number = 3000,
  wsPort: number = 3001,
  accessToken?: string,
): string {
  const config = {
    http: {
      enable: true,
      host: "",
      port: httpPort,
      max_size: 10485760, // 10MB
      access_token: accessToken || "",
    },
    ws: {
      enable: true,
      host: "",
      port: wsPort,
      access_token: accessToken || "",
    },
  };
  return JSON.stringify(config, null, 2);
}

export async function installNapCatQQ(
  runtime: RuntimeEnv,
  options?: {
    httpPort?: number;
    wsPort?: number;
    accessToken?: string;
  },
): Promise<NapCatInstallResult> {
  const apiUrl = "https://api.github.com/repos/NapNeko/NapCatQQ/releases/latest";
  const response = await fetch(apiUrl, {
    headers: {
      "User-Agent": "openclaw",
      Accept: "application/vnd.github+json",
    },
  });

  if (!response.ok) {
    return {
      ok: false,
      error: `Failed to fetch release info (${response.status})`,
    };
  }

  const payload = (await response.json()) as ReleaseResponse;
  const version = payload.tag_name?.replace(/^v/, "") ?? "unknown";
  const assets = payload.assets ?? [];
  const asset = pickAsset(assets, process.platform);
  const assetName = asset?.name ?? "";
  const assetUrl = asset?.browser_download_url ?? "";

  if (!assetName || !assetUrl) {
    return {
      ok: false,
      error: "No compatible release asset found for this platform.",
    };
  }

  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "openclaw-napcat-"));
  const archivePath = path.join(tmpDir, assetName);

  runtime.log(`Downloading NapCatQQ ${version} (${assetName})...`);
  await downloadToFile(assetUrl, archivePath);

  const installRoot = path.join(CONFIG_DIR, "tools", "napcatqq", version);
  await fs.mkdir(installRoot, { recursive: true });

  if (assetName.endsWith(".zip")) {
    if (process.platform === "win32") {
      // On Windows, use PowerShell to extract
      await runCommandWithTimeout(
        ["powershell", "-Command", `Expand-Archive -Path "${archivePath}" -DestinationPath "${installRoot}" -Force`],
        { timeoutMs: 120_000 },
      );
    } else {
      // On Unix, use unzip
      await runCommandWithTimeout(["unzip", "-q", archivePath, "-d", installRoot], {
        timeoutMs: 120_000,
      });
    }
  } else {
    return { ok: false, error: `Unsupported archive type: ${assetName}` };
  }

  // Find the NapCat binary
  const binaryPath = await findNapCatBinary(installRoot);

  // Create config file
  const httpPort = options?.httpPort ?? 3000;
  const wsPort = options?.wsPort ?? 3001;
  const accessToken = options?.accessToken;

  const configDir = path.join(installRoot, "config");
  await fs.mkdir(configDir, { recursive: true });

  const configPath = path.join(configDir, "napcat.json");
  const configContent = generateNapCatConfig(httpPort, wsPort, accessToken);
  await fs.writeFile(configPath, configContent, "utf-8");

  // Create a launcher script
  const launcherPath = path.join(installRoot, "openclaw-launcher.json");
  const launcherConfig = {
    version,
    binaryPath,
    configPath,
    httpPort,
    wsPort,
    installRoot,
  };
  await fs.writeFile(launcherPath, JSON.stringify(launcherConfig, null, 2), "utf-8");

  runtime.log(`NapCatQQ ${version} installed successfully.`);
  runtime.log(`Configuration: ${configPath}`);
  runtime.log(`HTTP API: http://localhost:${httpPort}`);
  runtime.log(`WebSocket: ws://localhost:${wsPort}`);

  if (!binaryPath) {
    runtime.log("[warn] NapCat binary not found. You may need to start NapCatQQ manually.");
  }

  return {
    ok: true,
    installPath: installRoot,
    version,
    configPath,
  };
}

export async function detectNapCatQQ(runtime: RuntimeEnv): Promise<string | null> {
  // Check if NapCat is installed via openclaw
  const napcatDir = path.join(CONFIG_DIR, "tools", "napcatqq");
  try {
    const entries = await fs.readdir(napcatDir, { withFileTypes: true });
    const versions = entries
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));

    for (const version of versions) {
      const launcherPath = path.join(napcatDir, version, "openclaw-launcher.json");
      try {
        const launcherContent = await fs.readFile(launcherPath, "utf-8");
        const launcher = JSON.parse(launcherContent);
        if (launcher.installRoot && launcher.configPath) {
          return launcher.installRoot;
        }
      } catch {
        // Continue to next version
      }
    }
  } catch {
    // Directory doesn't exist
  }

  // Check common system paths
  const systemPaths = [
    "/usr/local/bin/napcat",
    "/usr/bin/napcat",
    "/opt/napcat",
    path.join(os.homedir(), "napcat"),
    path.join(os.homedir(), "NapCatQQ"),
  ];

  for (const p of systemPaths) {
    try {
      const stat = await fs.stat(p);
      if (stat.isDirectory() || stat.isFile()) {
        return p;
      }
    } catch {
      // Path doesn't exist
    }
  }

  return null;
}

export async function startNapCatQQ(
  runtime: RuntimeEnv,
  installPath: string,
): Promise<{ ok: boolean; pid?: number; error?: string }> {
  const launcherPath = path.join(installPath, "openclaw-launcher.json");
  let binaryPath: string | null = null;
  let configPath: string | null = null;

  try {
    const launcherContent = await fs.readFile(launcherPath, "utf-8");
    const launcher = JSON.parse(launcherContent);
    binaryPath = launcher.binaryPath;
    configPath = launcher.configPath;
  } catch {
    // Try to find binary manually
    binaryPath = await findNapCatBinary(installPath);
  }

  if (!binaryPath) {
    return {
      ok: false,
      error: "NapCat binary not found in installation directory.",
    };
  }

  runtime.log(`Starting NapCatQQ from ${binaryPath}...`);

  try {
    // NapCat needs to be started with Node.js
    const isWindows = process.platform === "win32";
    const nodeCmd = isWindows ? "node.exe" : "node";

    // Check if binary is a .js file or an executable
    const isJsFile = binaryPath.endsWith(".js");
    const command = isJsFile ? [nodeCmd, binaryPath] : [binaryPath];

    // Add config argument if available
    if (configPath) {
      command.push("--config", configPath);
    }

    const { spawn } = await import("node:child_process");
    const child = spawn(command[0], command.slice(1), {
      detached: true,
      stdio: "ignore",
      cwd: installPath,
    });

    child.unref();

    runtime.log(`NapCatQQ started with PID ${child.pid}`);

    return { ok: true, pid: child.pid };
  } catch (error) {
    return {
      ok: false,
      error: `Failed to start NapCatQQ: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
