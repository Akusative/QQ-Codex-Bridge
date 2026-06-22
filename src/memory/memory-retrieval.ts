import type { ApprovedMemoryEntry } from "./memory-repository.js";
import type { TextEmbedder } from "./embedding-client.js";
import type { MemoryVectorStore } from "./memory-vector-store.js";

export interface HybridRelevanceOptions {
  embedder: TextEmbedder;
  vectorStore: MemoryVectorStore;
  /** 向量占比，其余给 BM25。默认 0.85。 */
  vectorWeight?: number;
}

/**
 * 混合检索：85% 向量语义 + 15% BM25 关键词。
 * 返回一个 (entry)=>分数 的查询函数供 selectRelevantMemories 用作基础相关度。
 * 失败（无 embedder/硅基不可用）时返回 undefined，调用方回退到关键词检索。
 */
export async function buildHybridRelevance(
  query: string,
  entries: ReadonlyArray<ApprovedMemoryEntry>,
  options: HybridRelevanceOptions,
): Promise<((entry: ApprovedMemoryEntry) => number) | undefined> {
  if (entries.length === 0) return () => 0;
  const weight = clamp01(options.vectorWeight ?? 0.85);
  let queryVector: number[];
  try {
    [queryVector] = await options.embedder.embed([query]);
  } catch {
    return undefined; // 回退关键词
  }
  if (!queryVector) return undefined;

  const lookup = await options.vectorStore.snapshot();
  const model = options.embedder.model;

  const vectorScores = entries.map((entry) => {
    const record = lookup(entry.relativePath);
    if (!record || record.model !== model) return 0;
    return Math.max(0, cosine(queryVector, record.vector));
  });

  const bm25Scores = normalize(bm25(query, entries));

  const scores = new Map<string, number>();
  entries.forEach((entry, index) => {
    scores.set(entry.relativePath, weight * vectorScores[index] + (1 - weight) * bm25Scores[index]);
  });
  return (entry) => scores.get(entry.relativePath) ?? 0;
}

/** 记忆向量索引：入库即算、启动回填。失败容错（下次再补）。 */
export class MemoryVectorIndexer {
  constructor(
    private readonly embedder: TextEmbedder,
    private readonly store: MemoryVectorStore,
  ) {}

  async index(relativePath: string, text: string): Promise<void> {
    try {
      const [vector] = await this.embedder.embed([text]);
      if (vector) await this.store.set(relativePath, this.embedder.model, vector);
    } catch {
      /* 索引失败不影响主流程，下次回填补上 */
    }
  }

  /** 回填缺当前模型向量的记忆。 */
  async backfill(
    entries: ReadonlyArray<{ relativePath: string; title: string; summary: string }>,
  ): Promise<void> {
    const byPath = new Map(entries.map((e) => [e.relativePath, `${e.title} ${e.summary}`]));
    const missing = (await this.store.missing([...byPath.keys()], this.embedder.model)).filter(
      (path) => byPath.has(path),
    );
    if (missing.length === 0) return;
    try {
      const vectors = await this.embedder.embed(missing.map((path) => byPath.get(path) as string));
      await this.store.setMany(
        missing.map((path, index) => ({ id: path, model: this.embedder.model, vector: vectors[index] })),
      );
    } catch {
      /* 下次启动再补 */
    }
  }
}

export function cosine(a: ReadonlyArray<number>, b: ReadonlyArray<number>): number {
  if (a.length === 0 || a.length !== b.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 针对当前 entry 集即时算 BM25（IDF 取自这批记忆，几百条足够快）。 */
export function bm25(
  query: string,
  entries: ReadonlyArray<ApprovedMemoryEntry>,
  k1 = 1.5,
  b = 0.75,
): number[] {
  const docs = entries.map((entry) => tokens(`${entry.title} ${entry.summary}`));
  const queryTerms = new Set(tokens(query));
  const docCount = docs.length || 1;
  const avgLen = docs.reduce((sum, doc) => sum + doc.length, 0) / docCount || 1;

  const docFreq = new Map<string, number>();
  for (const term of queryTerms) {
    let n = 0;
    for (const doc of docs) if (doc.includes(term)) n += 1;
    docFreq.set(term, n);
  }

  return docs.map((doc) => {
    const length = doc.length || 1;
    let score = 0;
    for (const term of queryTerms) {
      const tf = doc.reduce((count, token) => (token === term ? count + 1 : count), 0);
      if (tf === 0) continue;
      const n = docFreq.get(term) ?? 0;
      const idf = Math.log(1 + (docCount - n + 0.5) / (n + 0.5));
      score += idf * ((tf * (k1 + 1)) / (tf + k1 * (1 - b + (b * length) / avgLen)));
    }
    return score;
  });
}

function normalize(scores: number[]): number[] {
  const max = scores.reduce((m, s) => Math.max(m, s), 0);
  if (max <= 0) return scores.map(() => 0);
  return scores.map((s) => s / max);
}

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

/** 与 memory-context 同口径的分词（返回数组以便算词频）。 */
function tokens(text: string): string[] {
  const normalized = text.toLowerCase();
  const result: string[] = [];
  for (const word of normalized.match(/[a-z0-9_-]{3,}/g) ?? []) result.push(word);
  for (const sequence of normalized.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    const maximum = Math.min(4, sequence.length);
    for (let size = 2; size <= maximum; size += 1) {
      for (let index = 0; index <= sequence.length - size; index += 1) {
        result.push(sequence.slice(index, index + size));
      }
    }
  }
  return result;
}
