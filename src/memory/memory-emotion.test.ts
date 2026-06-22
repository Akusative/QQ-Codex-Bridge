import { describe, it, expect } from "vitest";
import { EMOTION_ANCHORS, EmotionPrimer } from "./memory-emotion.js";
import type { TextEmbedder } from "./embedding-client.js";

/**
 * 假 embedder：给前两个锚点("高兴"、"难过")固定正交向量，其余锚点给零向量(永不匹配)。
 * 这样可确定性地测多标签/阈值/boost。
 */
function fakeEmbedder(): TextEmbedder {
  const map: Record<string, number[]> = {
    [EMOTION_ANCHORS[0].text]: [1, 0, 0], // 高兴
    [EMOTION_ANCHORS[1].text]: [0, 1, 0], // 难过
  };
  return {
    model: "fake",
    embed: async (texts) => texts.map((t) => map[t] ?? [0, 0, 0]),
  };
}

async function makePrimer(boost = 1.3, threshold = 0.45): Promise<EmotionPrimer> {
  const primer = new EmotionPrimer(fakeEmbedder(), { boost, threshold });
  await primer.init();
  return primer;
}

describe("EmotionPrimer", () => {
  it("emotionsOf：向量贴近某锚点 → 命中该情绪", async () => {
    const primer = await makePrimer();
    expect(primer.emotionsOf([1, 0, 0])).toContain("高兴");
    expect(primer.emotionsOf([0, 1, 0])).toContain("难过");
  });

  it("多标签：又像高兴又像难过都命中", async () => {
    const primer = await makePrimer(1.3, 0.4);
    const labels = primer.emotionsOf([1, 1, 0]); // 与高兴、难过 cosine 都 ≈0.707
    expect(labels).toEqual(expect.arrayContaining(["高兴", "难过"]));
  });

  it("无关向量 → 无标签", async () => {
    const primer = await makePrimer();
    expect(primer.emotionsOf([0, 0, 1])).toEqual([]);
    expect(primer.emotionsOf(undefined)).toEqual([]);
  });

  it("boostFor：记忆情绪与当前心情有交集 → 加权", async () => {
    const primer = await makePrimer(1.3);
    const mood = new Set(["高兴"]);
    expect(primer.boostFor([1, 0, 0], mood)).toBe(1.3); // 记忆=高兴，匹配
    expect(primer.boostFor([0, 1, 0], mood)).toBe(1); // 记忆=难过，不匹配
  });

  it("空心情 → 不加权", async () => {
    const primer = await makePrimer();
    expect(primer.boostFor([1, 0, 0], new Set())).toBe(1);
    expect(primer.boostFor([1, 0, 0], undefined)).toBe(1);
  });

  it("未 init → 安全空/1", () => {
    const primer = new EmotionPrimer(fakeEmbedder());
    expect(primer.emotionsOf([1, 0, 0])).toEqual([]);
    expect(primer.boostFor([1, 0, 0], new Set(["高兴"]))).toBe(1);
  });
});
