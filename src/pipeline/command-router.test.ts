import { describe, it, expect } from "vitest";
import { CommandRouter } from "./command-router.js";

const router = new CommandRouter();

describe("CommandRouter.classify", () => {
  describe("桥接指令（非取消）→ isImmediate:true, skipFlush:false", () => {
    it.each([
      "/ping",
      "/测试",
      "/连通测试",
      "/帮助",
      "/help",
      "/状态",
      "/status",
      "/查询额度",
      "/额度",
      "/usage",
      "/确认",
      "/confirm",
    ])("%s", (text) => {
      expect(router.classify(text)).toEqual({ isImmediate: true, skipFlush: false });
    });
  });

  describe("取消指令 → isImmediate:true, skipFlush:true", () => {
    it.each(["/取消", "/cancel"])("%s", (text) => {
      expect(router.classify(text)).toEqual({ isImmediate: true, skipFlush: true });
    });
  });

  describe("工作区指令 → isImmediate:true, skipFlush:false", () => {
    it.each([
      "/清空对话",
      "/新对话",
      "/查看对话",
      "/查看当前人设",
      "/查看人设",
      "/查看人设列表",
      "/切换对话1",
      "/切换人设2",
    ])("%s", (text) => {
      expect(router.classify(text)).toEqual({ isImmediate: true, skipFlush: false });
    });
  });

  describe("记忆指令 → isImmediate:true, skipFlush:false", () => {
    it.each([
      "/记住 偏好：简洁",
      "/记住",
      "/遗忘 1",
      "/遗忘",
      "/确认记忆",
      "/取消记忆",
      "/记忆列表",
      "/同步记忆",
      "/确认遗忘",
    ])("%s", (text) => {
      expect(router.classify(text)).toEqual({ isImmediate: true, skipFlush: false });
    });
  });

  describe("非指令消息 → isImmediate:false, skipFlush:false", () => {
    it.each([
      "你好",
      "普通文本",
      "",
      "   ",
      "/未知命令",
      "/unknown",
      "不是指令/只是文字",
    ])("%s", (text) => {
      expect(router.classify(text)).toEqual({ isImmediate: false, skipFlush: false });
    });
  });

  describe("首尾空白处理", () => {
    it("  /ping   → 识别为立即指令", () => {
      expect(router.classify("  /ping  ")).toEqual({ isImmediate: true, skipFlush: false });
    });

    it("  /取消   → skipFlush:true", () => {
      expect(router.classify("  /取消  ")).toEqual({ isImmediate: true, skipFlush: true });
    });

    it("  普通文本  → 非指令", () => {
      expect(router.classify("  普通文本  ")).toEqual({ isImmediate: false, skipFlush: false });
    });
  });
});
