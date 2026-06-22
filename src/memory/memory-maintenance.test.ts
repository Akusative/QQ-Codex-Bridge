import { describe, it, expect, vi } from "vitest";
import {
  clusterByCosine,
  groupByWindow,
  isDead,
  MemoryMaintenanceCoordinator,
  pickSurvivor,
} from "./memory-maintenance.js";
import type { ApprovedMemoryEntry } from "./memory-repository.js";

function entry(over: Partial<ApprovedMemoryEntry> & { relativePath: string }): ApprovedMemoryEntry {
  return {
    title: over.title ?? "标题",
    category: over.category ?? "event",
    updatedAt: over.updatedAt ?? "2026-06-21",
    summary: over.summary ?? "摘要",
    relativePath: over.relativePath,
  };
}

const NOW = new Date("2026-06-21T00:00:00Z");
const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as never;

describe("clusterByCosine", () => {
  it("近重复聚成一簇，无关的独立", () => {
    const clusters = clusterByCosine([[1, 0, 0], [0.99, 0.01, 0], [0, 1, 0]], 0.95);
    const sizes = clusters.map((c) => c.length).sort();
    expect(sizes).toEqual([1, 2]);
  });
});

describe("isDead", () => {
  it("非 preference、refCount0、超龄 → 死", () => {
    expect(isDead(entry({ relativePath: "a", updatedAt: "2026-01-01" }), undefined, 90, NOW)).toBe(true);
  });
  it("被引用过 → 不死", () => {
    expect(isDead(entry({ relativePath: "a", updatedAt: "2026-01-01" }), { referenceCount: 2 }, 90, NOW)).toBe(false);
  });
  it("preference 永不死", () => {
    expect(isDead(entry({ relativePath: "a", category: "preference", updatedAt: "2020-01-01" }), undefined, 90, NOW)).toBe(false);
  });
  it("未超龄 → 不死", () => {
    expect(isDead(entry({ relativePath: "a", updatedAt: "2026-06-20" }), undefined, 90, NOW)).toBe(false);
  });
});

describe("pickSurvivor / groupByWindow", () => {
  it("留最新", () => {
    const s = pickSurvivor([
      entry({ relativePath: "a", updatedAt: "2026-06-01" }),
      entry({ relativePath: "b", updatedAt: "2026-06-20" }),
    ]);
    expect(s.relativePath).toBe("b");
  });
  it("按 key 分组，缺 key 归一组", () => {
    const groups = groupByWindow([{ k: "x" }, { k: "x" }, { k: undefined }], (i) => i.k);
    expect(groups.map((g) => g.length).sort()).toEqual([1, 2]);
  });
});

// ---- 集成：用内存假存储 ----
function makeFakes(entries: ApprovedMemoryEntry[], records: Record<string, { referenceCount?: number; conversationId?: string; lastReferencedAt?: string }>, vectors: Record<string, number[]>) {
  const memEntries = [...entries];
  const decay = { ...records };
  const vec = { ...vectors };
  return {
    memory: {
      readApprovedMemories: async () => memEntries.filter((e) => memEntries.includes(e)),
      remove: vi.fn(async (e: ApprovedMemoryEntry) => {
        const i = memEntries.findIndex((m) => m.relativePath === e.relativePath);
        if (i >= 0) memEntries.splice(i, 1);
      }),
    },
    decayStore: {
      snapshot: async () => (id: string) => decay[id],
      reinforce: vi.fn(async (ids: string[], amount: number) => {
        for (const id of ids) decay[id] = { ...decay[id], referenceCount: (decay[id]?.referenceCount ?? 0) + amount };
      }),
      removeMany: vi.fn(async (ids: string[]) => { for (const id of ids) delete decay[id]; }),
    },
    vectorStore: {
      snapshot: async () => (id: string) => (vec[id] ? { vector: vec[id] } : undefined),
      removeMany: vi.fn(async (ids: string[]) => { for (const id of ids) delete vec[id]; }),
    },
    state: { memEntries, decay, vec },
  };
}

describe("MemoryMaintenanceCoordinator", () => {
  it("一簇近重复 → 留 1、强化、其余从三处全删", async () => {
    const entries = [
      entry({ relativePath: "a", updatedAt: "2026-06-01" }),
      entry({ relativePath: "b", updatedAt: "2026-06-10" }),
      entry({ relativePath: "c", updatedAt: "2026-06-20" }), // 最新 → 幸存
    ];
    const f = makeFakes(
      entries,
      { a: { conversationId: "w1" }, b: { conversationId: "w1" }, c: { conversationId: "w1" } },
      { a: [1, 0, 0], b: [0.99, 0.01, 0], c: [0.98, 0.02, 0] },
    );
    const coord = new MemoryMaintenanceCoordinator({ ...f, logger, pruneDays: 0 });
    await coord.runOnce(NOW);

    expect(f.state.memEntries.map((e) => e.relativePath)).toEqual(["c"]);
    expect(f.decayStore.reinforce).toHaveBeenCalledWith(["c"], 3, NOW); // 0+0+0 refCount + 簇大小3
    expect(f.state.decay.a).toBeUndefined();
    expect(f.state.vec.a).toBeUndefined();
    expect(f.state.decay.c?.referenceCount).toBe(3);
  });

  it("跨窗口不互相去重", async () => {
    const entries = [entry({ relativePath: "a" }), entry({ relativePath: "b" })];
    const f = makeFakes(
      entries,
      { a: { conversationId: "w1" }, b: { conversationId: "w2" } },
      { a: [1, 0], b: [1, 0] }, // 向量相同但不同窗口
    );
    const coord = new MemoryMaintenanceCoordinator({ ...f, logger, pruneDays: 0 });
    await coord.runOnce(NOW);
    expect(f.state.memEntries).toHaveLength(2);
  });

  it("硬清理：死记忆删、preference 留", async () => {
    const entries = [
      entry({ relativePath: "dead", updatedAt: "2026-01-01" }),
      entry({ relativePath: "pref", category: "preference", updatedAt: "2026-01-01" }),
      entry({ relativePath: "used", updatedAt: "2026-01-01" }),
    ];
    const f = makeFakes(entries, { used: { referenceCount: 1 } }, {});
    const coord = new MemoryMaintenanceCoordinator({ ...f, logger, vectorStore: undefined, pruneDays: 90 });
    await coord.runOnce(NOW);
    expect(f.state.memEntries.map((e) => e.relativePath).sort()).toEqual(["pref", "used"]);
  });
});
