import { randomBytes } from "node:crypto";
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, relative, resolve, sep } from "node:path";
import { spawn } from "node:child_process";
import { classifySensitiveContent } from "../security/sensitive-content-policy.js";
import type { MemoryCandidate, MemoryCategory } from "./memory-commands.js";

export interface MemoryListEntry {
  relativePath: string;
  title: string;
  category: MemoryCategory;
  updatedAt: string;
}

export interface ApprovedMemoryEntry extends MemoryListEntry {
  summary: string;
}

export interface MemoryMutationResult {
  synced: boolean;
}

export interface MemorySyncResult {
  state: "up-to-date" | "pulled" | "pushed";
}

export class MemoryRepositoryError extends Error {
  constructor(
    readonly code:
      | "unavailable"
      | "dirty"
      | "unsafe"
      | "invalid"
      | "conflict"
      | "sync-failed",
  ) {
    super(code);
  }
}

export class MemoryRepository {
  private contextCache:
    | { head: string; entries: ReadonlyArray<ApprovedMemoryEntry> }
    | undefined;

  constructor(
    private root: string,
    private readonly expectedRemote?: string,
  ) {
    this.root = resolve(root);
  }

  getRoot(): string {
    return this.root;
  }

  async switchRoot(root: string): Promise<void> {
    const previousRoot = this.root;
    const previousCache = this.contextCache;
    this.root = resolve(root);
    this.contextCache = undefined;
    try {
      await this.readApprovedMemories();
    } catch (error) {
      this.root = previousRoot;
      this.contextCache = previousCache;
      throw error;
    }
  }

  async status(): Promise<{ available: boolean; count: number }> {
    try {
      const entries = await this.readApprovedMemories();
      return { available: true, count: entries.length };
    } catch {
      return { available: false, count: 0 };
    }
  }

  async readApprovedMemories(): Promise<ReadonlyArray<ApprovedMemoryEntry>> {
    const { approvedRoot } = await this.ensureReady();
    await this.ensureClean();
    const head = (await this.runGit(["rev-parse", "HEAD"])).trim();
    if (this.contextCache?.head === head) return this.contextCache.entries;

    await this.validate();
    const files = await collectFiles(approvedRoot);
    const memories: ApprovedMemoryEntry[] = [];
    for (const file of files) {
      if (!file.endsWith(".memory.md")) continue;
      const text = await readFile(file, "utf8");
      const fields = parseFrontmatter(text);
      if (
        !fields ||
        !isMemoryCategory(fields.category) ||
        fields.status !== "approved" ||
        fields.sensitivity !== "low" ||
        fields.source !== "user-confirmed"
      ) {
        throw new MemoryRepositoryError("invalid");
      }
      const summary = extractSection(text, "摘要");
      if (!summary || summary.length > 1_000) {
        throw new MemoryRepositoryError("invalid");
      }
      const title = fields.title || basename(file, ".memory.md");
      assertMemoryTextSafe(`${title}\n${summary}`);
      memories.push({
        relativePath: normalizeGitPath(relative(this.root, file)),
        title,
        category: fields.category,
        updatedAt: fields.updated_at || "",
        summary,
      });
    }
    memories.sort(
      (left, right) =>
        right.updatedAt.localeCompare(left.updatedAt) ||
        left.title.localeCompare(right.title, "zh-CN"),
    );
    const entries = Object.freeze(memories.map((entry) => Object.freeze(entry)));
    this.contextCache = { head, entries };
    return entries;
  }

  async list(): Promise<MemoryListEntry[]> {
    return (await this.readApprovedMemories()).map(
      ({ summary: _summary, ...metadata }) => metadata,
    );
  }

  async add(candidate: MemoryCandidate): Promise<MemoryMutationResult> {
    await this.sync();
    const ready = await this.ensureReady();
    await this.ensureClean();
    this.assertCandidateSafe(candidate);

    const date = chinaDate();
    const suffix = randomBytes(4).toString("hex");
    const id = `mem-${date.replaceAll("-", "")}-memory-${suffix}`;
    const correctedRelativePath = normalizeGitPath(
      join(
        "approved",
        categoryFolder(candidate.category),
        `${date}-memory-${suffix}.memory.md`,
      ),
    );
    const absolutePath = resolve(this.root, correctedRelativePath);
    assertInside(ready.approvedRoot, absolutePath);
    await mkdir(resolve(this.root, "approved", categoryFolder(candidate.category)), {
      recursive: true,
    });

    const body = renderMemory({ ...candidate, id, date });
    let committed = false;
    try {
      await writeFile(absolutePath, body, { encoding: "utf8", flag: "wx" });
      await this.validate();
      await this.runGit(["add", "--", correctedRelativePath]);
      await this.assertOnlyStaged(correctedRelativePath);
      await this.runGit(["commit", "-m", `Add approved memory ${id}`]);
      committed = true;
      this.contextCache = undefined;
    } catch (error) {
      if (!committed) {
        await this.runGit(["reset", "--", correctedRelativePath], true);
        await rm(absolutePath, { force: true });
      }
      if (error instanceof MemoryRepositoryError) throw error;
      throw new MemoryRepositoryError("invalid");
    }

    if (!this.expectedRemote) return { synced: true };
    try {
      await this.runGit(["push", "origin", "main"]);
      return { synced: true };
    } catch {
      return { synced: false };
    }
  }

