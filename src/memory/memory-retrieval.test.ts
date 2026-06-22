import { describe, it, expect, vi } from "vitest";
import { bm25, buildHybridRelevance, cosine, MemoryVectorIndexer } from "./memory-retrieval.js";
import { MemoryVectorStore } from "./memory-vector-store.js";
import type { TextEmbedder } from "./embedding-client.js";
import type { ApprovedMemoryEntry } from "./memory-repository.js";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

function entry(relativePath: string, title: string, summary: string): ApprovedMemoryEntry {
  return { relativePath, title, category: "event", updatedAt: "2026-06-21", summary };
}

function fakeEmbedder(map: Record<string, number[]>, model = "bge-m3"): TextEmbedder {
  return { model, embed: vi.fn(async (texts: string[]) => texts.map((t) => map[t] ?? [0, 0, 0])) };
}

describe("cosine", () => {
  it("相同方向=1，正交=0", () => {
    expect(cosine([1, 0], [2, 0])).toBeCloseTo(1);
    expect(cosine([1, 0], [0, 1])).toBeCloseTo(0);
  });
  it("长度不一致或空=0", () => {
    expect(cosine([1], [1, 2])).toBe(0);
    expect(cosine([], [])).toBe(0);
  });
});

describe("bm25", () => {
  it("命中关键词的文档得分更高", () => {
    const entries = [
      entry("a", "加班", "加班到凌晨两点"),
      entry("b", "天气", "今天天气不错"),
    ];
    const scores = bm25("加班", entries);
    expect(scores[0]).toBeGreaterThan(scores[1]);
  });
});

describe("buildHybridRelevance", () => {
  const entries = [
    entry("a.md", "加班", "加班到凌晨"),
    entry("b.md", "蛋糕", "准备了生日蛋糕"),
  ];

  it("向量相近的记忆得分更高", async () => {
    const embedder = fakeEmbedder({
      "最近太累": [1, 0, 0],
      "加班 加班到凌晨": [0.9, 0.1, 0],
      "蛋糕 准备了生日蛋糕": [0, 0, 1],
    });
    const store = new MemoryVectorStore(join(await mkdtemp(join(tmpdir(), "vec-")), "v.json"));
    await store.set("a.md", "bge-m3", [0.9, 0.1, 0]);
    await store.set("b.md", "bge-m3", [0, 0, 1]);
    const relevance = await buildHybridRelevance("最近太累", entries, { embedder, vectorStore: store });
    expect(relevance).toBeDefined();
    expect(relevance!(entries[0])).toBeGreaterThan(relevance!(entries[1]));
  });

  it("embedder 抛错时返回 undefined（回退关键词）", async () => {
    const embedder: TextEmbedder = { model: "m", embed: vi.fn(async () => { throw new Error("down"); }) };
    const store = new MemoryVectorStore(join(await mkdtemp(join(tmpdir(), "vec-")), "v.json"));
    const relevance = await buildHybridRelevance("x", entries, { embedder, vectorStore: store });
    expect(relevance).toBeUndefined();
  });

  it("模型不匹配的旧向量按 0 分（仍可被 BM25 救回）", async () => {
    const embedder = fakeEmbedder({ "加班": [1, 0, 0] });
    const store = new MemoryVectorStore(join(await mkdtemp(join(tmpdir(), "vec-")), "v.json"));
    await store.set("a.md", "old-model", [1, 0, 0]); // 旧模型 → 向量分 0
    const relevance = await buildHybridRelevance("加班", entries, { embedder, vectorStore: store });
    // BM25 命中"加班" → a 仍 > b
    expect(relevance!(entries[0])).toBeGreaterThan(relevance!(entries[1]));
  });
});

describe("MemoryVectorIndexer", () => {
  const dirs: string[] = [];
  it("index 写入向量；backfill 只补缺的", async () => {
    const dir = await mkdtemp(join(tmpdir(), "vec-idx-"));
    dirs.push(dir);
    const store = new MemoryVectorStore(join(dir, "v.json"));
    const embedder = fakeEmbedder({ "标题 摘要": [1, 2], "T2 S2": [3, 4] });
    const indexer = new MemoryVectorIndexer(embedder, store);
    await indexer.index("p1", "标题 摘要");
    expect((await store.snapshot())("p1")?.vector).toEqual([1, 2]);

    await indexer.backfill([
      { relativePath: "p1", title: "标题", summary: "摘要" }, // 已有 → 跳过
      { relativePath: "p2", title: "T2", summary: "S2" }, // 缺 → 补
    ]);
    expect((await store.snapshot())("p2")?.vector).toEqual([3, 4]);
    await rm(dir, { recursive: true, force: true });
  });
});
