/** 人设的"回忆风格"——不同性格的角色，扩散偏好与反刍倾向不同。 */
export type RecallStyle = "emotional" | "narrative" | "analytical" | "balanced";

export interface RecallStyleProfile {
  /** 扩散激活三种关联边的权重：语义 / 情绪 / 时间。 */
  weights: { semantic: number; emotion: number; time: number };
  /** 反刍倾向倍率（× 全局 MEMORY_RUMINATION_RATE）。 */
  ruminationMult: number;
}

export const RECALL_STYLES: Record<RecallStyle, RecallStyleProfile> = {
  // 情感型：先想到感觉，顺情绪扩散；爱翻旧账。
  emotional: { weights: { semantic: 0.6, emotion: 1.0, time: 0.4 }, ruminationMult: 1.5 },
  // 叙事型：顺时间线展开。
  narrative: { weights: { semantic: 0.8, emotion: 0.5, time: 1.0 }, ruminationMult: 1.0 },
  // 分析型：顺逻辑/语义（"因果"的近似），少胡思乱想。
  analytical: { weights: { semantic: 1.0, emotion: 0.3, time: 0.6 }, ruminationMult: 0.5 },
  // 均衡（默认）。
  balanced: { weights: { semantic: 0.7, emotion: 0.7, time: 0.5 }, ruminationMult: 1.0 },
};

export const RECALL_STYLE_LABELS: Record<RecallStyle, string> = {
  emotional: "情感型",
  narrative: "叙事型",
  analytical: "分析型",
  balanced: "均衡",
};

export function isRecallStyle(value: unknown): value is RecallStyle {
  return value === "emotional" || value === "narrative" || value === "analytical" || value === "balanced";
}

/** 取风格档案；缺/非法 → 均衡。 */
export function recallStyleProfile(style: string | null | undefined): RecallStyleProfile {
  return RECALL_STYLES[isRecallStyle(style) ? style : "balanced"];
}
