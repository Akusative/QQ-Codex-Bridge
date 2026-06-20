import { describe, it, expect, vi } from "vitest";
import { exampleEchoPlugin } from "./example-echo-plugin.js";
import type { PluginIncomingMessage, PluginReplyContext } from "./plugin-types.js";

function makeMessage(text: string): PluginIncomingMessage {
  return { userId: 1, text, event: { user_id: 1 } as never };
}

function makeContext(): PluginReplyContext & { reply: ReturnType<typeof vi.fn> } {
  return {
    logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), trace: vi.fn() } as never,
    reply: vi.fn(async () => {}),
  };
}

describe("exampleEchoPlugin", () => {
  it("元数据：默认禁用", () => {
    expect(exampleEchoPlugin.id).toBe("example-echo");
    expect(exampleEchoPlugin.defaultEnabled).toBe(false);
  });

  it("/echo 你好 → 回显并 handled:true", async () => {
    const ctx = makeContext();
    const result = await exampleEchoPlugin.handleMessage!(makeMessage("/echo 你好"), ctx);
    expect(ctx.reply).toHaveBeenCalledWith("你好");
    expect(result).toEqual({ handled: true });
  });

  it("/echo（空）→ 回显兜底文案并 handled:true", async () => {
    const ctx = makeContext();
    const result = await exampleEchoPlugin.handleMessage!(makeMessage("/echo"), ctx);
    expect(ctx.reply).toHaveBeenCalledWith("（没有要回显的内容）");
    expect(result).toEqual({ handled: true });
  });

  it("首尾空白不影响识别", async () => {
    const ctx = makeContext();
    const result = await exampleEchoPlugin.handleMessage!(makeMessage("  /echo  内容  "), ctx);
    expect(ctx.reply).toHaveBeenCalledWith("内容");
    expect(result).toEqual({ handled: true });
  });

  it("非 /echo 文本 → handled:false 且不回复", async () => {
    const ctx = makeContext();
    const result = await exampleEchoPlugin.handleMessage!(makeMessage("/echoxyz"), ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });

  it("普通聊天 → handled:false", async () => {
    const ctx = makeContext();
    const result = await exampleEchoPlugin.handleMessage!(makeMessage("今天天气不错"), ctx);
    expect(ctx.reply).not.toHaveBeenCalled();
    expect(result).toEqual({ handled: false });
  });
});
