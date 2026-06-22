import { basename } from "node:path";
import type { Logger } from "pino";
import type { AgentAdapter } from "./agent/agent-adapter.js";
import type { CodexRateLimitClient } from "./agent/codex-rate-limit-client.js";
import type { BridgeConfig } from "./config.js";
import {
  buildMemoryCandidate,
  parseMemoryCommand,
  UnsafeMemoryContentError,
} from "./memory/memory-commands.js";
import {
  buildMemoryAugmentedPrompt,
  isRelevantText,
  parseMemoryTaskMode,
  selectRelevantMemories,
} from "./memory/memory-context.js";
import type { MemoryDecayStore } from "./memory/memory-decay-store.js";
import type { TextEmbedder } from "./memory/embedding-client.js";
import type { MemoryVectorStore } from "./memory/memory-vector-store.js";
import { buildHybridRelevance } from "./memory/memory-retrieval.js";
import type { EmotionPrimer } from "./memory/memory-emotion.js";
import type { MemoryDraftManager } from "./memory/memory-draft-manager.js";
import {
  type ApprovedMemoryEntry,
  type MemoryRepository,
  MemoryRepositoryError,
} from "./memory/memory-repository.js";
import type { AutoMemoryCoordinator } from "./memory/auto-memory-coordinator.js";
import type { OneBotApiClient } from "./onebot/api-client.js";
import type { OneBotPrivateMessageEvent } from "./onebot/types.js";
import {
  guardConfirmedHighRiskOutput,
  requiresConfirmation,
} from "./security/command-policy.js";
import type { HighRiskConfirmation } from "./security/high-risk-confirmation.js";
import { chunkReplyText } from "./utils/text.js";
import { parseBridgeCommand, parseWorkspaceCommand } from "./utils/commands.js";
import {
  formatAgentFailure,
  formatBridgeStatus,
  formatCodexUsage,
  formatForgetPreview,
  formatMemoryList,
  formatMemoryPreview,
  HELP_MESSAGE,
} from "./utils/user-messages.js";
import type { BridgeWorkspaceStore } from "./workspace/bridge-workspace-store.js";

export interface MessageProcessorOptions {
  config: BridgeConfig;
  sender: OneBotApiClient;
  agent: AgentAdapter;
  workspaceStore: BridgeWorkspaceStore;
  memoryRepository: MemoryRepository;
  decayStore?: MemoryDecayStore;
  embedder?: TextEmbedder;
  vectorStore?: MemoryVectorStore;
  primer?: EmotionPrimer;
  vectorWeight?: number;
  relevanceThreshold?: number;
  spreadDecay?: number;
  spreadThreshold?: number;
  autoMemory: AutoMemoryCoordinator;
  highRiskConfirmation: HighRiskConfirmation;
  memoryDrafts: MemoryDraftManager;
  rateLimitClient: CodexRateLimitClient | undefined;
  availability: { ok: boolean; detail: string };
  logger: Logger;
  isNapCatConnected: () => boolean;
  cancelMessageBuffer: (key: string) => boolean;
}

export class MessageProcessor {
  constructor(private readonly options: MessageProcessorOptions) {}

