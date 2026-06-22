import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MemoryDecayRecord {
  lastReferencedAt?: string;
  referenceCount?: number;
  conversationId?: string;
}

type DecayState = Record<string, MemoryDecayRecord>;

/**
 * 记忆侧车（本地，不进 git 记忆库）。键用 .memory.md 的 relativePath（稳定）。
 * 同时记录：衰减状态（lastReferencedAt / referenceCount，供降权与提鲜）
 * 以及窗口归属（conversationId，供按对话窗口隔离记忆）。
 */
export class MemoryDecayStore {
  private cache: DecayState | undefined;

  constructor(private readonly filePath: string) {}

  private async read(): Promise<DecayState> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.cache = isDecayState(parsed) ? parsed : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(state: DecayState): Promise<void> {
    this.cache = state;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  async get(id: string): Promise<MemoryDecayRecord | undefined> {
    return (await this.read())[id];
  }

  /** 返回一个同步查询函数；记录里带 conversationId，既供衰减也供窗口过滤。 */
  async snapshot(): Promise<(id: string) => MemoryDecayRecord | undefined> {
    const state = await this.read();
    return (id) => state[id];
  }

  /** 提鲜：刷新这些记忆的 lastReferencedAt 并累加 referenceCount，保留 conversationId。 */
  async touch(ids: ReadonlyArray<string>, now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    const state = { ...(await this.read()) };
    const stamp = now.toISOString();
    for (const id of ids) {
      const previous = state[id];
      state[id] = {
        ...previous,
        lastReferencedAt: stamp,
        referenceCount: (previous?.referenceCount ?? 0) + 1,
      };
    }
    await this.write(state);
  }

  /** 强化：按量累加 referenceCount 并刷新时间（去重合并时把整簇的份量并到幸存者）。 */
  async reinforce(ids: ReadonlyArray<string>, amount: number, now = new Date()): Promise<void> {
    if (ids.length === 0 || amount <= 0) return;
    const state = { ...(await this.read()) };
    const stamp = now.toISOString();
    for (const id of ids) {
      const previous = state[id];
      state[id] = {
        ...previous,
        lastReferencedAt: stamp,
        referenceCount: (previous?.referenceCount ?? 0) + amount,
      };
    }
    await this.write(state);
  }

  /** 给某条记忆打上窗口归属，保留已有衰减状态。 */
  async assign(id: string, conversationId: string): Promise<void> {
    const state = { ...(await this.read()) };
    state[id] = { ...state[id], conversationId };
    await this.write(state);
  }

  /** 某窗口名下的全部记忆 relativePath。 */
  async pathsForConversation(conversationId: string): Promise<string[]> {
    const state = await this.read();
    return Object.entries(state)
      .filter(([, record]) => record.conversationId === conversationId)
      .map(([id]) => id);
  }

  /** 删除这些侧车项（删窗口或遗忘记忆时调用）。 */
  async removeMany(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    const state = await this.read();
    const next: DecayState = {};
    let changed = false;
    for (const [id, record] of Object.entries(state)) {
      if (remove.has(id)) changed = true;
      else next[id] = record;
    }
    if (changed) await this.write(next);
  }

  /** 清理已不存在记忆的残留项。 */
  async prune(validIds: ReadonlyArray<string>): Promise<void> {
    const valid = new Set(validIds);
    const state = await this.read();
    const next: DecayState = {};
    let changed = false;
    for (const [id, record] of Object.entries(state)) {
      if (valid.has(id)) next[id] = record;
      else changed = true;
    }
    if (changed) await this.write(next);
  }
}

function isDecayState(value: unknown): value is DecayState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((record) => {
    if (!record || typeof record !== "object") return false;
    const r = record as MemoryDecayRecord;
    return (
      (r.lastReferencedAt === undefined || typeof r.lastReferencedAt === "string") &&
      (r.referenceCount === undefined || typeof r.referenceCount === "number") &&
      (r.conversationId === undefined || typeof r.conversationId === "string")
    );
  });
}
