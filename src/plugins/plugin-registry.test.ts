import { describe, it, expect, vi } from "vitest";
import { PluginRegistry } from "./plugin-registry.js";
import type { PluginRegistryOptions, PluginStateStore } from "./plugin-registry.js";
import type { BridgePlugin, PluginIncomingMessage } from "./plugin-types.js";

function makeStore(states: Record<string, boolean> = {}): PluginStateStore {
  return {
    pluginStates: vi.fn(async () => states),
    updatePluginState: vi.fn(async () => {}),
  };
}

function makeLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    trace: vi.fn(),
  } as unknown as PluginRegistryOptions["logger"];
}

function makeOptions(overrides: Partial<PluginRegistryOptions> = {}): PluginRegistryOptions {
  return {
    logger: makeLogger(),
    store: makeStore(),
    sendReply: vi.fn(async () => {}),
    ...overrides,
  };
}

function makeMessage(userId = 123, text = "hello"): PluginIncomingMessage {
  return { userId, text, event: { user_id: userId } as never };
}

describe("PluginRegistry", () => {
  it("register 重复 id 抛错", () => {
    const registry = new PluginRegistry(makeOptions());
    registry.register({ id: "a", name: "A", version: "1.0.0" });
    expect(() => registry.register({ id: "a", name: "A2", version: "1.0.0" })).toThrow(/Duplicate/);
  });

  describe("initialize", () => {
    it("持久化状态优先于 defaultEnabled，并对已启用插件调 setup", async () => {
      const setupOn = vi.fn();
      const setupOff = vi.fn();
      // persisted: on=true 覆盖 defaultEnabled:false；off 无持久化用 defaultEnabled:false
      const store = makeStore({ on: true });
      const registry = new PluginRegistry(makeOptions({ store }));
      registry.register({ id: "on", name: "On", version: "1.0.0", defaultEnabled: false, setup: setupOn });
      registry.register({ id: "off", name: "Off", version: "1.0.0", defaultEnabled: false, setup: setupOff });
      await registry.initialize();
      expect(setupOn).toHaveBeenCalledTimes(1);
      expect(setupOff).not.toHaveBeenCalled();
      expect(registry.list()).toEqual([
        { id: "on", name: "On", version: "1.0.0", description: "", enabled: true },
        { id: "off", name: "Off", version: "1.0.0", description: "", enabled: false },
      ]);
    });

    it("无持久化时回落到 defaultEnabled:true", async () => {
      const setup = vi.fn();
      const registry = new PluginRegistry(makeOptions());
      registry.register({ id: "x", name: "X", version: "1.0.0", defaultEnabled: true, setup });
      await registry.initialize();
      expect(setup).toHaveBeenCalledTimes(1);
      expect(registry.list()[0].enabled).toBe(true);
    });
  });

  describe("dispatch", () => {
    it("按注册顺序，第一个 handled:true 中止且后续不被调用", async () => {
      const first = vi.fn(async () => ({ handled: true }));
      const second = vi.fn(async () => ({ handled: true }));
      const registry = new PluginRegistry(makeOptions({ store: makeStore({ a: true, b: true }) }));
      registry.register({ id: "a", name: "A", version: "1.0.0", handleMessage: first });
      registry.register({ id: "b", name: "B", version: "1.0.0", handleMessage: second });
      await registry.initialize();
      const handled = await registry.dispatch(makeMessage());
      expect(handled).toBe(true);
      expect(first).toHaveBeenCalledTimes(1);
      expect(second).not.toHaveBeenCalled();
    });

    it("全部放行返回 false", async () => {
      const registry = new PluginRegistry(makeOptions({ store: makeStore({ a: true }) }));
      registry.register({
        id: "a",
        name: "A",
        version: "1.0.0",
        handleMessage: vi.fn(async () => ({ handled: false })),
      });
      await registry.initialize();
      expect(await registry.dispatch(makeMessage())).toBe(false);
    });

    it("禁用插件被跳过", async () => {
      const handle = vi.fn(async () => ({ handled: true }));
      const registry = new PluginRegistry(makeOptions({ store: makeStore({ a: false }) }));
      registry.register({ id: "a", name: "A", version: "1.0.0", handleMessage: handle });
      await registry.initialize();
      expect(await registry.dispatch(makeMessage())).toBe(false);
      expect(handle).not.toHaveBeenCalled();
    });

    it("某插件抛错被吞掉并继续后续", async () => {
      const throwing = vi.fn(async () => {
        throw new Error("boom");
      });
      const next = vi.fn(async () => ({ handled: true }));
      const options = makeOptions({ store: makeStore({ a: true, b: true }) });
      const registry = new PluginRegistry(options);
      registry.register({ id: "a", name: "A", version: "1.0.0", handleMessage: throwing });
      registry.register({ id: "b", name: "B", version: "1.0.0", handleMessage: next });
      await registry.initialize();
      expect(await registry.dispatch(makeMessage())).toBe(true);
      expect(next).toHaveBeenCalledTimes(1);
      expect(options.logger.error).toHaveBeenCalled();
    });

    it("reply 透传到 sendReply(userId, text)", async () => {
      const options = makeOptions({ store: makeStore({ a: true }) });
      const registry = new PluginRegistry(options);
      registry.register({
        id: "a",
        name: "A",
        version: "1.0.0",
        handleMessage: async (_message, context) => {
          await context.reply("回声");
          return { handled: true };
        },
      });
      await registry.initialize();
      await registry.dispatch(makeMessage(999, "/echo"));
      expect(options.sendReply).toHaveBeenCalledWith(999, "回声");
    });
  });

  describe("setEnabled", () => {
    it("启用：持久化并调 setup", async () => {
      const setup = vi.fn();
      const options = makeOptions();
      const registry = new PluginRegistry(options);
      registry.register({ id: "a", name: "A", version: "1.0.0", defaultEnabled: false, setup });
      await registry.initialize();
      await registry.setEnabled("a", true);
      expect(options.store.updatePluginState).toHaveBeenCalledWith("a", true);
      expect(setup).toHaveBeenCalledTimes(1);
      expect(registry.list()[0].enabled).toBe(true);
    });

    it("禁用：持久化并调 teardown", async () => {
      const teardown = vi.fn();
      const options = makeOptions({ store: makeStore({ a: true }) });
      const registry = new PluginRegistry(options);
      registry.register({ id: "a", name: "A", version: "1.0.0", teardown });
      await registry.initialize();
      await registry.setEnabled("a", false);
      expect(options.store.updatePluginState).toHaveBeenCalledWith("a", false);
      expect(teardown).toHaveBeenCalledTimes(1);
      expect(registry.list()[0].enabled).toBe(false);
    });

    it("未知 id 抛错", async () => {
      const registry = new PluginRegistry(makeOptions());
      await expect(registry.setEnabled("missing", true)).rejects.toThrow(/Unknown/);
    });
  });

  describe("生命周期边界", () => {
    it("setup 抛错时插件被标记为禁用", async () => {
      const options = makeOptions({ store: makeStore({ a: true }) });
      const registry = new PluginRegistry(options);
      registry.register({
        id: "a",
        name: "A",
        version: "1.0.0",
        setup: vi.fn(async () => {
          throw new Error("setup failed");
        }),
      });
      await registry.initialize();
      expect(registry.list()[0].enabled).toBe(false);
      expect(options.logger.error).toHaveBeenCalled();
    });

    it("shutdown 对已启动插件调 teardown", async () => {
      const teardownA = vi.fn();
      const teardownB = vi.fn();
      const registry = new PluginRegistry(makeOptions({ store: makeStore({ a: true, b: false }) }));
      registry.register({ id: "a", name: "A", version: "1.0.0", teardown: teardownA });
      registry.register({ id: "b", name: "B", version: "1.0.0", teardown: teardownB });
      await registry.initialize();
      await registry.shutdown();
      expect(teardownA).toHaveBeenCalledTimes(1);
      expect(teardownB).not.toHaveBeenCalled(); // 未启动
    });
  });
});

// 类型烟雾测试：确保 BridgePlugin 形状可被直接赋值
const _typeCheck: BridgePlugin = { id: "t", name: "T", version: "1.0.0" };
void _typeCheck;
