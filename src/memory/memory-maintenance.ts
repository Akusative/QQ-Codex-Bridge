import type { Logger } from "pino";
import { cosine } from "./memory-retrieval.js";
import type { ApprovedMemoryEntry, MemoryListEntry } from "./memory-repository.js";

interface MaintenanceMemoryStore {
  readApprovedMemories(): Promise<ReadonlyArray<ApprovedMemoryEntry>>;
  remove(entry: MemoryListEntry): Promise<unknown>;
}

interface DecayRecord {
  referenceCount?: number;
  conversationId?: string;
  lastReferencedAt?: string;
}

interface MaintenanceDecayStore {
  snapshot(): Promise<(id: string) => DecayRecord | undefined>;
  reinforce(ids: ReadonlyArray<string>, amount: number, now?: Date): Promise<void>;
  removeMany(ids: ReadonlyArray<string>): Promise<void>;
}

interface MaintenanceVectorStore {
  snapshot(): Promise<(id: string) => { vector: number[] } | undefined>;
  removeMany(ids: ReadonlyArray<string>): Promise<void>;
}

export interface MemoryMaintenanceOptions {
  memory: MaintenanceMemoryStore;
  decayStore: MaintenanceDecayStore;
  vectorStore?: MaintenanceVectorStore;
  logger: Logger;
  dedupThreshold?: number;
  pruneDays?: number;
  maintenanceHours?: number;
}

/**
 * 记忆维护：向量去重 + 强化 + 硬清理死记忆。不依赖 LLM。
 * 启动跑一次 + 每 maintenanceHours 跑一次。可降级：无向量时只做硬清理。
 */
export class MemoryMaintenanceCoordinator {
  private timer: NodeJS.Timeout | undefined;
  private running = false;

  constructor(private readonly options: MemoryMaintenanceOptions) {}

  start(): void {
    const hours = this.options.maintenanceHours ?? 24;
    if (this.timer || hours <= 0) return;
    this.timer = setInterval(() => void this.runOnce(), hours * 60 * 60_000);
    this.timer.unref();
    void this.runOnce();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async runOnce(now = new Date()): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const dedupThreshold = this.options.dedupThreshold ?? 0.95;
      const pruneDays = this.options.pruneDays ?? 90;
      let entries = await this.options.memory.readApprovedMemories();
      let merged = 0;
      let pruned = 0;

      // (a) 向量去重 + 强化（按窗口分组；需要向量）。
      if (this.options.vectorStore) {
        const decay = await this.options.decayStore.snapshot();
        const vectors = await this.options.vectorStore.snapshot();
        for (const group of groupByWindow(entries, (e) => decay(e.relativePath)?.conversationId)) {
          const items = group
            .map((entry) => ({ entry, vector: vectors(entry.relativePath)?.vector }))
            .filter((item): item is { entry: ApprovedMemoryEntry; vector: number[] } => !!item.vector);
          for (const cluster of clusterByCosine(items.map((it) => it.vector), dedupThreshold)) {
            if (cluster.length < 2) continue;
            const members = cluster.map((i) => items[i].entry);
            const survivor = pickSurvivor(members);
            const others = members.filter((m) => m.relativePath !== survivor.relativePath);
            // 把整簇的份量并到幸存者：各成员现有 referenceCount 之和 + 簇大小。
            const amount =
              members.reduce((sum, m) => sum + (decay(m.relativePath)?.referenceCount ?? 0), 0) +
              members.length;
            await this.options.decayStore.reinforce([survivor.relativePath], amount, now);
            await this.removeAll(others);
            merged += others.length;
          }
        }
        if (merged > 0) entries = await this.options.memory.readApprovedMemories();
      }

      // (b) 硬清理死记忆（不需向量）。
      if (pruneDays > 0) {
        const decay = await this.options.decayStore.snapshot();
        const dead = entries.filter((entry) => isDead(entry, decay(entry.relativePath), pruneDays, now));
        await this.removeAll(dead);
        pruned = dead.length;
      }

      if (merged > 0 || pruned > 0) {
        this.options.logger.info({ merged, pruned }, "Memory maintenance completed");
      }
    } catch (error) {
      this.options.logger.warn(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Memory maintenance was skipped",
      );
    } finally {
      this.running = false;
    }
  }

  private async removeAll(entries: ReadonlyArray<ApprovedMemoryEntry>): Promise<void> {
    if (entries.length === 0) return;
    for (const entry of entries) {
      try {
        await this.options.memory.remove(entry);
      } catch {
        /* 单条删除失败不阻断整轮维护 */
      }
    }
    const paths = entries.map((entry) => entry.relativePath);
    await this.options.decayStore.removeMany(paths);
    await this.options.vectorStore?.removeMany(paths);
  }
}

export function groupByWindow<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => string | undefined,
): T[][] {
  const groups = new Map<string, T[]>();
  for (const item of items) {
    const key = keyOf(item) ?? "__untagged__";
    const bucket = groups.get(key);
    if (bucket) bucket.push(item);
    else groups.set(key, [item]);
  }
  return [...groups.values()];
}

/** 用 cosine ≥ threshold 把向量聚类（并查集）。返回各簇的下标数组。 */
export function clusterByCosine(vectors: ReadonlyArray<number[]>, threshold: number): number[][] {
  const n = vectors.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (x: number): number => {
    let root = x;
    while (parent[root] !== root) root = parent[root];
    while (parent[x] !== root) {
      const next = parent[x];
      parent[x] = root;
      x = next;
    }
    return root;
  };
  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      if (cosine(vectors[i], vectors[j]) >= threshold) parent[find(i)] = find(j);
    }
  }
  const groups = new Map<number, number[]>();
  for (let i = 0; i < n; i += 1) {
    const root = find(i);
    const bucket = groups.get(root);
    if (bucket) bucket.push(i);
    else groups.set(root, [i]);
  }
  return [...groups.values()];
}

/** 簇里留最新一条（updatedAt 最大，relativePath 做稳定 tiebreak）。 */
export function pickSurvivor(members: ReadonlyArray<ApprovedMemoryEntry>): ApprovedMemoryEntry {
  return [...members].sort(
    (a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.relativePath.localeCompare(b.relativePath),
  )[0];
}

/** 死记忆：非 preference/rule、从未被选用/强化、且超龄。 */
export function isDead(
  entry: ApprovedMemoryEntry,
  record: DecayRecord | undefined,
  pruneDays: number,
  now: Date,
): boolean {
  if (entry.category === "preference" || entry.category === "rule") return false;
  if ((record?.referenceCount ?? 0) > 0) return false;
  const reference = record?.lastReferencedAt || entry.updatedAt;
  const then = new Date(reference).getTime();
  if (Number.isNaN(then)) return false;
  const ageDays = (now.getTime() - then) / 86_400_000;
  return ageDays > pruneDays;
}
