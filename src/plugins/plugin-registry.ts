import type { Logger } from "pino";
import type {
  BridgePlugin,
  PluginIncomingMessage,
  PluginInfo,
  PluginReplyContext,
} from "./plugin-types.js";

/** 持久化启用状态的最小接口；由 BridgeWorkspaceStore 实现。 */
export interface PluginStateStore {
  pluginStates(): Promise<Record<string, boolean>>;
  updatePluginState(id: string, enabled: boolean): Promise<void>;
}

export interface PluginRegistryOptions {
  logger: Logger;
  store: PluginStateStore;
  sendReply: (userId: number, text: string) => Promise<void>;
}

export class PluginRegistry {
  private readonly plugins: BridgePlugin[] = [];
  private readonly enabled = new Map<string, boolean>();
  private readonly started = new Set<string>();

  constructor(private readonly options: PluginRegistryOptions) {}

  register(plugin: BridgePlugin): void {
    if (this.plugins.some((p) => p.id === plugin.id)) {
      throw new Error(`Duplicate plugin id: ${plugin.id}`);
    }
    this.plugins.push(plugin);
  }

  /** 读持久化启用态，对已启用插件调 setup。index.ts 在注册完所有插件后调用一次。 */
  async initialize(): Promise<void> {
    const states = await this.options.store.pluginStates();
    for (const plugin of this.plugins) {
      const isEnabled = states[plugin.id] ?? plugin.defaultEnabled ?? false;
      this.enabled.set(plugin.id, isEnabled);
      if (isEnabled) await this.start(plugin);
    }
  }

  list(): PluginInfo[] {
    return this.plugins.map((p) => ({
      id: p.id,
      name: p.name,
      version: p.version,
      description: p.description ?? "",
      enabled: this.enabled.get(p.id) ?? false,
    }));
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const plugin = this.plugins.find((p) => p.id === id);
    if (!plugin) throw new Error(`Unknown plugin id: ${id}`);
    this.enabled.set(id, enabled);
    await this.options.store.updatePluginState(id, enabled);
    if (enabled) await this.start(plugin);
    else await this.stop(plugin);
  }

  /** 按注册顺序分发；第一个返回 handled:true 的插件消费并返回 true。 */
  async dispatch(message: PluginIncomingMessage): Promise<boolean> {
    for (const plugin of this.plugins) {
      if (!this.enabled.get(plugin.id) || !plugin.handleMessage) continue;
      const context: PluginReplyContext = {
        logger: this.options.logger,
        reply: (text) => this.options.sendReply(message.userId, text),
      };
      try {
        const result = await plugin.handleMessage(message, context);
        if (result && result.handled) return true;
      } catch (error) {
        this.options.logger.error(
          { plugin: plugin.id, errorType: error instanceof Error ? error.name : "unknown" },
          "Plugin handleMessage threw; continuing",
        );
      }
    }
    return false;
  }

  async shutdown(): Promise<void> {
    for (const plugin of this.plugins) {
      if (this.started.has(plugin.id)) await this.stop(plugin);
    }
  }

  private async start(plugin: BridgePlugin): Promise<void> {
    if (this.started.has(plugin.id)) return;
    try {
      await plugin.setup?.({ logger: this.options.logger });
      this.started.add(plugin.id);
    } catch (error) {
      this.options.logger.error(
        { plugin: plugin.id, errorType: error instanceof Error ? error.name : "unknown" },
        "Plugin setup failed; left disabled",
      );
      this.enabled.set(plugin.id, false);
    }
  }

  private async stop(plugin: BridgePlugin): Promise<void> {
    if (!this.started.has(plugin.id)) return;
    try {
      await plugin.teardown?.();
    } catch (error) {
      this.options.logger.error(
        { plugin: plugin.id, errorType: error instanceof Error ? error.name : "unknown" },
        "Plugin teardown threw",
      );
    } finally {
      this.started.delete(plugin.id);
    }
  }
}
