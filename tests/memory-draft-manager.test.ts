import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryDraftManager } from "../src/memory/memory-draft-manager.js";

afterEach(() => vi.useRealTimers());

describe("MemoryDraftManager", () => {
  it("keeps a candidate only in memory until cleared", () => {
    const manager = new MemoryDraftManager();
    const candidate = {
      category: "preference" as const,
      title: "简洁回复",
      summary: "用户确认的长期偏好是：回复简洁。",
      forgetCondition: "用户提出修改时。",
    };
    manager.stageRemember(candidate);
    expect(manager.getRemember()).toEqual(candidate);
    expect(manager.getForget()).toBeUndefined();
    expect(manager.cancel()).toBe(true);
    expect(manager.hasPending()).toBe(false);
  });

  it("expires a pending operation", () => {
    vi.useFakeTimers();
    const manager = new MemoryDraftManager(1_000);
    manager.stageRemember({
      category: "rule",
      title: "测试规则",
      summary: "用户明确要求长期遵守：测试规则。",
      forgetCondition: "用户提出修改时。",
    });
    vi.advanceTimersByTime(1_001);
    expect(manager.hasPending()).toBe(false);
  });
});
