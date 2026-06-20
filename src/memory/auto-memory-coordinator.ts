import type { Logger } from "pino";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import { classifySensitiveContent } from "../security/sensitive-content-policy.js";
import type { BridgeWorkspaceStore } from "../workspace/bridge-workspace-store.js";
import type { MemoryCandidate, MemoryCategory } from "./memory-commands.js";
import type { MemoryMutationResult } from "./memory-repository.js";

type Trigger = "conversation-switch" | "token-threshold" | "schedule";

interface AutomaticMemoryStore {
  add(candidate: MemoryCandidate): Promise<MemoryMutationResult>;
}

export class AutoMemoryCoordinator {
  private readonly running = new Set<string>();
  private timer: NodeJS.Timeout | undefined;

  constructor(
    private readonly workspace: BridgeWorkspaceStore,
    private readonly memory: AutomaticMemoryStore,
    private readonly agent: AgentAdapter,
    private readonly logger: Logger,
    private readonly workdir: string,
    private readonly timeoutMs: number,
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.runScheduledIfDue(), 60_000);
    this.timer.unref();
    void this.runScheduledIfDue();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
  }

  async onConversationSwitch(conversationId: string | undefined): Promise<void> {
    if (!conversationId) return;
    const settings = await this.workspace.memorySettings();
    if (settings.mode !== "automatic" || !settings.onConversationSwitch) return;
    await this.summarize(conversationId, "conversation-switch");
  }

  async onConversationUpdated(conversationId: string): Promise<void> {
    const settings = await this.workspace.memorySettings();
    if (settings.mode !== "automatic" || !settings.onTokenThreshold) return;
    const pending = await this.workspace.pendingMemorySummary(conversationId);
    if (pending.estimatedTokens < settings.tokenThreshold) return;
    await this.summarize(conversationId, "token-threshold");
  }

  async runScheduledIfDue(now = new Date()): Promise<void> {
    const settings = await this.workspace.memorySettings();
    if (settings.mode !== "automatic" || !settings.onSchedule) return;
    const current = zonedParts(now, settings.timezone);
    if (`${current.hour}:${current.minute}` < settings.time) return;
    for (const conversation of await this.workspace.listConversations()) {
      if (conversation.lastMemorySummaryAt) {
        const previous = zonedParts(new Date(conversation.lastMemorySummaryAt), settings.timezone);
        if (previous.date === current.date) continue;
      }
      await this.summarize(conversation.id, "schedule");
    }
  }

  private async summarize(conversationId: string, trigger: Trigger): Promise<void> {
    if (this.running.has(conversationId) || this.agent.isBusy()) return;
    this.running.add(conversationId);
    try {
      const pending = await this.workspace.pendingMemorySummary(conversationId);
      if (pending.messages.length === 0) return;
      const safeMessages = pending.messages.filter(
        (message) => !classifySensitiveContent(message.text).blocked,
      );
      if (safeMessages.length === 0) {
        await this.workspace.markMemorySummarized(conversationId, pending.messageCount);
        return;
      }
      const transcript = safeMessages
        .map((message) => `${message.role === "user" ? "用户" : message.role === "assistant" ? "助手" : "系统"}：${message.text}`)
        .join("\n")
        .slice(-60_000);
      const result = await this.agent.run({
        prompt: buildAutomaticMemoryPrompt(transcript),
        workdir: this.workdir,
        timeoutMs: this.timeoutMs,
      });
      if (!result.ok) {
        this.logger.warn({ trigger, conversationId }, "Automatic memory summary failed");
        return;
      }
      const candidates = parseAutomaticMemoryCandidates(result.output);
      for (const candidate of candidates) {
        const safety = classifySensitiveContent(
          `${candidate.title}\n${candidate.summary}\n${candidate.forgetCondition}`,
        );
        if (safety.blocked) continue;
        await this.memory.add(candidate);
      }
      await this.workspace.markMemorySummarized(conversationId, pending.messageCount);
      this.logger.info(
        { trigger, conversationId, memoryCount: candidates.length },
        "Automatic memory summary completed",
      );
    } catch (error) {
      this.logger.warn(
        { trigger, conversationId, errorType: error instanceof Error ? error.name : "unknown" },
        "Automatic memory summary was skipped",
      );
    } finally {
      this.running.delete(conversationId);
    }
  }
}

export function parseAutomaticMemoryCandidates(output: string): MemoryCandidate[] {
  const start = output.indexOf("[");
  const end = output.lastIndexOf("]");
  if (start < 0 || end <= start) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(output.slice(start, end + 1));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const categories = new Set<MemoryCategory>(["preference", "person", "project", "event", "rule"]);
  return parsed.slice(0, 5).flatMap((entry) => {
    if (!entry || typeof entry !== "object") return [];
    const value = entry as Record<string, unknown>;
    const category = value.category;
    const title = typeof value.title === "string" ? value.title.trim() : "";
    const summary = typeof value.summary === "string" ? value.summary.trim() : "";
    const forgetCondition =
      typeof value.forgetCondition === "string" ? value.forgetCondition.trim() : "";
    if (
      typeof category !== "string" ||
      !categories.has(category as MemoryCategory) ||
      title.length < 2 ||
      title.length > 80 ||
      summary.length < 2 ||
      summary.length > 500 ||
      forgetCondition.length < 2 ||
      forgetCondition.length > 200
    ) {
      return [];
    }
    return [{ category: category as MemoryCategory, title, summary, forgetCondition }];
  });
}

function buildAutomaticMemoryPrompt(transcript: string): string {
  return [
    "你正在为本地私人记忆库整理对话新增内容。",
    "只保留长期稳定的用户偏好、对话习惯、项目习惯、人物关系、事件或明确规则，不要逐句复述。",
    "密码、Token、Cookie、验证码、私钥、证件号、账号标识、联系方式和可识别身份信息一律跳过。",
    "私人剧情只能使用安全、抽象的描述；无法安全概括时跳过。",
    "只输出 JSON 数组，不要 Markdown。没有适合长期保留的内容时输出 []。最多 5 条。",
    '每项格式：{"category":"preference|person|project|event|rule","title":"简短标题","summary":"客观摘要","forgetCondition":"用户提出更新、纠正或删除时。"}',
    "",
    "待整理的本地对话：",
    transcript,
  ].join("\n");
}

function zonedParts(date: Date, timezone: string): { date: string; hour: string; minute: string } {
  const offset = timezone.match(/^UTC([+-])(\d|1[0-4])(?::([0-5]\d))?$/u);
  if (timezone === "UTC" || offset) {
    const minutes = offset
      ? (Number(offset[2]) * 60 + Number(offset[3] ?? 0)) * (offset[1] === "+" ? 1 : -1)
      : 0;
    const shifted = new Date(date.getTime() + minutes * 60_000);
    return {
      date: shifted.toISOString().slice(0, 10),
      hour: shifted.toISOString().slice(11, 13),
      minute: shifted.toISOString().slice(14, 16),
    };
  }
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  const value = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "00";
  return {
    date: `${value("year")}-${value("month")}-${value("day")}`,
    hour: value("hour"),
    minute: value("minute"),
  };
}
