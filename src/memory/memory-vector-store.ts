import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export interface MemoryVectorRecord {
  model: string;
  vector: number[];
}

type VectorState = Record<string, MemoryVectorRecord>;

/**
 * 记忆向量存储（本地，不进 git）。键用 .memory.md 的 relativePath。
 * 记 model 标签：换 embedding 模型时旧向量视为失效、触发重算。
 */
export class MemoryVectorStore {
  private cache: VectorState | undefined;

  constructor(private readonly filePath: string) {}

  private async read(): Promise<VectorState> {
    if (this.cache) return this.cache;
    try {
      const raw = await readFile(this.filePath, "utf8");
      const parsed = JSON.parse(raw) as unknown;
      this.cache = isVectorState(parsed) ? parsed : {};
    } catch {
      this.cache = {};
    }
    return this.cache;
  }

  private async write(state: VectorState): Promise<void> {
    this.cache = state;
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporary = `${this.filePath}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(state)}\n`, "utf8");
    await rename(temporary, this.filePath);
  }

  async snapshot(): Promise<(id: string) => MemoryVectorRecord | undefined> {
    const state = await this.read();
    return (id) => state[id];
  }

  async set(id: string, model: string, vector: number[]): Promise<void> {
    const state = { ...(await this.read()) };
    state[id] = { model, vector };
    await this.write(state);
  }

  /** 批量写入（回填用），单次落盘。 */
  async setMany(entries: ReadonlyArray<{ id: string; model: string; vector: number[] }>): Promise<void> {
    if (entries.length === 0) return;
    const state = { ...(await this.read()) };
    for (const { id, model, vector } of entries) state[id] = { model, vector };
    await this.write(state);
  }

  async removeMany(ids: ReadonlyArray<string>): Promise<void> {
    if (ids.length === 0) return;
    const remove = new Set(ids);
    const state = await this.read();
    const next: VectorState = {};
    let changed = false;
    for (const [id, record] of Object.entries(state)) {
      if (remove.has(id)) changed = true;
      else next[id] = record;
    }
    if (changed) await this.write(next);
  }

  /** 在给定 path 集合里，缺当前模型向量的（需要回填）。 */
  async missing(ids: ReadonlyArray<string>, model: string): Promise<string[]> {
    const state = await this.read();
    return ids.filter((id) => state[id]?.model !== model);
  }
}

function isVectorState(value: unknown): value is VectorState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value as Record<string, unknown>).every((record) => {
    if (!record || typeof record !== "object") return false;
    const r = record as MemoryVectorRecord;
    return typeof r.model === "string" && Array.isArray(r.vector);
  });
}
