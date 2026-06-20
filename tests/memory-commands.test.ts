import { describe, expect, it } from "vitest";
import {
  buildMemoryCandidate,
  parseMemoryCommand,
  UnsafeMemoryContentError,
} from "../src/memory/memory-commands.js";

describe("memory commands", () => {
  it("parses the Chinese memory workflow", () => {
    expect(parseMemoryCommand("/记住 偏好：回复简洁")).toEqual({
      type: "remember",
      content: "偏好：回复简洁",
    });
    expect(parseMemoryCommand("/确认记忆")).toEqual({ type: "confirm-memory" });
    expect(parseMemoryCommand("/取消记忆")).toEqual({ type: "cancel-memory" });
    expect(parseMemoryCommand("/记忆列表")).toEqual({ type: "list-memory" });
    expect(parseMemoryCommand("/同步记忆")).toEqual({ type: "sync-memory" });
    expect(parseMemoryCommand("/遗忘 2")).toEqual({ type: "forget", index: 2 });
    expect(parseMemoryCommand("/确认遗忘")).toEqual({ type: "confirm-forget" });
  });

  it("builds a normalized preview and honors an explicit category", () => {
    const candidate = buildMemoryCandidate("偏好：回复尽量简洁");
    expect(candidate.category).toBe("preference");
    expect(candidate.title).toBe("回复尽量简洁");
    expect(candidate.summary).toBe("用户确认的长期偏好是：回复尽量简洁。");
  });

  it("blocks likely private identifiers before a draft is staged", () => {
    expect(() => buildMemoryCandidate("QQ号：12345678")).toThrow(
      UnsafeMemoryContentError,
    );
    expect(() => buildMemoryCandidate("项目编号 12345678")).toThrow(
      UnsafeMemoryContentError,
    );
    expect(() => buildMemoryCandidate("密码是 synthetic-secret-value")).toThrow(
      UnsafeMemoryContentError,
    );
  });
});
