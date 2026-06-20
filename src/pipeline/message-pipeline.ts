import type { Logger } from "pino";
import type { OneBotPrivateMessageEvent } from "../onebot/types.js";
import { SlidingMessageBuffer } from "../onebot/message-buffer.js";
import type { MessageProcessor } from "../message-processor.js";
import { classifySensitiveContent } from "../security/sensitive-content-policy.js";
import { CommandRouter } from "./command-router.js";
import type { PluginIncomingMessage } from "../plugins/plugin-types.js";

interface WorkspaceBufferSettings {
  messageBufferSettings(): Promise<{ waitSeconds: number }>;
}

interface PluginDispatcher {
  dispatch(message: PluginIncomingMessage): Promise<boolean>;
}

export interface MessagePipelineOptions {
  processor: MessageProcessor;
  workspaceStore: WorkspaceBufferSettings;
  logger: Logger;
  pluginRegistry?: PluginDispatcher;
}

export class MessagePipeline {
  private readonly buffer: SlidingMessageBuffer<OneBotPrivateMessageEvent>;
  private readonly router = new CommandRouter();

  constructor(private readonly options: MessagePipelineOptions) {
    const { processor, logger } = options;
    this.buffer = new SlidingMessageBuffer<OneBotPrivateMessageEvent>(
      async (event, combinedText, messageCount) => {
        const sensitive = classifySensitiveContent(combinedText);
        if (sensitive.blocked) {
          logger.warn(
            { category: sensitive.category, messageId: event.message_id, messageCount },
            "Combined QQ message was blocked before agent processing",
          );
          return;
        }
        logger.info(
          { messageId: event.message_id, messageCount },
          "Flushing locally buffered QQ messages as one task",
        );
        await processor.process(event, combinedText);
      },
      (error) => {
        logger.error(
          { errorType: error instanceof Error ? error.name : "unknown" },
          "Contained buffered QQ message processing error",
        );
      },
    );
  }

  cancel(key: string): boolean {
    return this.buffer.cancel(key);
  }

  clear(): void {
    this.buffer.clear();
  }

  async handle(event: OneBotPrivateMessageEvent, text: string): Promise<void> {
    if (this.options.pluginRegistry) {
      const handledByPlugin = await this.options.pluginRegistry.dispatch({
        userId: event.user_id,
        text,
        event,
      });
      if (handledByPlugin) return;
    }
    const { isImmediate, skipFlush } = this.router.classify(text);
    const key = String(event.user_id);
    if (isImmediate) {
      if (!skipFlush) await this.buffer.flush(key);
      await this.options.processor.process(event, text);
      return;
    }
    const { waitSeconds } = await this.options.workspaceStore.messageBufferSettings();
    await this.buffer.enqueue(key, event, text, waitSeconds * 1_000);
  }
}
