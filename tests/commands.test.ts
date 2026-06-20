import { describe, expect, it } from "vitest";
import { parseBridgeCommand, parseWorkspaceCommand } from "../src/utils/commands.js";

describe("Chinese bridge commands", () => {
  it("accepts Chinese commands as the primary aliases", () => {
    expect(parseBridgeCommand("/确认")).toBe("confirm");
    expect(parseBridgeCommand("/取消")).toBe("cancel");
    expect(parseBridgeCommand("/测试")).toBe("ping");
    expect(parseBridgeCommand("/帮助")).toBe("help");
    expect(parseBridgeCommand("/状态")).toBe("status");
    expect(parseBridgeCommand("/查询额度")).toBe("usage");
    expect(parseBridgeCommand("/额度")).toBe("usage");
  });

  it("keeps existing English commands compatible", () => {
    expect(parseBridgeCommand("/confirm")).toBe("confirm");
    expect(parseBridgeCommand("/cancel")).toBe("cancel");
    expect(parseBridgeCommand("/ping")).toBe("ping");
    expect(parseBridgeCommand("/help")).toBe("help");
    expect(parseBridgeCommand("/status")).toBe("status");
    expect(parseBridgeCommand("/usage")).toBe("usage");
  });
});

describe("conversation and persona commands", () => {
  it("parses window management commands and flexible numbering", () => {
    expect(parseWorkspaceCommand("/清空对话")).toEqual({ type: "clear-conversation" });
    expect(parseWorkspaceCommand("/新对话")).toEqual({ type: "new-conversation" });
    expect(parseWorkspaceCommand("/查看对话")).toEqual({ type: "list-conversations" });
    expect(parseWorkspaceCommand("/切换对话 01")).toEqual({ type: "select-conversation", index: 1 });
    expect(parseWorkspaceCommand("/切换对话+02")).toEqual({ type: "select-conversation", index: 2 });
    expect(parseWorkspaceCommand("/切换对话03")).toEqual({ type: "select-conversation", index: 3 });
  });

  it("parses persona list and switch commands", () => {
    expect(parseWorkspaceCommand("/查看当前人设")).toEqual({ type: "current-persona" });
    expect(parseWorkspaceCommand("/查看人设")).toEqual({ type: "list-personas" });
    expect(parseWorkspaceCommand("/查看人设列表")).toEqual({ type: "list-personas" });
    expect(parseWorkspaceCommand("/切换人设 01")).toEqual({ type: "select-persona", index: 1 });
    expect(parseWorkspaceCommand("/切换人设00")).toEqual({ type: "select-persona", index: 0 });
  });
});
