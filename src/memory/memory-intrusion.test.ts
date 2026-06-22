import { describe, it, expect } from "vitest";
import { maybeIntrude } from "./memory-intrusion.js";
import type { ApprovedMemoryEntry } from "./memory-repository.js";
import type { MemoryCategory } from "./memory-commands.js";

const NOW = new Date("2026-06-22T00:00:00Z");

function entry(relativePath: string, updatedAt: string, category: MemoryCategory = "event"): ApprovedMemoryEntry {
  return { relativePath, title: relativePath, category, updatedAt, summary: "摘要" };
}

/** 确定化 rng：按序返回。 */
function seqRng(values: number[]): () => number {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}

const old1 = entry("old1", "2026-05-01"); // 老
const old2 = entry("old2", "2026-05-01");
const newOne = entry("new", "2026-06-21"); // 太新（1天）
const pref = entry("pref", "2026-01-01", "preference");
const picked = entry("picked", "2026-05-01"); // 已被本轮选中

const candidates = [old1, old2, newOne, pref, picked];
const emotions: Record<string, string[]> = {
  old1: ["难过"], // 负面旧伤
  old2: ["高兴"], // 正面
  new: ["难过"],
  pref: [],
  picked: ["难过"],
};
const emotionsOf = (p: string) => emotions[p] ?? [];

describe("maybeIntrude", () => {
  it("rate=0 → 不反刍", () => {
    expect(maybeIntrude(candidates, [], { rate: 0, minAgeDays: 14, rng: seqRng([0]) })).toBeUndefined();
  });

  it("概率没命中 → 不反刍", () => {
    expect(maybeIntrude(candidates, [], { rate: 0.06, minAgeDays: 14, rng: seqRng([0.5]) })).toBeUndefined();
  });

  it("命中：从老+负面旧伤里翻涌，排除太新/preference/已选中", () => {
    const result = maybeIntrude(candidates, [picked], {
      rate: 1,
      minAgeDays: 14,
      emotionsOf,
      now: NOW,
      rng: seqRng([0, 0]), // 过门 + 抽第一条
    });
    expect(result?.relativePath).toBe("old1");
  });

  it("无负面但有情绪 → 退而取任意情绪", () => {
    const result = maybeIntrude([old2, newOne], [], {
      rate: 1,
      minAgeDays: 14,
      emotionsOf,
      now: NOW,
      rng: seqRng([0, 0]),
    });
    expect(result?.relativePath).toBe("old2");
  });

  it("加权：高 referenceCount 的旧伤更易被抽中", () => {
    const heavy = entry("heavy", "2026-05-01");
    const decay = (p: string) => (p === "heavy" ? { referenceCount: 9 } : { referenceCount: 0 });
    const result = maybeIntrude([old1, heavy], [], {
      rate: 1,
      minAgeDays: 14,
      decay,
      emotionsOf: (p) => (p === "old1" || p === "heavy" ? ["难过"] : []),
      now: NOW,
      rng: seqRng([0, 0.5]), // 过门 + 0.5×(1+10) 落在 heavy 区间
    });
    expect(result?.relativePath).toBe("heavy");
  });

  it("无 emotionsOf → 退化为老记忆池", () => {
    const result = maybeIntrude([old1, newOne], [], {
      rate: 1,
      minAgeDays: 14,
      now: NOW,
      rng: seqRng([0, 0]),
    });
    expect(result?.relativePath).toBe("old1");
  });

  it("池空（都太新）→ 不反刍", () => {
    expect(
      maybeIntrude([newOne], [], { rate: 1, minAgeDays: 14, now: NOW, rng: seqRng([0]) }),
    ).toBeUndefined();
  });
});
