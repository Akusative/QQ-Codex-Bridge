import { describe, it, expect, vi } from "vitest";
import { bm25, buildHybridRelevance, cosine, MemoryVectorIndexer, spreadActivation } from "./memory-retrieval.js";
import { EMOTION_ANCHORS, EmotionPrimer } from "./memory-emotion.js";
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

  it("情绪启动：情绪匹配的记忆反超话题更相关的记忆", async () => {
    // 维度：[话题, 高兴, 难过]。query=加班但委屈(带难过情绪)。
    const embedder = fakeEmbedder({
      "加班但委屈": [1, 0, 0.8],
      [EMOTION_ANCHORS[0].text]: [0, 1, 0], // 高兴
      [EMOTION_ANCHORS[1].text]: [0, 0, 1], // 难过
    });
    const store = new MemoryVectorStore(join(await mkdtemp(join(tmpdir(), "vec-")), "v.json"));
    await store.set("a.md", "bge-m3", [1, 0, 0]); // 纯话题相关、无情绪
    await store.set("b.md", "bge-m3", [0, 0, 1]); // 话题略弱、但情绪=难过 与当前心情匹配
    const items = [entry("a.md", "加班", "加班的事"), entry("b.md", "难过", "那次很难过")];

    const noPrimer = await buildHybridRelevance("加班但委屈", items, { embedder, vectorStore: store, vectorWeight: 1 });
    expect(noPrimer!(items[0])).toBeGreaterThan(noPrimer!(items[1])); // 无情绪：a 赢

    const primer = new EmotionPrimer(embedder, { threshold: 0.45, boost: 1.3 });
    await primer.init();
    const withPrimer = await buildHybridRelevance("加班但委屈", items, { embedder, vectorStore: store, vectorWeight: 1, primer });
    expect(withPrimer!(items[1])).toBeGreaterThan(withPrimer!(items[0])); // 情绪启动：b 反超
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

describe("spreadActivation", () => {
  const entries = [
    entry("seed.md", "种子", "加班找领导谈"),
    entry("near.md", "语义近", "x"),
    entry("far.md", "无关", "y"),
    entry("emo.md", "情绪关联", "z"),
  ];
  const vecs: Record<string, number[]> = {
    "seed.md": [1, 0, 0],
    "near.md": [0.95, 0.31, 0], // 与种子 cosine≈0.95
    "far.md": [0, 1, 0], // 与种子正交、无情绪交集
    "emo.md": [0, 1, 0], // 向量远，但与种子共享"难过"
  };
  const base: Record<string, number> = { "seed.md": 1, "near.md": 0.1, "far.md": 0.05, "emo.md": 0.05 };
  const emotions: Record<string, string[]> = { "seed.md": ["难过"], "emo.md": ["难过"], "near.md": [], "far.md": [] };
  const vectorOf = (p: string) => vecs[p];
  const baseScores = (p: string) => base[p] ?? 0;
  const emotionsOf = (p: string) => emotions[p] ?? [];

  it("语义近 / 情绪同的被激活，无关的不变，种子保留自身分", () => {
    const out = spreadActivation(entries, baseScores, vectorOf, emotionsOf, { decay: 0.5, threshold: 0.6, maxSeeds: 1 });
    expect(out.get("seed.md")).toBe(1);
    expect(out.get("near.md")).toBeGreaterThan(0.1); // 语义边
    expect(out.get("emo.md")).toBeGreaterThan(0.05); // 情绪边
    expect(out.get("far.md")).toBe(0.05); // 无关
  });

  it("decay=0 不扩散", () => {
    const out = spreadActivation(entries, baseScores, vectorOf, emotionsOf, { decay: 0, threshold: 0.6 });
    expect(out.get("near.md")).toBe(0.1);
    expect(out.get("emo.md")).toBe(0.05);
  });

  it("无 emotionsOf 时只走语义边（情绪关联的不被牵）", () => {
    const out = spreadActivation(entries, baseScores, vectorOf, undefined, { decay: 0.5, threshold: 0.6, maxSeeds: 1 });
    expect(out.get("near.md")).toBeGreaterThan(0.1);
    expect(out.get("emo.md")).toBe(0.05);
  });
});

describe("buildHybridRelevance 扩散激活", () => {
  it("与种子关联但话题搜不到的记忆，开扩散后 relevance 被牵高", async () => {
    const embedder = fakeEmbedder({ "加班": [1, 0, 0], [EMOTION_ANCHORS[1].text]: [0, 0, 1] });
    const store = new MemoryVectorStore(join(await mkdtemp(join(tmpdir(), "vec-")), "v.json"));
    await store.set("seed.md", "bge-m3", [1, 0, 1]); // 话题命中 + 难过
    await store.set("emo.md", "bge-m3", [0, 0, 1]); // 纯难过，话题搜不到
    const items = [entry("seed.md", "加班", "加班找领导"), entry("emo.md", "哭", "靠着肩膀哭了")];
    const primer = new EmotionPrimer(embedder, { threshold: 0.45, boost: 1.3 });
    await primer.init();
    const opts = { embedder, vectorStore: store, vectorWeight: 1, primer };

    const noSpread = await buildHybridRelevance("加班", items, opts);
    const withSpread = await buildHybridRelevance("加班", items, { ...opts, spread: { decay: 0.5, threshold: 0.6 } });
    expect(withSpread!(items[1])).toBeGreaterThan(noSpread!(items[1]));
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
