import { describe, it, expect } from "vitest";
import { recallStyleProfile, isRecallStyle, RECALL_STYLES } from "./memory-recall-style.js";

describe("recallStyleProfile", () => {
  it("情感型情绪边权重最高、反刍倍率最高", () => {
    const p = recallStyleProfile("emotional");
    expect(p.weights.emotion).toBeGreaterThan(p.weights.semantic);
    expect(p.weights.emotion).toBeGreaterThan(p.weights.time);
    expect(p.ruminationMult).toBeGreaterThan(1);
  });

  it("叙事型时间边权重最高", () => {
    const p = recallStyleProfile("narrative");
    expect(p.weights.time).toBeGreaterThanOrEqual(p.weights.semantic);
    expect(p.weights.time).toBeGreaterThan(p.weights.emotion);
  });

  it("分析型语义边最高、反刍最少", () => {
    const p = recallStyleProfile("analytical");
    expect(p.weights.semantic).toBeGreaterThanOrEqual(p.weights.time);
    expect(p.weights.semantic).toBeGreaterThan(p.weights.emotion);
    expect(p.ruminationMult).toBeLessThan(1);
  });

  it("缺省/非法 → 均衡", () => {
    expect(recallStyleProfile(undefined)).toBe(RECALL_STYLES.balanced);
    expect(recallStyleProfile("nope")).toBe(RECALL_STYLES.balanced);
    expect(recallStyleProfile(null)).toBe(RECALL_STYLES.balanced);
  });

  it("isRecallStyle 守卫", () => {
    expect(isRecallStyle("emotional")).toBe(true);
    expect(isRecallStyle("x")).toBe(false);
    expect(isRecallStyle(undefined)).toBe(false);
  });
});
