import type { BridgePlugin } from "./plugin-types.js";

/**
 * 示例插件模板 —— 复制本文件改 id/name 即可开发新插件。
 * 行为：收到 "/echo <文本>" 时把 <文本> 原样回显，并消费该消息（不再进入 agent）。
 * 默认禁用（defaultEnabled: false），需在 WebUI「插件管理」里手动启用。
 */
export const exampleEchoPlugin: BridgePlugin = {
  id: "example-echo",
  name: "示例回声插件",
  version: "1.0.0",
  description: "演示插件接口：收到 /echo <文本> 时回显文本。默认关闭，可在 WebUI 启用。",
  defaultEnabled: false,

  async handleMessage(message, context) {
    const match = message.text.trim().match(/^\/echo(?:\s+([\s\S]*))?$/u);
    if (!match) return { handled: false };
    const echoed = match[1]?.trim() ?? "";
    await context.reply(echoed.length > 0 ? echoed : "（没有要回显的内容）");
    return { handled: true };
  },
};