  async remove(entry: MemoryListEntry): Promise<MemoryMutationResult> {
    await this.sync();
    const ready = await this.ensureReady();
    await this.ensureClean();
    const absolutePath = resolve(this.root, entry.relativePath);
    assertInside(ready.approvedRoot, absolutePath);
    const stat = await lstat(absolutePath).catch(() => undefined);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new MemoryRepositoryError("invalid");
    const backup = await readFile(absolutePath, "utf8");
    let committed = false;
    try {
      await rm(absolutePath);
      await this.validate();
      await this.runGit(["add", "--", entry.relativePath]);
      await this.assertOnlyStaged(entry.relativePath);
      await this.runGit(["commit", "-m", "Remove approved memory"]);
      committed = true;
      this.contextCache = undefined;
    } catch (error) {
      if (!committed) {
        await this.runGit(["reset", "--", entry.relativePath], true);
        await writeFile(absolutePath, backup, "utf8");
      }
      if (error instanceof MemoryRepositoryError) throw error;
      throw new MemoryRepositoryError("invalid");
    }

    if (!this.expectedRemote) return { synced: true };
    try {
      await this.runGit(["push", "origin", "main"]);
      return { synced: true };
    } catch {
      return { synced: false };
    }
  }

  async sync(): Promise<MemorySyncResult> {
    await this.ensureReady();
    await this.ensureClean();
    if (!this.expectedRemote) {
      await this.readApprovedMemories();
      return { state: "up-to-date" };
    }
    await this.runGit(["fetch", "origin", "main"]);
    const localHead = (await this.runGit(["rev-parse", "HEAD"])).trim();
    const remoteHead = (
      await this.runGit(["rev-parse", "refs/remotes/origin/main"])
    ).trim();

    if (localHead === remoteHead) {
      await this.readApprovedMemories();
      return { state: "up-to-date" };
    }

    if (await this.isAncestor(localHead, remoteHead)) {
      await this.validateRevision(remoteHead);
      await this.runGit(["merge", "--ff-only", "refs/remotes/origin/main"]);
      this.contextCache = undefined;
      await this.readApprovedMemories();
      return { state: "pulled" };
    }

    if (await this.isAncestor(remoteHead, localHead)) {
      await this.readApprovedMemories();
      await this.runGit(["push", "origin", "main"]);
      return { state: "pushed" };
    }

    throw new MemoryRepositoryError("conflict");
  }

  private async ensureReady(): Promise<{ approvedRoot: string }> {
    const root = await realpath(this.root).catch(() => undefined);
    if (!root) throw new MemoryRepositoryError("unavailable");
    const gitStat = await lstat(join(root, ".git")).catch(() => undefined);
    if (!gitStat?.isDirectory()) throw new MemoryRepositoryError("unavailable");
    const approvedRoot = await realpath(join(root, "approved")).catch(() => undefined);
    if (!approvedRoot) throw new MemoryRepositoryError("unavailable");
    if (this.expectedRemote) {
      const remote = (await this.runGit(["remote", "get-url", "origin"])).trim();
      if (remote !== this.expectedRemote) throw new MemoryRepositoryError("unavailable");
    }
    return { approvedRoot };
  }

  private async ensureClean(): Promise<void> {
    const status = await this.runGit(["status", "--porcelain", "--untracked-files=all"]);
    if (status.trim()) throw new MemoryRepositoryError("dirty");
  }

  private assertCandidateSafe(candidate: MemoryCandidate): void {
    const text = `${candidate.title}\n${candidate.summary}\n${candidate.forgetCondition}`;
    assertMemoryTextSafe(text);
  }

  private async validate(): Promise<void> {
    const result = await runProcess(process.execPath, ["scripts/validate-memory.mjs"], this.root);
    if (result.code !== 0) throw new MemoryRepositoryError("invalid");
  }

