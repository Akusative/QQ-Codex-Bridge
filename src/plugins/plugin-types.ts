import type { Logger } from "pino";
import type { OneBotPrivateMessageEvent } from "../onebot/types.js";

/** 传给插件的入站消息。 */
export interface PluginIncomingMessage {
  userId: number;
  text: string;
  event: OneBotPrivateMessageEvent;
}

/** 插件回复用的上下文：reply() 已绑定到当前用户，内部走分段发送。 */
export interface PluginReplyContext {
  logger: Logger;
  reply(text: string): Promise<void>;
}

/** setup() 的上下文。后续若需要更多依赖，从这里扩展。 */
export interface PluginSetupContext {
  logger: Logger;
}

/** handleMessage 的返回：handled=true 表示消费并中止后续处理。 */
export type PluginHandleResult = { handled: boolean } | void;

/**
 * 统一插件接口。所有 hook 均为可选。
 * 未来扩展点（本步未接入，按需新增可选方法）：
 *   - transformPrompt?(prompt, ctx): 在 agent.run 之前改写 prompt
 *   - transformReply?(reply, ctx): 在发送回复之前改写文本
 */
export interface BridgePlugin {
  readonly id: string;          // 稳定唯一 id，如 "example-echo"
  readonly name: string;        // 显示名
  readonly version: string;     // 语义化版本
  readonly description?: string;
  readonly defaultEnabled?: boolean; // 未持久化时的默认启用态，缺省 false
  setup?(context: PluginSetupContext): void | Promise<void>;
  teardown?(): void | Promise<void>;
  handleMessage?(
    message: PluginIncomingMessage,
    context: PluginReplyContext,
  ): PluginHandleResult | Promise<PluginHandleResult>;
}

/** 给 WebUI 的精简视图。 */
export interface PluginInfo {
  id: string;
  name: string;
  version: string;
  description: string;
  enabled: boolean;
}
