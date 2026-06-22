import { describe, it, expect } from "vitest";
import {
  buildMemoryAugmentedPrompt,
  fuzzyMemoryDate,
  isRelevantText,
  selectRelevantMemories,
} from "./memory-context.js";
import type { ApprovedMemoryEntry } from "./memory-repository.js";

function entry(over: Partial<ApprovedMemoryEntry> & { relativePath: string }): ApprovedMemoryEntry {
  return {
    title: over.title ?? "标题",
    category: over.category ?? "event",
    updatedAt: over.updatedAt ?? "2026-06-21",
    summary: over.summary ?? "摘要内容",
    relativePath: over.relativePath,
  };
}

const NOW = new Date("2026-06-21T04:00:00Z"); // 上海 2026-06-21 12:00

describe("selectRelevantMemories 衰减", () => {
  it("同相关度下，新记忆（updatedAt 更近）优先于老记忆", () => {
    const fresh = entry({
      relativePath: "approved/projects/fresh.memory.md",
      category: "project",
      summary: "项目 部署",
      updatedAt: "2026-06-21",
    });
    const stale = entry({
      relativePath: "approved/projects/stale.memory.md",
      category: "project",
      summary: "项目 部署",
      updatedAt: "2026-02-21", // 约 120 天前
    });
    const selected = selectRelevantMemories("部署 项目", [fresh, stale], { maxEntries: 1, now: NOW });
    expect(selected[0].relativePath).toBe(fresh.relativePath);
  });

  it("提鲜（lastReferencedAt）能让老记忆反超新记忆", () => {
    const fresh = entry({
      relativePath: "approved/projects/fresh.memory.md",
      category: "project",
      summary: "项目 部署",
      updatedAt: "2026-06-21",
    });
    const stale = entry({
      relativePath: "approved/projects/stale.memory.md",
      category: "project",
      summary: "项目 部署",
      updatedAt: "2026-02-21",
    });
    const selected = selectRelevantMemories("部署 项目", [fresh, stale], {
      maxEntries: 1,
      now: NOW,
      // stale 最近被提鲜过 → 反超 fresh
      decay: (id) => (id === stale.relativePath ? { lastReferencedAt: "2026-06-21T00:00:00Z", referenceCount: 3 } : undefined),
    });
    expect(selected[0].relativePath).toBe(stale.relativePath);
  });

  it("preference/rule 恒选、不衰减", () => {
    const pref = entry({
      relativePath: "approved/preferences/p.memory.md",
      category: "preference",
      summary: "回复尽量简洁",
      updatedAt: "2024-01-01",
    });
    const selected = selectRelevantMemories("今天天气", [pref], { now: NOW });
    expect(selected.map((m) => m.relativePath)).toContain(pref.relativePath);
  });

  it("提鲜（referenceCount）能把老记忆拉回选用", () => {
    const a = entry({ relativePath: "approved/events/a.memory.md", category: "event", summary: "活动 安排", updatedAt: "2026-04-01" });
    const b = entry({ relativePath: "approved/events/b.memory.md", category: "event", summary: "活动 安排", updatedAt: "2026-04-01" });
    const query = "活动 安排";
    const decay = (id: string) =>
      id === b.relativePath ? { lastReferencedAt: "2026-06-20T00:00:00Z", referenceCount: 5 } : undefined;
    const selected = selectRelevantMemories(query, [a, b], { maxEntries: 1, now: NOW, decay });
    expect(selected[0].relativePath).toBe(b.relativePath);
  });
});

describe("buildMemoryAugmentedPrompt 永久记忆段", () => {
  it("有永久记忆时输出 <permanent_memory> 块", () => {
    const prompt = buildMemoryAugmentedPrompt("做个任务", [], "我是张三，偏好简洁");
    expect(prompt).toContain("<permanent_memory>");
    expect(prompt).toContain("我是张三，偏好简洁");
    expect(prompt).toContain("做个任务");
  });
  it("永久与确认记忆都为空时原样返回 userPrompt", () => {
    expect(buildMemoryAugmentedPrompt("只有任务", [])).toBe("只有任务");
  });
});

describe("selectRelevantMemories relevance 覆盖（向量混合分）", () => {
  const a = entry({ relativePath: "a.md", category: "event", summary: "加班到凌晨", updatedAt: "2026-06-21" });
  const b = entry({ relativePath: "b.md", category: "event", summary: "生日蛋糕", updatedAt: "2026-06-21" });

  it("用外部 relevance 排序，token 不重叠也能命中", () => {
    const relevance = (e: ApprovedMemoryEntry) => (e.relativePath === "a.md" ? 0.8 : 0.1);
    const selected = selectRelevantMemories("最近太累", [a, b], {
      now: NOW,
      relevance,
      relevanceThreshold: 0.3,
      maxEntries: 1,
    });
    expect(selected[0].relativePath).toBe("a.md");
  });

  it("relevanceThreshold 过滤掉未达阈值的", () => {
    const relevance = (e: ApprovedMemoryEntry) => (e.relativePath === "a.md" ? 0.8 : 0.1);
    const selected = selectRelevantMemories("最近太累", [a, b], {
      now: NOW,
      relevance,
      relevanceThreshold: 0.3,
    });
    expect(selected.map((m) => m.relativePath)).toEqual(["a.md"]); // b 0.1 < 0.3 被过滤
  });
});

describe("fuzzyMemoryDate", () => {
  it.each([
    ["2026-06-21", "2026-06-21"],
    ["2026-06-18", "2026-06-18"],
    ["2026-06-10", "上周"],
    ["2026-05-05", "5月上旬"],
    ["2026-05-15", "5月中旬"],
    ["2026-05-25", "5月下旬"],
  ])("%s -> %s", (input, expected) => {
    expect(fuzzyMemoryDate(input, NOW)).toBe(expected);
  });
});

describe("isRelevantText", () => {
  it("有中文 token 重叠为真", () => {
    expect(isRelevantText("帮我部署项目", "用户的项目部署在云端")).toBe(true);
  });
  it("无重叠为假", () => {
    expect(isRelevantText("今天吃什么", "项目部署流程")).toBe(false);
  });
  it("空文本为假", () => {
    expect(isRelevantText("任意", "   ")).toBe(false);
  });
});