  private async validateRevision(revision: string): Promise<void> {
    const temporaryRoot = await mkdtemp(join(tmpdir(), "qq-codex-memory-check-"));
    assertInside(resolve(tmpdir()), temporaryRoot);
    let worktreeAdded = false;
    try {
      await this.runGit(["worktree", "add", "--detach", temporaryRoot, revision]);
      worktreeAdded = true;
      const validator = join(this.root, "scripts", "validate-memory.mjs");
      const result = await runProcess(
        process.execPath,
        [validator, "--root", temporaryRoot],
        this.root,
      );
      if (result.code !== 0) throw new MemoryRepositoryError("invalid");
    } finally {
      if (worktreeAdded) {
        await this.runGit(["worktree", "remove", "--force", temporaryRoot], true);
      }
      assertInside(resolve(tmpdir()), temporaryRoot);
      await rm(temporaryRoot, { recursive: true, force: true });
    }
  }

  private async isAncestor(ancestor: string, descendant: string): Promise<boolean> {
    const result = await runProcess(
      "git",
      ["merge-base", "--is-ancestor", ancestor, descendant],
      this.root,
    );
    if (result.code === 0) return true;
    if (result.code === 1) return false;
    throw new MemoryRepositoryError("unavailable");
  }

  private async assertOnlyStaged(expectedPath: string): Promise<void> {
    const staged = (await this.runGit(["diff", "--cached", "--name-only"]))
      .split(/\r?\n/)
      .filter(Boolean);
    if (staged.length !== 1 || staged[0] !== normalizeGitPath(expectedPath)) {
      throw new MemoryRepositoryError("dirty");
    }
  }

  private async runGit(args: string[], allowFailure = false): Promise<string> {
    const result = await runProcess("git", args, this.root);
    if (result.code !== 0 && !allowFailure) throw new MemoryRepositoryError("unavailable");
    return result.stdout;
  }
}

function categoryFolder(category: MemoryCategory): string {
  return {
    preference: "preferences",
    person: "people",
    project: "projects",
    event: "events",
    rule: "rules",
  }[category];
}

function renderMemory(candidate: MemoryCandidate & { id: string; date: string }): string {
  return [
    "---",
    `id: ${candidate.id}`,
    `title: ${candidate.title}`,
    `category: ${candidate.category}`,
    "status: approved",
    `created_at: ${candidate.date}`,
    `updated_at: ${candidate.date}`,
    "sensitivity: low",
    "source: user-confirmed",
    `tags: ${candidate.category}`,
    "---",
    "",
    "## 摘要",
    "",
    candidate.summary,
    "",
    "## 更新或遗忘条件",
    "",
    candidate.forgetCondition,
    "",
  ].join("\n");
}

function parseFrontmatter(text: string): Record<string, string> | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n/);
  if (!match) return undefined;
  const fields: Record<string, string> = {};
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator < 1) continue;
    fields[line.slice(0, separator).trim()] = line.slice(separator + 1).trim();
  }
  return fields;
}

function extractSection(text: string, heading: string): string | undefined {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const match = text.match(
    new RegExp(`(?:^|\\r?\\n)## ${escaped}\\r?\\n+([\\s\\S]*?)(?=\\r?\\n## |$)`),
  );
  return match?.[1].replace(/\s+/g, " ").trim() || undefined;
}

function assertMemoryTextSafe(text: string): void {
  if (
    classifySensitiveContent(text).blocked ||
    /(?:QQ号|QQ号码|QQ\s*ID|账号|身份证|银行卡|手机号|手机号码|邮箱)\s*(?:是|为|[：:=])\s*\S+/i.test(
      text,
    ) ||
    /\b\d{5,18}\b/.test(text)
  ) {
    throw new MemoryRepositoryError("unsafe");
  }
}

async function collectFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const child = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await collectFiles(child)));
    if (entry.isFile()) files.push(child);
  }
  return files;
}

function assertInside(root: string, target: string): void {
  const normalizedRoot = resolve(root);
  const normalizedTarget = resolve(target);
  if (
    normalizedTarget !== normalizedRoot &&
    !normalizedTarget.startsWith(`${normalizedRoot}${sep}`)
  ) {
    throw new MemoryRepositoryError("invalid");
  }
}

function normalizeGitPath(path: string): string {
  return path.replaceAll("\\", "/");
}

function chinaDate(): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date());
}

function isMemoryCategory(value: string | undefined): value is MemoryCategory {
  return ["preference", "person", "project", "event", "rule"].includes(value ?? "");
}

async function runProcess(
  command: string,
  args: string[],
  cwd: string,
): Promise<{ code: number; stdout: string }> {
  return await new Promise((resolvePromise, reject) => {
    const child = spawn(command, args, {
      cwd,
      windowsHide: true,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.once("error", reject);
    child.once("close", (code) => resolvePromise({ code: code ?? 1, stdout }));
  });
}
