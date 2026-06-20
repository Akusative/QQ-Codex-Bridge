import type { ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { WindowsBridgeSystemControl } from "../src/system/windows-system-control.js";

describe("WindowsBridgeSystemControl", () => {
  it("starts a detached hidden restart runner for the current Bridge process", async () => {
    const installRoot = await mkdtemp(join(tmpdir(), "bridge-restart-"));
    await mkdir(join(installRoot, "tools"));
    await writeFile(join(installRoot, "tools", "restart-bridge.ps1"), "exit 0\n");
    const unref = vi.fn();
    const spawnImpl = vi.fn(() => ({ unref }) as unknown as ChildProcess) as unknown as typeof spawn;
    const control = new WindowsBridgeSystemControl({
      installRoot,
      platform: "win32",
      processId: 1234,
      spawnImpl,
    });

    await expect(control.restart()).resolves.toMatchObject({ message: expect.any(String) });
    expect(spawnImpl).toHaveBeenCalledWith(
      "powershell.exe",
      expect.arrayContaining(["-ParentProcessId", "1234"]),
      expect.objectContaining({ detached: true, windowsHide: true, stdio: "ignore" }),
    );
    expect(unref).toHaveBeenCalledOnce();
  });

  it("refuses restart on unsupported platforms", async () => {
    const control = new WindowsBridgeSystemControl({
      installRoot: "C:\\Bridge",
      platform: "linux",
    });
    await expect(control.restart()).rejects.toThrow("Windows");
  });
});
