import { describe, expect, it } from "vitest";
import {
  formatAgentFailure,
  formatBridgeStatus,
  formatCodexUsage,
  formatMemoryList,
  HELP_MESSAGE,
} from "../src/utils/user-messages.js";

describe("Chinese user-facing receipts", () => {
  it("translates common task failures without exposing raw diagnostics", () => {
    expect(formatAgentFailure("Task timed out")).toContain("任务超时");
    expect(formatAgentFailure("Codex exited with code 1")).toBe(
      "Codex 运行失败（退出码 1）。",
    );
    expect(formatAgentFailure("unexpected internal detail")).toBe(
      "任务执行失败，请稍后重试。",
    );
  });

  it("lists Chinese commands in help", () => {
    expect(HELP_MESSAGE).toContain("/帮助");
    expect(HELP_MESSAGE).toContain("/状态");
    expect(HELP_MESSAGE).toContain("/查询额度");
    expect(HELP_MESSAGE).toContain("/无记忆");
    expect(HELP_MESSAGE).toContain("/同步记忆");
    expect(HELP_MESSAGE).toContain("请勿发送密码");
  });

  it("formats Codex rate-limit usage with remaining percentages and reset time", () => {
    const message = formatCodexUsage({
      fetchedAt: Date.UTC(2026, 5, 20, 8, 0, 0),
      fiveHour: {
        usedPercent: 18,
        remainingPercent: 82,
        resetsAt: Date.UTC(2026, 5, 20, 10, 0, 0) / 1_000,
        windowDurationMins: 300,
      },
      weekly: {
        usedPercent: 41,
        remainingPercent: 59,
        resetsAt: Date.UTC(2026, 5, 23, 0, 0, 0) / 1_000,
        windowDurationMins: 10_080,
      },
    });
    expect(message).toContain("5 小时额度：剩余 82%（已用 18%）");
    expect(message).toContain("周额度：剩余 59%（已用 41%）");
    expect(message).toContain("数据来源：Codex 实时限额");
  });

  it("formats a secret-free status summary", () => {
    const message = formatBridgeStatus({
      napCatConnected: true,
      codexAvailable: true,
      agentMode: "codex",
      taskRunning: false,
      confirmationPending: false,
      memoryAvailable: true,
      memoryCount: 0,
      memoryPending: false,
      memoryRecallEnabled: true,
      workdirLabel: "workspace",
    });
    expect(message).toContain("NapCat：已连接");
    expect(message).toContain("当前任务：空闲");
    expect(message).toContain("工作区：workspace（受限）");
    expect(message).toContain("记忆库：可用（0 条）");
    expect(message).toContain("记忆调用：已启用");
  });

  it("uses a valid first-item example in the memory list hint", () => {
    const message = formatMemoryList([
      {
        relativePath: "approved/preferences/synthetic.memory.md",
        title: "简洁回复",
        category: "preference",
        updatedAt: "2026-06-19",
      },
    ]);
    expect(message).toContain("/遗忘 1");
    expect(message).not.toContain("/遗忘 2");
  });
});