  async process(event: OneBotPrivateMessageEvent, text: string): Promise<void> {
    const {
      config,
      sender,
      agent,
      workspaceStore,
      memoryRepository,
      autoMemory,
      highRiskConfirmation,
      memoryDrafts,
      rateLimitClient,
      availability,
      logger,
      isNapCatConnected,
      cancelMessageBuffer,
    } = this.options;

    if (await workspaceStore.isCapacityFull()) {
      await sender.sendPrivateText(
        event.user_id,
        "本地聊天记录已经达到设定上限。请先在 WebUI 清理旧窗口，或提高容量上限后再继续。",
      );
      return;
    }
    let command = text.trim();
    const workspaceCommand = parseWorkspaceCommand(command);
    let conversationId: string;
    if (workspaceCommand?.type === "new-conversation") {
      const previousConversation = await workspaceStore.activeConversation();
      const created = await workspaceStore.createConversation();
      conversationId = await workspaceStore.appendMessage("user", text, created.id);
      void autoMemory.onConversationSwitch(previousConversation?.id);
    } else {
      conversationId = await workspaceStore.appendMessage("user", text);
    }
    let confirmedHighRisk = false;
    const bridgeCommand = parseBridgeCommand(command);
    const memoryCommand = parseMemoryCommand(command);
    const memoryTaskMode = parseMemoryTaskMode(command);
    let useMemory = memoryTaskMode.useMemory;
    if (!useMemory) command = memoryTaskMode.task;

    const sendReply = async (reply: string) => {
      for (const part of chunkReplyText(
        reply,
        config.QQ_MESSAGE_CHUNK_SIZE,
      )) {
        await sender.sendPrivateText(event.user_id, part);
      }
      await workspaceStore.appendMessage("assistant", reply, conversationId);
      void autoMemory.onConversationUpdated(conversationId);
    };

    if (workspaceCommand) {
      if (workspaceCommand.type === "clear-conversation") {
        await sendReply("当前窗口的上下文已经清空。聊天记录仍保留在本机，但后续任务不会再引用清空前的内容。");
        await workspaceStore.clearConversationContext(conversationId);
        return;
      }
      if (workspaceCommand.type === "new-conversation") {
        const activeConversation = await workspaceStore.activeConversation();
        const activePersona = await workspaceStore.activePersona();
        await sendReply(
          `已创建新对话：${activeConversation?.name ?? "新对话"}\n当前人设：${activePersona?.name ?? "默认助手"}`,
        );
        return;
      }
      if (workspaceCommand.type === "list-conversations") {
        const [conversations, activeConversation, personas] = await Promise.all([
          workspaceStore.listConversations(),
          workspaceStore.activeConversation(),
          workspaceStore.listPersonas(),
        ]);
        const personaNames = new Map(personas.map((persona) => [persona.id, persona.name]));
        await sendReply(
          conversations.length
            ? [
                "对话窗口列表",
                "",
                ...conversations.map((conversation, index) =>
                  `${formatCommandIndex(index + 1)} ${conversation.name}｜${conversation.personaId ? personaNames.get(conversation.personaId) ?? "默认助手" : "默认助手"}${conversation.id === activeConversation?.id ? "（当前）" : ""}`,
                ),
                "",
                "切换时发送：/切换对话 01",
              ].join("\n")
            : "目前还没有对话窗口。发送 /新对话 即可创建。",
        );
        return;
      }
      if (workspaceCommand.type === "select-conversation") {
        const conversations = await workspaceStore.listConversations();
        const selected = conversations[workspaceCommand.index - 1];
        if (!selected) {
          await sendReply("这个对话编号不存在。请发送 /查看对话 获取最新列表。");
          return;
        }
        const previousConversation = await workspaceStore.activeConversation();
        await workspaceStore.selectConversation(selected.id);
        conversationId = selected.id;
        const persona = await workspaceStore.activePersona();
        await sendReply(`已切换到对话：${selected.name}\n当前人设：${persona?.name ?? "默认助手"}`);
        if (previousConversation?.id !== selected.id) {
          void autoMemory.onConversationSwitch(previousConversation?.id);
        }
        return;
      }
      if (workspaceCommand.type === "current-persona") {
        const [persona, activeConversation] = await Promise.all([
          workspaceStore.activePersona(),
          workspaceStore.activeConversation(),
        ]);
        await sendReply(
          persona
            ? `当前窗口：${activeConversation?.name ?? "未命名窗口"}\n当前人设：${persona.name}\n分类：${persona.category}\n资料文档：${persona.documents.length} 份`
            : `当前窗口：${activeConversation?.name ?? "未命名窗口"}\n当前人设：默认助手`,
        );
        return;
      }
      if (workspaceCommand.type === "list-personas") {
        const [personas, activePersona] = await Promise.all([
          workspaceStore.listPersonas(),
          workspaceStore.activePersona(),
        ]);
        await sendReply([
          "人设列表",
          "",
          `00 默认助手${activePersona ? "" : "（当前）"}`,
          ...personas.map((persona, index) =>
            `${formatCommandIndex(index + 1)} ${persona.name}${persona.id === activePersona?.id ? "（当前）" : ""}`,
          ),
          "",
          "切换时发送：/切换人设 01",
        ].join("\n"));
        return;
      }
      if (workspaceCommand.type === "select-persona") {
        const personas = await workspaceStore.listPersonas();
        const selected = workspaceCommand.index === 0
          ? null
          : personas[workspaceCommand.index - 1];
        if (workspaceCommand.index !== 0 && !selected) {
          await sendReply("这个人设编号不存在。请发送 /查看人设列表 获取最新列表。");
          return;
        }
        await workspaceStore.selectPersona(selected?.id ?? null);
        await sendReply(`当前窗口已切换人设：${selected?.name ?? "默认助手"}`);
        return;
      }
    }

    if (bridgeCommand === "ping") {
      await sendReply("pong");
      return;
    }

    if (!useMemory && !command) {
      await sendReply("请在 /无记忆 后写本次任务内容；这只会关闭当前这一条任务的记忆调用。");
      return;
    }

    if (bridgeCommand === "help") {
      await sendReply(HELP_MESSAGE);
      return;
    }

    if (bridgeCommand === "status") {
      const memoryStatus = await memoryRepository.status();
      await sendReply(
        formatBridgeStatus({
          napCatConnected: isNapCatConnected(),
          codexAvailable: availability.ok,
          agentMode: config.AGENT_MODE,
          taskRunning: agent.isBusy(),
          confirmationPending: highRiskConfirmation.hasPending(),
          memoryAvailable: memoryStatus.available,
          memoryCount: memoryStatus.count,
          memoryPending: memoryDrafts.hasPending(),
          memoryRecallEnabled: memoryStatus.available,
          workdirLabel: basename(config.CODEX_WORKDIR),
        }),
      );
      return;
    }

    if (bridgeCommand === "usage") {
      if (!rateLimitClient) {
        await sendReply("当前使用的是模拟模式，无法查询 Codex 额度。");
        return;
      }
      try {
        await sendReply(formatCodexUsage(await rateLimitClient.read(true)));
      } catch (error) {
        logger.warn(
          { errorType: error instanceof Error ? error.name : "unknown" },
          "Codex rate-limit query failed",
        );
        await sendReply(
          "暂时没能从 Codex 取得额度。请确认 Codex 已登录并且 CLI 版本支持 /usage，然后稍后再试。",
        );
      }
      return;
    }

    if (memoryCommand?.type === "remember") {
      if (!memoryCommand.content) {
        await sendReply(
          `请在 /记住 后写要长期保留的内容。也可以用“偏好：”“人物：”“项目：”“事件：”或“规则：”指定类别。\n例如：/记住 偏好：回复尽量简洁`,
        );
        return;
      }
      try {
        const candidate = buildMemoryCandidate(memoryCommand.content);
        memoryDrafts.stageRemember(candidate);
        await sendReply(formatMemoryPreview(candidate));
      } catch (error) {
        await sendReply(
          error instanceof UnsafeMemoryContentError
            ? "这条内容疑似包含账号或其他私密标识，我没有生成记忆，也不会保存。请删去这些信息后重新概括。"
            : "这条记忆无法生成。请把内容控制在 2 到 500 个字之间，再试一次。",
        );
      }
      return;
    }

    if (memoryCommand?.type === "confirm-memory") {
      const candidate = memoryDrafts.getRemember();
      if (!candidate) {
        await sendReply("目前没有待确认的记忆。请先发送 /记住 加上内容。");
        return;
      }
      try {
        const result = await memoryRepository.add(candidate);
        memoryDrafts.clear();
        await sendReply(
          result.synced
            ? "记忆已确认，并已保存到私有记忆库。"
            : "记忆已安全保存到本机并生成提交，但同步私有 GitHub 失败。内容不会转到其他位置，稍后可以再处理同步。",
        );
      } catch (error) {
        await sendReply(formatMemoryRepositoryError(error));
      }
      return;
    }

    if (memoryCommand?.type === "cancel-memory") {
      await sendReply(
        memoryDrafts.cancel()
          ? "当前记忆操作已取消，没有写入或删除。"
          : "目前没有待确认的记忆操作。",
      );
      return;
    }

    if (memoryCommand?.type === "list-memory") {
      try {
        await sendReply(formatMemoryList(await memoryRepository.list()));
      } catch (error) {
        await sendReply(formatMemoryRepositoryError(error));
      }
      return;
    }

    if (memoryCommand?.type === "sync-memory") {
      try {
        const result = await memoryRepository.sync();
        await sendReply(
          result.state === "pulled"
            ? "已从私有记忆库安全同步最新内容。"
            : result.state === "pushed"
              ? "本机待同步的记忆提交已推送到私有仓库。"
              : "记忆库已经是最新状态。",
        );
      } catch (error) {
        await sendReply(formatMemoryRepositoryError(error));
      }
      return;
    }

    if (memoryCommand?.type === "forget") {
      if (!memoryCommand.index) {
        await sendReply("请先发送 /记忆列表，再用 /遗忘 加编号，例如 /遗忘 1。");
        return;
      }
      try {
        const entries = await memoryRepository.list();
        const entry = entries[memoryCommand.index - 1];
        if (!entry) {
          await sendReply("这个编号不在当前记忆列表里，请重新发送 /记忆列表 查看。");
          return;
        }
        memoryDrafts.stageForget(entry);
        await sendReply(formatForgetPreview(entry));
      } catch (error) {
        await sendReply(formatMemoryRepositoryError(error));
      }
      return;
    }

    if (memoryCommand?.type === "confirm-forget") {
      const entry = memoryDrafts.getForget();
      if (!entry) {
        await sendReply("目前没有待确认的遗忘操作。请先发送 /记忆列表，再发送 /遗忘 编号。");
        return;
      }
      try {
        const result = await memoryRepository.remove(entry);
        memoryDrafts.clear();
        await sendReply(
          result.synced
            ? "这条记忆已经从私有记忆库删除。"
            : "这条记忆已在本机删除并生成提交，但同步私有 GitHub 失败。稍后可以再处理同步。",
        );
      } catch (error) {
        await sendReply(formatMemoryRepositoryError(error));
      }
      return;
    }

    if (bridgeCommand === "confirm") {
      const confirmedRequest = highRiskConfirmation.consume();
      if (!confirmedRequest) {
        await sendReply("没有待确认的高风险请求，可能已经超时或取消。");
        return;
      }
      command = confirmedRequest.prompt;
      useMemory = confirmedRequest.useMemory;
      confirmedHighRisk = true;
    }

    if (bridgeCommand === "cancel") {
      const cancelled = await agent.cancel();
      const pendingCancelled = highRiskConfirmation.cancel();
      const memoryCancelled = memoryDrafts.cancel();
      const bufferedCancelled = cancelMessageBuffer(String(event.user_id));
      await sendReply(
        cancelled
          ? "当前任务已取消。"
          : pendingCancelled
            ? "待确认的请求已取消。"
            : memoryCancelled
              ? "待确认的记忆操作已取消。"
              : bufferedCancelled
                ? "待合并发送的消息已取消。"
                : "当前没有正在运行的任务。",
      );
      return;
    }

    if (
      !confirmedHighRisk &&
      !config.ALLOW_HIGH_RISK_COMMANDS &&
      requiresConfirmation(command)
    ) {
      highRiskConfirmation.stage(command, useMemory);
      await sendReply(
        "检测到高风险操作，任务尚未执行。若仍要在只读模式中继续，请在 60 秒内发送 /确认；发送 /取消 可取消。",
      );
      logger.warn(
        { messageId: event.message_id },
        "High-risk request is awaiting confirmation",
      );
      return;
    }

    let agentPrompt = command;
    if (useMemory) {
      try {
        const approvedMemories = await memoryRepository.readApprovedMemories();
        const decaySnapshot = this.options.decayStore
          ? await this.options.decayStore.snapshot()
          : undefined;
        // 按窗口隔离：只用本窗口名下的记忆（无归属的遗留记忆作全局兜底）。
        const scopedMemories = decaySnapshot
          ? approvedMemories.filter((memory) => {
              const owner = decaySnapshot(memory.relativePath)?.conversationId;
              return !owner || owner === conversationId;
            })
          : approvedMemories;
        // 向量混合检索：能用 embedder 就用，失败/未配则 relevance=undefined → 回退关键词。
        let relevance: ((entry: ApprovedMemoryEntry) => number) | undefined;
        if (this.options.embedder && this.options.vectorStore) {
          relevance = await buildHybridRelevance(command, scopedMemories, {
            embedder: this.options.embedder,
            vectorStore: this.options.vectorStore,
            vectorWeight: this.options.vectorWeight,
            primer: this.options.primer,
            spread: {
              decay: this.options.spreadDecay ?? 0,
              threshold: this.options.spreadThreshold ?? 0.6,
            },
          });
        }
        const selectedMemories = selectRelevantMemories(command, scopedMemories, {
          decay: decaySnapshot,
          relevance,
          relevanceThreshold: relevance ? (this.options.relevanceThreshold ?? 0.3) : undefined,
        });
        // 永久记忆：本窗口的；新对话首条带一次，其余轮次仅在与本轮相关时带上。
        const permanentText = await workspaceStore.conversationPermanentMemory(conversationId);
        let permanentForPrompt: string | undefined;
        if (permanentText.trim()) {
          const activeConversation = await workspaceStore.activeConversation();
          const isConversationStart = activeConversation?.messageCount === 1;
          if (isConversationStart || isRelevantText(command, permanentText)) {
            permanentForPrompt = permanentText;
          }
        }
        agentPrompt = buildMemoryAugmentedPrompt(command, selectedMemories, permanentForPrompt);
        if (this.options.decayStore && selectedMemories.length > 0) {
          // 提鲜：被选用的非永久记忆刷新时间、累加次数。
          void this.options.decayStore.touch(
            selectedMemories.map((memory) => memory.relativePath),
          );
        }
        logger.info(
          {
            messageId: event.message_id,
            selectedMemoryCount: selectedMemories.length,
            permanentMemory: Boolean(permanentForPrompt),
            selectedMemoryCategories: [
              ...new Set(selectedMemories.map((memory) => memory.category)),
            ],
          },
          "Prepared user-confirmed memory context",
        );
      } catch (error) {
        logger.warn(
          {
            messageId: event.message_id,
            memoryStatus:
              error instanceof MemoryRepositoryError ? error.code : "unknown",
          },
          "Memory context unavailable; continuing without memory",
        );
      }
    } else {
      logger.info(
        { messageId: event.message_id },
        "Memory context disabled for this task by user command",
      );
    }

    const localConversationContext = await workspaceStore.promptContext(conversationId);
    if (localConversationContext) {
      agentPrompt = `${localConversationContext}\n\n当前任务：\n${agentPrompt}`;
    }

    const result = await agent.run({
      // `/确认` replaces `command` with the previously staged request.
      prompt: agentPrompt,
      workdir: config.CODEX_WORKDIR,
      timeoutMs: config.TASK_TIMEOUT_SECONDS * 1_000,
    });
    if (!result.ok && result.error === "Task cancelled") {
      logger.info(
        { messageId: event.message_id, agentMode: config.AGENT_MODE },
        "Cancelled agent task finished",
      );
      return;
    }
    const reply = result.ok
      ? confirmedHighRisk
        ? guardConfirmedHighRiskOutput(result.output)
        : result.output
      : formatAgentFailure(result.error);
    await sendReply(reply);
    logger.info(
      { messageId: event.message_id, agentMode: config.AGENT_MODE, ok: result.ok },
      "Agent task reply sent",
    );
  }
}

export function formatMemoryRepositoryError(error: unknown): string {
  if (error instanceof MemoryRepositoryError) {
    if (error.code === "dirty") {
      return "记忆库里存在尚未处理的本地改动。为了避免误提交，我没有执行这次操作。";
    }
    if (error.code === "unsafe") {
      return "安全复检没有通过，这条内容未写入记忆库。请移除账号、凭证或身份信息后重新概括。";
    }
    if (error.code === "unavailable") {
      return "私有记忆库目前不可用，或远端地址与预期不一致；本次没有写入。";
    }
    if (error.code === "conflict") {
      return "检测到两台设备都修改过记忆库。为避免覆盖内容，同步已停止，没有自动合并；请在其中一台设备上处理分叉后再试。";
    }
  }
  return "记忆操作没有完成，现有记忆未被改动。";
}

export function formatCommandIndex(index: number): string {
  return String(index).padStart(2, "0");
}
