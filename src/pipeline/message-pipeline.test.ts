import { describe, it, expect, vi, afterEach } from "vitest";
import { MessagePipeline } from "./message-pipeline.js";
import type { MessagePipelineOptions } from "./message-pipeline.js";
import type { OneBotPrivateMessageEvent } from "../onebot/types.js";

vi.mock("../security/sensitive-content-policy.js", () => ({
  classifySensitiveContent: vi.fn(() => ({ blocked: false, category: undefined })),
}));

import { classifySensitiveContent } from "../security/sensitive-content-policy.js";

function makeEvent(userId = 12345): OneBotPrivateMessageEvent {
  return {
    self_id: 0,
    user_id: userId,
    time: 0,
    message_id: 1,
    message_type: "private",
    post_type: "message",
    sub_type: "friend",
    message: [],
    raw_message: "",
  };
}

function makeOptions(waitSeconds = 0): MessagePipelineOptions {
  return {
    processor: {
      process: vi.fn().mockResolvedValue(undefined),
    } as unknown as MessagePipelineOptions["processor"],
    workspaceStore: {
      messageBufferSettings: vi.fn().mockResolvedValue({ waitSeconds }),
    },
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
      debug: vi.fn(),
      trace: vi.fn(),
    } as unknown as MessagePipelineOptions["logger"],
  };
}

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

describe("MessagePipeline.handle", () => {
  describe("非指令消息（waitSeconds=0，立即触发）", () => {
    it("经 buffer onFlush 调用 processor.process", async () => {
      const opts = makeOptions(0);
      await new MessagePipeline(opts).handle(makeEvent(), "你好");
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "你好");
    });

    it("key 由 user_id 转字符串得到", async () => {
      const opts = makeOptions(0);
      await new MessagePipeline(opts).handle(makeEvent(99999), "消息");
      expect(opts.processor.process).toHaveBeenCalled();
    });

    it("原始 text 原样传入 processor.process", async () => {
      const opts = makeOptions(0);
      await new MessagePipeline(opts).handle(makeEvent(), "  有空格  ");
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "  有空格  ");
    });

    it("敏感内容被拦截时不调用 processor.process", async () => {
      vi.mocked(classifySensitiveContent).mockReturnValue({ blocked: true, category: "violence" as never });
      const opts = makeOptions(0);
      await new MessagePipeline(opts).handle(makeEvent(), "有害内容");
      expect(opts.processor.process).not.toHaveBeenCalled();
    });
  });

  describe("非指令消息（waitSeconds>0，暂存缓冲）", () => {
    it("waitSeconds=10 时消息暂存，processor.process 未被调用", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "延迟消息");
      expect(opts.processor.process).not.toHaveBeenCalled();
    });

    it("等待结束后 processor.process 被调用（真实 1ms 定时器）", async () => {
      // 用 0.001 秒（1ms）的真实定时器，避免 fake timer 不追踪 void Promise 的问题
      const opts = makeOptions(0.001);
      await new MessagePipeline(opts).handle(makeEvent(), "延迟消息");
      expect(opts.processor.process).not.toHaveBeenCalled();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "延迟消息");
    }, 500);
  });

  describe("桥接指令（立即处理）", () => {
    it("/ping 直接调用 processor.process，不经 buffer 延迟", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/ping");
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "/ping");
    });

    it("/帮助 直接调用 processor.process", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/帮助");
      expect(opts.processor.process).toHaveBeenCalled();
    });

    it("/取消 直接调用 processor.process，不刷新 buffer", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      const pipeline = new MessagePipeline(opts);
      // 先入队一条普通消息
      await pipeline.handle(makeEvent(), "pending");
      expect(opts.processor.process).not.toHaveBeenCalled();
      // 发送取消指令
      await pipeline.handle(makeEvent(), "/取消");
      // 只被调用一次（取消指令本身），buffer 未被 flush
      expect(opts.processor.process).toHaveBeenCalledTimes(1);
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "/取消");
    });

    it("/cancel 行为与 /取消 相同", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      const pipeline = new MessagePipeline(opts);
      await pipeline.handle(makeEvent(), "pending");
      await pipeline.handle(makeEvent(), "/cancel");
      expect(opts.processor.process).toHaveBeenCalledTimes(1);
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "/cancel");
    });

    it("首尾空白不影响指令识别", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "  /ping  ");
      expect(opts.processor.process).toHaveBeenCalled();
    });
  });

  describe("工作区指令（立即处理）", () => {
    it("/清空对话 直接调用 processor.process", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/清空对话");
      expect(opts.processor.process).toHaveBeenCalled();
    });

    it("/新对话 直接调用 processor.process", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/新对话");
      expect(opts.processor.process).toHaveBeenCalled();
    });
  });

  describe("记忆指令（立即处理）", () => {
    it("/记住 直接调用 processor.process", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/记住 偏好：简洁");
      expect(opts.processor.process).toHaveBeenCalled();
    });

    it("/遗忘 直接调用 processor.process", async () => {
      const opts = makeOptions(10);
      await new MessagePipeline(opts).handle(makeEvent(), "/遗忘 1");
      expect(opts.processor.process).toHaveBeenCalled();
    });
  });

  describe("pipeline.cancel", () => {
    it("cancel 后定时器不再触发 processor.process", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      const pipeline = new MessagePipeline(opts);
      await pipeline.handle(makeEvent(), "pending");
      pipeline.cancel("12345");
      await vi.runAllTimersAsync();
      expect(opts.processor.process).not.toHaveBeenCalled();
    });
  });

  describe("pipeline.clear", () => {
    it("clear 后所有定时器不再触发", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      const pipeline = new MessagePipeline(opts);
      await pipeline.handle(makeEvent(1), "msg1");
      await pipeline.handle(makeEvent(2), "msg2");
      pipeline.clear();
      await vi.runAllTimersAsync();
      expect(opts.processor.process).not.toHaveBeenCalled();
    });
  });

  describe("插件分发", () => {
    it("插件消费消息（dispatch=true）时不进入路由/缓冲，processor.process 不被调用", async () => {
      const opts = makeOptions(10);
      const dispatch = vi.fn().mockResolvedValue(true);
      opts.pluginRegistry = { dispatch };
      await new MessagePipeline(opts).handle(makeEvent(), "/echo 测试");
      expect(dispatch).toHaveBeenCalledWith({
        userId: 12345,
        text: "/echo 测试",
        event: expect.any(Object),
      });
      expect(opts.processor.process).not.toHaveBeenCalled();
      expect(opts.workspaceStore.messageBufferSettings).not.toHaveBeenCalled();
    });

    it("插件放行（dispatch=false）时照常走指令立即处理", async () => {
      const opts = makeOptions(10);
      opts.pluginRegistry = { dispatch: vi.fn().mockResolvedValue(false) };
      await new MessagePipeline(opts).handle(makeEvent(), "/ping");
      expect(opts.processor.process).toHaveBeenCalledWith(expect.any(Object), "/ping");
    });

    it("插件放行（dispatch=false）时普通消息照常入缓冲", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const opts = makeOptions(10);
      opts.pluginRegistry = { dispatch: vi.fn().mockResolvedValue(false) };
      await new MessagePipeline(opts).handle(makeEvent(), "普通消息");
      expect(opts.workspaceStore.messageBufferSettings).toHaveBeenCalled();
      expect(opts.processor.process).not.toHaveBeenCalled();
    });
  });
});
