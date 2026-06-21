import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MemoryDecayRecord {
  lastReferencedAt: string;
  referenceCount: number;
}

type DecayState = Record<string, MemoryDecayRecord>;

/**
 * 记忆衰减状态（本地，不进 git 记忆库）。
 * 键用 .memory.md 的 relativePath（稳定）。记录"最近一次被选用的时间"和"被选用次数"，
 * 供 selectRelevantMemories 给老记忆降权。每轮选用后 touch 一次以"提鲜"。
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

  /** 返回一个同步查询函数，供选用逻辑批量读取（避免逐条 await）。 */
  async snapshot(): Promise<(id: string) => MemoryDecayRecord | undefined> {
    const state = await this.read();
    return (id) => state[id];
  }

  /** 提鲜：刷新这些记忆的 lastReferencedAt 并累加 referenceCount。 */
  async touch(ids: ReadonlyArray<string>, now = new Date()): Promise<void> {
    if (ids.length === 0) return;
    const state = { ...(await this.read()) };
    const stamp = now.toISOString();
    for (const id of ids) {
      const previous = state[id];
      state[id] = {
        lastReferencedAt: stamp,
        referenceCount: (previous?.referenceCount ?? 0) + 1,
      };
    }
    await this.write(state);
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
  return Object.values(value as Record<string, unknown>).every(
    (record) =>
      !!record &&
      typeof record === "object" &&
      typeof (record as MemoryDecayRecord).lastReferencedAt === "string" &&
      typeof (record as MemoryDecayRecord).referenceCount === "number",
  );
}
