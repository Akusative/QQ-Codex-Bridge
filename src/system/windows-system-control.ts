import { spawn, type ChildProcess } from "node:child_process";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

export interface BridgeSystemController {
  restart(): Promise<{ message: string }>;
}

export interface WindowsBridgeSystemControlOptions {
  installRoot: string;
  spawnImpl?: typeof spawn;
  platform?: NodeJS.Platform;
  processId?: number;
}

export class WindowsBridgeSystemControl implements BridgeSystemController {
  private readonly spawnImpl: typeof spawn;
  private readonly platform: NodeJS.Platform;
  private readonly processId: number;

  constructor(private readonly options: WindowsBridgeSystemControlOptions) {
    this.spawnImpl = options.spawnImpl ?? spawn;
    this.platform = options.platform ?? process.platform;
    this.processId = options.processId ?? process.pid;
  }

  async restart(): Promise<{ message: string }> {
    if (this.platform !== "win32") {
      throw new Error("一键重启目前仅支持 Windows 运行包。");
    }
    const scriptPath = join(this.options.installRoot, "tools", "restart-bridge.ps1");
    await readFile(scriptPath, "utf8");

    const child: ChildProcess = this.spawnImpl("powershell.exe", [
      "-NoProfile",
      "-ExecutionPolicy", "Bypass",
      "-File", scriptPath,
      "-InstallRoot", this.options.installRoot,
      "-ParentProcessId", String(this.processId),
    ], {
      cwd: this.options.installRoot,
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { message: "重启命令已发送，Bridge 将短暂离线并自动恢复。" };
  }
}
