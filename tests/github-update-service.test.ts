import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  compareVersions,
  GitHubUpdateService,
  normalizeVersion,
} from "../src/update/github-update-service.js";

async function updaterRoot() {
  const root = await mkdtemp(join(tmpdir(), "bridge-update-"));
  await mkdir(join(root, "tools"), { recursive: true });
  await Promise.all([
    writeFile(
      join(root, "update-channel.json"),
      JSON.stringify({ repository: "Akusative/QQ-Codex-Bridge" }),
      "utf8",
    ),
    writeFile(join(root, "tools", "update-bridge.ps1"), "param()", "utf8"),
  ]);
  return root;
}

describe("GitHubUpdateService", () => {
  it("compares stable semantic versions", () => {
    expect(normalizeVersion("v0.2.0")).toBe("0.2.0");
    expect(compareVersions("0.2.0", "0.1.9")).toBe(1);
    expect(compareVersions("1.0.0", "1.0.0")).toBe(0);
    expect(compareVersions("1.0.0", "1.0.1")).toBe(-1);
  });

  it("offers an update only when the stable Release has both verified assets", async () => {
    const root = await updaterRoot();
    const service = new GitHubUpdateService({
      installRoot: root,
      currentVersion: "0.1.0",
      repository: "Akusative/QQ-Codex-Bridge",
      platform: "win32",
      fetchImpl: async () => new Response(JSON.stringify({
        tag_name: "v0.2.0",
        html_url: "https://github.com/Akusative/QQ-Codex-Bridge/releases/tag/v0.2.0",
        published_at: "2026-06-20T00:00:00Z",
        body: "新增一键更新。",
        draft: false,
        prerelease: false,
        assets: [
          { name: "QQ-Codex-Bridge-Windows-Update.zip", browser_download_url: "https://example.invalid/update.zip" },
          { name: "QQ-Codex-Bridge-Windows-Update.zip.sha256", browser_download_url: "https://example.invalid/update.zip.sha256" },
        ],
      }), { status: 200 }),
    });

    await expect(service.status(true)).resolves.toMatchObject({
      currentVersion: "0.1.0",
      latestVersion: "0.2.0",
      updateAvailable: true,
      canApply: true,
    });
  });

  it("reports a repository with no formal Release without treating it as an update", async () => {
    const service = new GitHubUpdateService({
      installRoot: await updaterRoot(),
      currentVersion: "0.2.0",
      repository: "Akusative/QQ-Codex-Bridge",
      platform: "win32",
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });

    await expect(service.status(true)).resolves.toMatchObject({
      latestVersion: null,
      updateAvailable: false,
      canApply: false,
      message: "GitHub 尚未发布正式 Release。",
    });
  });

  it("reads the updater's recorded run from data/update-status.json", async () => {
    const root = await updaterRoot();
    await mkdir(join(root, "data"), { recursive: true });
    await writeFile(
      join(root, "data", "update-status.json"),
      JSON.stringify({
        state: "succeeded",
        message: "Update installed successfully.",
        version: "0.3.1",
        updatedAt: "2026-06-21T04:20:32.000Z",
      }),
      "utf8",
    );
    const service = new GitHubUpdateService({
      installRoot: root,
      currentVersion: "0.3.1",
      repository: "Akusative/QQ-Codex-Bridge",
      platform: "win32",
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });

    await expect(service.localStatus()).resolves.toEqual({
      state: "succeeded",
      message: "Update installed successfully.",
      version: "0.3.1",
      updatedAt: "2026-06-21T04:20:32.000Z",
    });
  });

  it("returns null when no updater run has been recorded", async () => {
    const service = new GitHubUpdateService({
      installRoot: await updaterRoot(),
      currentVersion: "0.3.1",
      repository: "Akusative/QQ-Codex-Bridge",
      platform: "win32",
      fetchImpl: async () => new Response("{}", { status: 404 }),
    });

    await expect(service.localStatus()).resolves.toBeNull();
  });
});
