import type { TextEmbedder } from "./embedding-client.js";
import { cosine } from "./memory-retrieval.js";

/** 情绪锚点：label 用于匹配/展示，text 拼几个近义词增强 embedding 信号。 */
export const EMOTION_ANCHORS: ReadonlyArray<{ label: string; text: string }> = [
  { label: "高兴", text: "开心 高兴 快乐 愉悦" },
  { label: "难过", text: "难过 悲伤 伤心 低落" },
  { label: "心疼", text: "心疼 怜惜 不忍 疼惜" },
  { label: "委屈", text: "委屈 难受 不被理解 受了气" },
  { label: "生气", text: "生气 愤怒 恼火 不爽" },
  { label: "害怕", text: "害怕 不安 担心 紧张" },
  { label: "温柔", text: "温柔 体贴 柔软 包容" },
  { label: "思念", text: "想念 思念 牵挂 惦记" },
  { label: "孤独", text: "孤独 寂寞 一个人 没人陪" },
  { label: "撒娇", text: "撒娇 黏人 求关注 闹脾气" },
  { label: "害羞", text: "害羞 羞涩 脸红 不好意思" },
  { label: "吃醋", text: "吃醋 嫉妒 醋意 不开心别人" },
  { label: "感动", text: "感动 触动 暖心 鼻子一酸" },
  { label: "失落", text: "失落 落空 提不起劲 没意思" },
  { label: "兴奋", text: "兴奋 激动 期待 跃跃欲试" },
  { label: "疲惫", text: "疲惫 很累 撑不住 精疲力尽" },
  { label: "甜蜜", text: "甜蜜 幸福 黏糊 心里美" },
  { label: "愧疚", text: "愧疚 自责 对不起 内疚" },
  { label: "平静", text: "平静 淡然 安心 踏实" },
  { label: "烦躁", text: "烦躁 不耐烦 心烦 没耐心" },
];

export interface EmotionPrimerOptions {
  threshold?: number;
  boost?: number;
}

/**
 * 情绪启动器：用同一套免费 embedding 给"当前对话/记忆"贴情绪标签，
 * 情绪匹配的记忆在检索时加权浮上来。启动时把锚点 embed 一次缓存（RAM）。
 */
export class EmotionPrimer {
  private anchors: ReadonlyArray<{ label: string; vector: number[] }> = [];
  private readonly threshold: number;
  private readonly boost: number;

  constructor(
    private readonly embedder: TextEmbedder,
    options: EmotionPrimerOptions = {},
  ) {
    this.threshold = options.threshold ?? 0.45;
    this.boost = options.boost ?? 1.3;
  }

  /** 启动调用一次：embed 所有锚点。失败则保持空（emotionsOf 返回空、boostFor 返回 1）。 */
  async init(): Promise<void> {
    const vectors = await this.embedder.embed(EMOTION_ANCHORS.map((a) => a.text));
    this.anchors = EMOTION_ANCHORS.map((anchor, index) => ({
      label: anchor.label,
      vector: vectors[index] ?? [],
    })).filter((a) => a.vector.length > 0);
  }

  /** 一段向量命中的情绪标签（多标签）。 */
  emotionsOf(vector: ReadonlyArray<number> | undefined): string[] {
    if (!vector || vector.length === 0) return [];
    return this.anchors
      .filter((anchor) => cosine(vector, anchor.vector) >= this.threshold)
      .map((anchor) => anchor.label);
  }

  /** 记忆情绪与当前心情有交集 → 加权；否则 1。 */
  boostFor(memVector: ReadonlyArray<number> | undefined, mood: ReadonlySet<string> | undefined): number {
    if (!mood || mood.size === 0) return 1;
    const emotions = this.emotionsOf(memVector);
    return emotions.some((label) => mood.has(label)) ? this.boost : 1;
  }
}
