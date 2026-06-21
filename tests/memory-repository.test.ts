import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MemoryRepository,
  MemoryRepositoryError,
} from "../src/memory/memory-repository.js";

const execFileAsync = promisify(execFile);

// 该套件 spawn 大量真实 git 子进程，Windows/CI 上较慢；放宽超时避免假阳性超时。
vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 })));
});

async function fixture(): Promise<{
  root: string;
  remote: string;
  repository: MemoryRepository;
}> {
  const parent = await mkdtemp(join(tmpdir(), "memory-repo-test-"));
  roots.push(parent);
  const root = join(parent, "work");
  const remote = join(parent, "remote.git");
  await mkdir(root);
  await execFileAsync("git", ["init", "--bare", "--initial-branch=main", remote]);
  await mkdir(join(root, "approved", "preferences"), { recursive: true });
  for (const folder of ["people", "projects", "events", "rules"]) {
    await mkdir(join(root, "approved", folder), { recursive: true });
  }
  await mkdir(join(root, "scripts"), { recursive: true });
  await writeFile(
    join(root, "scripts", "validate-memory.mjs"),
    "console.log('PASS synthetic validator');\n",
    "utf8",
  );
  await execFileAsync("git", ["init", "-b", "main"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "Bridge Test"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "bridge-test@example.invalid"], {
    cwd: root,
  });
  await execFileAsync("git", ["remote", "add", "origin", remote], {
    cwd: root,
  });
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", "fixture"], { cwd: root });
  await execFileAsync("git", ["push", "-u", "origin", "main"], { cwd: root });
  return {
    root,
    remote,
    repository: new MemoryRepository(root, remote),
  };
}

describe("MemoryRepository", () => {
  it("lists only approved memory metadata", async () => {
    const { root, repository } = await fixture();
    await writeFile(
      join(root, "approved", "preferences", "2026-06-19-memory-a1b2c3d4.memory.md"),
      [
        "---",
        "id: mem-20260619-memory-a1b2c3d4",
        "title: 简洁回复",
        "category: preference",
        "status: approved",
        "created_at: 2026-06-19",
        "updated_at: 2026-06-19",
        "sensitivity: low",
        "source: user-confirmed",
        "tags: preference",
        "---",
        "",
        "## 摘要",
        "",
        "合成测试摘要。",
        "",
        "## 更新或遗忘条件",
        "",
        "用户提出修改时。",
      ].join("\n"),
      "utf8",
    );
    await execFileAsync("git", ["add", "."], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "add approved fixture memory"], {
      cwd: root,
    });
    const entries = await repository.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "简洁回复", category: "preference" });
    const approved = await repository.readApprovedMemories();
    expect(approved[0].summary).toBe("合成测试摘要。");
  });

  it("refuses to mutate a dirty repository", async () => {
    const { root, repository } = await fixture();
    await writeFile(join(root, "untracked.txt"), "synthetic", "utf8");
    await expect(
      repository.add({
        category: "preference",
        title: "简洁回复",
        summary: "用户确认的长期偏好是：回复简洁。",
        forgetCondition: "用户提出修改时。",
      }),
    ).rejects.toMatchObject({ code: "dirty" } satisfies Partial<MemoryRepositoryError>);
  });

  it("refuses a repository with an unexpected remote", async () => {
    const { root } = await fixture();
    const repository = new MemoryRepository(root, "https://example.invalid/other.git");
    expect(await repository.status()).toEqual({ available: false, count: 0 });
  });

  it("writes, commits, pushes, lists and removes an approved memory", async () => {
    const { root, repository } = await fixture();
    const added = await repository.add({
      category: "preference",
      title: "简洁回复",
      summary: "用户确认的长期偏好是：回复简洁。",
      forgetCondition: "用户提出修改时。",
    });
    expect(added).toEqual({ synced: true });
    const entries = await repository.list();
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({ title: "简洁回复", category: "preference" });

    const removed = await repository.remove(entries[0]);
    expect(removed).toEqual({ synced: true });
    expect(await repository.list()).toEqual([]);
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: root,
    });
    expect(status.trim()).toBe("");
  });

  it("writes and removes memories without contacting a remote in local-only mode", async () => {
    const { root } = await fixture();
    await execFileAsync("git", ["remote", "remove", "origin"], { cwd: root });
    const repository = new MemoryRepository(root);

    expect(await repository.sync()).toEqual({ state: "up-to-date" });
    expect(await repository.add({
      category: "preference",
      title: "本地记忆",
      summary: "这条合成测试记忆只保存在本地。",
      forgetCondition: "用户提出删除时。",
    })).toEqual({ synced: true });
    const entries = await repository.list();
    expect(entries).toHaveLength(1);
    expect(await repository.remove(entries[0])).toEqual({ synced: true });
    expect(await repository.list()).toEqual([]);
  });

  it("validates and fast-forwards a remote-only update", async () => {
    const { remote, repository } = await fixture();
    const other = await cloneFixtureRemote(remote);
    await writeFile(join(other, "remote-note.md"), "synthetic remote update\n", "utf8");
    await commitAndPush(other, "remote update");

    expect(await repository.sync()).toEqual({ state: "pulled" });
    expect(await repository.sync()).toEqual({ state: "up-to-date" });
  });

  it("pushes a clean local-only update", async () => {
    const { root, repository } = await fixture();
    await writeFile(join(root, "local-note.md"), "synthetic local update\n", "utf8");
    await execFileAsync("git", ["add", "local-note.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "local update"], { cwd: root });

    expect(await repository.sync()).toEqual({ state: "pushed" });
    expect(await repository.sync()).toEqual({ state: "up-to-date" });
  });

  it("refuses to merge diverged device histories", async () => {
    const { root, remote, repository } = await fixture();
    await writeFile(join(root, "local-note.md"), "synthetic local update\n", "utf8");
    await execFileAsync("git", ["add", "local-note.md"], { cwd: root });
    await execFileAsync("git", ["commit", "-m", "local update"], { cwd: root });

    const other = await cloneFixtureRemote(remote);
    await writeFile(join(other, "remote-note.md"), "synthetic remote update\n", "utf8");
    await commitAndPush(other, "remote update");

    await expect(repository.sync()).rejects.toMatchObject({ code: "conflict" });
    const { stdout: status } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: root,
    });
    expect(status.trim()).toBe("");
  });
});

async function cloneFixtureRemote(remote: string): Promise<string> {
  const clone = await mkdtemp(join(tmpdir(), "memory-repo-device-"));
  roots.push(clone);
  await execFileAsync("git", ["clone", remote, clone]);
  await execFileAsync("git", ["config", "user.name", "Bridge Test Device"], {
    cwd: clone,
  });
  await execFileAsync("git", ["config", "user.email", "device@example.invalid"], {
    cwd: clone,
  });
  return clone;
}

async function commitAndPush(root: string, message: string): Promise<void> {
  await execFileAsync("git", ["add", "."], { cwd: root });
  await execFileAsync("git", ["commit", "-m", message], { cwd: root });
  await execFileAsync("git", ["push", "origin", "main"], { cwd: root });
}
