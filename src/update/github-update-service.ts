import { spawn, type ChildProcess } from "node:child_process";
import { copyFile, mkdir, open, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

const DEFAULT_ASSET_NAME = "QQ-Codex-Bridge-Windows-Update.zip";
const CACHE_TTL_MS = 10 * 60_000;

export interface SoftwareUpdateStatus {
  repository: string;
  currentVersion: string;
  latestVersion: string | null;
  updateAvailable: boolean;
  canApply: boolean;
  releaseUrl?: string;
  publishedAt?: string;
  releaseNotes?: string;
  lastCheckedAt: string;
  message: string;
}

/** 更新器（update-bridge.ps1）写入 data/update-status.json 的运行记录。 */
export interface LocalUpdateStatus {
  state: string;       // checking | downloading | installing | succeeded | current | failed
  message: string;
  version: string;
  updatedAt: string;
}

export interface SoftwareUpdateController {
  status(force?: boolean): Promise<SoftwareUpdateStatus>;
  startUpdate(): Promise<{ version: string; message: string }>;
  localStatus(): Promise<LocalUpdateStatus | null>;
}

interface GitHubReleaseAsset {
  name: string;
  browser_download_url: string;
}

interface GitHubRelease {
  tag_name: string;
  html_url: string;
  published_at: string;
  body?: string;
  draft: boolean;
  prerelease: boolean;
  assets: GitHubReleaseAsset[];
}

export interface GitHubUpdateServiceOptions {
  installRoot: string;
  currentVersion: string;
  repository: string;
  assetName?: string;
  fetchImpl?: typeof fetch;
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
}

export class GitHubUpdateService implements SoftwareUpdateController {
  private readonly assetName: string;
  private readonly fetchImpl: typeof fetch;
  private readonly spawnImpl: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private cached?: { at: number; status: SoftwareUpdateStatus; release?: GitHubRelease };

  constructor(private readonly options: GitHubUpdateServiceOptions) {
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u.test(options.repository)) {
      throw new Error("GitHub update repository is invalid");
    }
    this.assetName = options.assetName ?? DEFAULT_ASSET_NAME;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.platform = options.platform ?? process.platform;
  }

  async status(force = false): Promise<SoftwareUpdateStatus> {
    if (!force && this.cached && Date.now() - this.cached.at < CACHE_TTL_MS) {
      return this.cached.status;
    }
    const lastCheckedAt = new Date().toISOString();
    const canRunUpdater = await this.canRunUpdater();
    try {
      const response = await this.fetchImpl(
        `https://api.github.com/repos/${this.options.repository}/releases/latest`,
        {
          headers: {
            Accept: "application/vnd.github+json",
            "User-Agent": "QQ-Codex-Bridge-Updater",
            "X-GitHub-Api-Version": "2022-11-28",
          },
          signal: AbortSignal.timeout(10_000),
        },
      );
      if (response.status === 404) {
        return this.cache({
          repository: this.options.repository,
          currentVersion: this.options.currentVersion,
          latestVersion: null,
          updateAvailable: false,
          canApply: false,
          lastCheckedAt,
          message: "GitHub 尚未发布正式 Release。",
        });
      }
      if (!response.ok) throw new Error(`GitHub returned HTTP ${response.status}`);
      const release = await response.json() as GitHubRelease;
      if (!release.tag_name || release.draft || release.prerelease) {
        throw new Error("GitHub latest release is not a stable release");
      }
      const latestVersion = normalizeVersion(release.tag_name);
      const updateAvailable = compareVersions(latestVersion, this.options.currentVersion) > 0;
      const checksumName = `${this.assetName}.sha256`;
      const assetsReady = release.assets.some((item) => item.name === this.assetName)
        && release.assets.some((item) => item.name === checksumName);
      const canApply = updateAvailable && assetsReady && canRunUpdater;
      const message = !updateAvailable
        ? "当前已经是最新版本。"
        : !assetsReady
          ? "发现新版本，但 Release 缺少更新包或校验文件。"
          : !canRunUpdater
            ? "发现新版本；当前安装不是可自动更新的 Windows 运行包。"
            : "发现可安装的新版本。";
      return this.cache({
        repository: this.options.repository,
        currentVersion: this.options.currentVersion,
        latestVersion,
        updateAvailable,
        canApply,
        releaseUrl: release.html_url,
        publishedAt: release.published_at,
        releaseNotes: release.body?.trim().slice(0, 1_200) || undefined,
        lastCheckedAt,
        message,
      }, release);
    } catch {
      return this.cache({
        repository: this.options.repository,
        currentVersion: this.options.currentVersion,
        latestVersion: null,
        updateAvailable: false,
        canApply: false,
        lastCheckedAt,
        message: "暂时无法连接 GitHub 检查更新。",
      });
    }
  }

  async startUpdate(): Promise<{ version: string; message: string }> {
    if (this.platform !== "win32") throw new Error("一键更新目前仅支持 Windows 运行包。");
    const status = await this.status(true);
    if (!status.updateAvailable) throw new Error(status.message);
    if (!status.canApply || !status.latestVersion) throw new Error(status.message);

    const sourceScript = join(this.options.installRoot, "tools", "update-bridge.ps1");
    const runnerDirectory = join(this.options.installRoot, "data", "updates");
    const runnerScript = join(runnerDirectory, `update-runner-${Date.now()}.ps1`);
    await mkdir(runnerDirectory, { recursive: true });
    await copyFile(sourceScript, runnerScript);

    // 把更新器输出写进日志（不再 stdio:"ignore" 静默吞错）。
    const runnerLog = join(runnerDirectory, `runner-${Date.now()}.log`);
    const log = await open(runnerLog, "a");
    // powershell 绝对路径：避免派生环境 PATH 没有 System32 时进程起来却不执行。
    const powershell = join(
      process.env.SystemRoot ?? "C:\\Windows",
      "System32",
      "WindowsPowerShell",
      "v1.0",
      "powershell.exe",
    );
    const child: ChildProcess = this.spawnImpl(powershell, [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", runnerScript,
      "-InstallRoot", this.options.installRoot,
      "-Repository", this.options.repository,
      "-ExpectedVersion", status.latestVersion,
      "-ParentProcessId", String(process.pid),
      "-Restart",
    ], {
      cwd: this.options.installRoot,
      detached: true,
      stdio: ["ignore", log.fd, log.fd],
      windowsHide: true,
    });
    // 派生失败（找不到 powershell 等）不再静默：写进 update-status.json。
    child.on("error", (error) => {
      void writeFile(
        join(this.options.installRoot, "data", "update-status.json"),
        JSON.stringify({
          state: "failed",
          message: `更新器启动失败：${error instanceof Error ? error.message : String(error)}`,
          version: status.latestVersion,
          updatedAt: new Date().toISOString(),
        }),
        "utf8",
      ).catch(() => undefined);
    });
    child.unref();
    await log.close();
    return {
      version: status.latestVersion,
      message: "更新程序已启动；Bridge 将短暂离线并自动重启。",
    };
  }

  async localStatus(): Promise<LocalUpdateStatus | null> {
    try {
      const raw = await readFile(
        join(this.options.installRoot, "data", "update-status.json"),
        "utf8",
      );
      const parsed = JSON.parse(raw) as Partial<LocalUpdateStatus>;
      if (typeof parsed.state !== "string") return null;
      return {
        state: parsed.state,
        message: typeof parsed.message === "string" ? parsed.message : "",
        version: typeof parsed.version === "string" ? parsed.version : "",
        updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : "",
      };
    } catch {
      return null;
    }
  }

  private cache(status: SoftwareUpdateStatus, release?: GitHubRelease): SoftwareUpdateStatus {
    this.cached = { at: Date.now(), status, release };
    return status;
  }

  private async canRunUpdater(): Promise<boolean> {
    if (this.platform !== "win32") return false;
    try {
      try {
        await readFile(join(this.options.installRoot, "src", "index.ts"), "utf8");
        return false;
      } catch { /* Packaged runtime intentionally has no TypeScript source tree. */ }
      const channel = JSON.parse(
        await readFile(join(this.options.installRoot, "update-channel.json"), "utf8"),
      ) as { repository?: string };
      await readFile(join(this.options.installRoot, "tools", "update-bridge.ps1"), "utf8");
      return channel.repository === this.options.repository;
    } catch {
      return false;
    }
  }
}

export function normalizeVersion(value: string): string {
  const normalized = value.trim().replace(/^v/u, "").split("-", 1)[0];
  if (!/^\d+\.\d+\.\d+$/u.test(normalized)) throw new Error("Invalid semantic version");
  return normalized;
}

export function compareVersions(left: string, right: string): number {
  const a = normalizeVersion(left).split(".").map(Number);
  const b = normalizeVersion(right).split(".").map(Number);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  }
  return 0;
}
