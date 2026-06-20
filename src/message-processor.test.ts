import { beforeEach, describe, expect, it, vi } from "vitest";
import { HighRiskConfirmation } from "./security/high-risk-confirmation.js";
import { MemoryDraftManager } from "./memory/memory-draft-manager.js";
import { MessageProcessor, type MessageProcessorOptions } from "./message-processor.js";
import type { OneBotPrivateMessageEvent } from "./onebot/types.js";
import { HELP_MESSAGE } from "./utils/user-messages.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function makeEvent(userId = 12345, messageId = 1): OneBotPrivateMessageEvent {
  return {
    time: 0,
    self_id: 1,
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    message_id: messageId,
    user_id: userId,
    raw_message: "",
    message: "",
  };
}

function makeOptions(overrides: Partial<MessageProcessorOptions> = {}): MessageProcessorOptions {
  const sender = {
    sendPrivateText: vi.fn(async () => {}),
  };

  const agent = {
    checkAvailable: vi.fn(async () => ({ ok: true, detail: "ok" })),
    run: vi.fn(async () => ({ ok: true, output: "agent reply", exitCode: 0 })),
    cancel: vi.fn(async () => false),
    isBusy: vi.fn(() => false),
  };

  const workspaceStore = {
    isCapacityFull: vi.fn(async () => false),
    appendMessage: vi.fn(async () => "conv-1"),
    activeConversation: vi.fn(async () => undefined as { id: string; name: string; personaId?: string } | undefined),
    createConversation: vi.fn(async () => ({ id: "conv-new", name: "新对话" })),
    clearConversationContext: vi.fn(async () => {}),
    activePersona: vi.fn(async () => undefined as { id: string; name: string; category: string; documents: unknown[] } | undefined),
    listConversations: vi.fn(async () => [] as Array<{ id: string; name: string; personaId?: string }>),
    listPersonas: vi.fn(async () => [] as Array<{ id: string; name: string; category: string; documents: unknown[] }>),
    selectConversation: vi.fn(async () => {}),
    selectPersona: vi.fn(async (_id: string | null) => {}),
    promptContext: vi.fn(async () => null as string | null),
  };

  const memoryRepository = {
    status: vi.fn(async () => ({ available: true, count: 3 })),
    add: vi.fn(async () => ({ synced: true })),
    remove: vi.fn(async () => ({ synced: true })),
    list: vi.fn(async () => [] as Array<{ title: string; category: string }>),
    sync: vi.fn(async () => ({ state: "up-to-date" as const })),
    readApprovedMemories: vi.fn(async () => []),
  };

  const autoMemory = {
    onConversationSwitch: vi.fn(async () => {}),
    onConversationUpdated: vi.fn(async () => {}),
  };

  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    fatal: vi.fn(),
    trace: vi.fn(),
    child: vi.fn(),
    level: "info" as const,
    silent: vi.fn(),
  };

  const config = {
    QQ_MESSAGE_CHUNK_SIZE: 4_000,
    AGENT_MODE: "codex" as const,
    ALLOW_HIGH_RISK_COMMANDS: false,
    CODEX_WORKDIR: "/workdir",
    TASK_TIMEOUT_SECONDS: 60,
  };

  return {
    config: config as never,
    sender: sender as never,
    agent: agent as never,
    workspaceStore: workspaceStore as never,
    memoryRepository: memoryRepository as never,
    autoMemory: autoMemory as never,
    highRiskConfirmation: new HighRiskConfirmation(60_000),
    memoryDrafts: new MemoryDraftManager(),
    rateLimitClient: undefined,
    availability: { ok: true, detail: "Codex CLI available" },
    logger: logger as never,
    isNapCatConnected: vi.fn(() => true),
    cancelMessageBuffer: vi.fn(() => false),
    ...overrides,
  };
}

/** 取第一条发出的私信文本 */
function firstSent(opts: MessageProcessorOptions): string {
  const calls = (opts.sender.sendPrivateText as ReturnType<typeof vi.fn>).mock.calls;
  return (calls[0]?.[1] as string) ?? "";
}

/** 取全部发出的私信文本（合并） */
function allSent(opts: MessageProcessorOptions): string {
  return (opts.sender.sendPrivateText as ReturnType<typeof vi.fn>).mock.calls
    .map((c) => c[1] as string)
    .join("");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("MessageProcessor", () => {
  let opts: MessageProcessorOptions;
  let proc: MessageProcessor;
  const event = makeEvent();

  beforeEach(() => {
    opts = makeOptions();
    proc = new MessageProcessor(opts);
  });

  // ── 容量防护 ──────────────────────────────────────────────────────────────
  describe("容量满时拦截", () => {
    it("容量满时发出警告并不调用 agent", async () => {
      (opts.workspaceStore.isCapacityFull as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await proc.process(event, "做个任务");
      expect(firstSent(opts)).toContain("达到设定上限");
      expect((opts.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });

  // ── 工作区指令 ────────────────────────────────────────────────────────────
  describe("工作区指令", () => {
    it("/新对话 创建对话并触发 autoMemory.onConversationSwitch", async () => {
      await proc.process(event, "/新对话");
      expect((opts.workspaceStore.createConversation as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect((opts.autoMemory.onConversationSwitch as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(firstSent(opts)).toContain("已创建新对话");
    });

    it("/清空对话 清空上下文并回复", async () => {
      await proc.process(event, "/清空对话");
      expect((opts.workspaceStore.clearConversationContext as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(firstSent(opts)).toContain("当前窗口的上下文已经清空");
    });

    it("/查看对话 无对话时回复空提示", async () => {
      await proc.process(event, "/查看对话");
      expect(firstSent(opts)).toContain("还没有对话窗口");
    });

    it("/查看对话 有对话时列出编号和名称", async () => {
      (opts.workspaceStore.listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "c1", name: "周报任务" },
        { id: "c2", name: "代码审查" },
      ]);
      (opts.workspaceStore.activeConversation as ReturnType<typeof vi.fn>).mockResolvedValue({ id: "c1", name: "周报任务" });
      await proc.process(event, "/查看对话");
      const reply = allSent(opts);
      expect(reply).toContain("01");
      expect(reply).toContain("周报任务");
      expect(reply).toContain("02");
      expect(reply).toContain("代码审查");
    });

    it("/切换对话 01 切换并回复", async () => {
      (opts.workspaceStore.listConversations as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "c1", name: "周报任务" },
      ]);
      await proc.process(event, "/切换对话 01");
      expect((opts.workspaceStore.selectConversation as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("c1");
      expect(firstSent(opts)).toContain("已切换到对话");
    });

    it("/切换对话 99 编号不存在时报错", async () => {
      await proc.process(event, "/切换对话 99");
      expect(firstSent(opts)).toContain("编号不存在");
    });

    it("/查看当前人设 无人设时回复默认", async () => {
      await proc.process(event, "/查看当前人设");
      expect(firstSent(opts)).toContain("默认助手");
    });

    it("/查看当前人设 有人设时回复详情", async () => {
      (opts.workspaceStore.activePersona as ReturnType<typeof vi.fn>).mockResolvedValue({
        id: "p1",
        name: "小助手",
        category: "日常",
        documents: ["doc1"],
      });
      await proc.process(event, "/查看当前人设");
      const reply = firstSent(opts);
      expect(reply).toContain("小助手");
      expect(reply).toContain("日常");
      expect(reply).toContain("1 份");
    });

    it("/查看人设列表 列出全部人设", async () => {
      (opts.workspaceStore.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "p1", name: "小助手", category: "日常", documents: [] },
      ]);
      await proc.process(event, "/查看人设列表");
      const reply = allSent(opts);
      expect(reply).toContain("01");
      expect(reply).toContain("小助手");
      expect(reply).toContain("00 默认助手");
    });

    it("/切换人设 00 切换到默认助手", async () => {
      await proc.process(event, "/切换人设 00");
      const call = (opts.workspaceStore.selectPersona as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(call[0]).toBeNull();
      expect(firstSent(opts)).toContain("默认助手");
    });

    it("/切换人设 01 切换到指定人设", async () => {
      (opts.workspaceStore.listPersonas as ReturnType<typeof vi.fn>).mockResolvedValue([
        { id: "p1", name: "小助手", category: "日常", documents: [] },
      ]);
      await proc.process(event, "/切换人设 01");
      expect((opts.workspaceStore.selectPersona as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe("p1");
      expect(firstSent(opts)).toContain("小助手");
    });

    it("/切换人设 99 编号不存在时报错", async () => {
      await proc.process(event, "/切换人设 99");
      expect(firstSent(opts)).toContain("编号不存在");
    });
  });

  // ── 桥接指令 ──────────────────────────────────────────────────────────────
  describe("桥接指令", () => {
    it("/ping 回复 pong", async () => {
      await proc.process(event, "/ping");
      expect(firstSent(opts)).toBe("pong");
    });

    it("/帮助 回复 HELP_MESSAGE", async () => {
      await proc.process(event, "/帮助");
      expect(firstSent(opts)).toContain(HELP_MESSAGE.slice(0, 20));
    });

    it("/状态 调用 isNapCatConnected 并包含状态信息", async () => {
      await proc.process(event, "/状态");
      expect(opts.isNapCatConnected).toHaveBeenCalled();
      expect(firstSent(opts)).toBeTruthy();
    });

    it("/查询额度 无 rateLimitClient 时提示模拟模式", async () => {
      await proc.process(event, "/查询额度");
      expect(firstSent(opts)).toContain("模拟模式");
    });

    it("/取消 agent 繁忙时取消任务", async () => {
      (opts.agent.cancel as ReturnType<typeof vi.fn>).mockResolvedValue(true);
      await proc.process(event, "/取消");
      expect(firstSent(opts)).toContain("当前任务已取消");
    });

    it("/取消 高风险待确认时取消确认", async () => {
      opts.highRiskConfirmation.stage("rm -rf /tmp", true);
      await proc.process(event, "/取消");
      expect(firstSent(opts)).toContain("待确认的请求已取消");
      expect(opts.highRiskConfirmation.hasPending()).toBe(false);
    });

    it("/取消 记忆操作待确认时取消记忆", async () => {
      opts.memoryDrafts.stageRemember({
        category: "preference",
        title: "测试",
        summary: "测试偏好",
        forgetCondition: "用户更新时",
      });
      await proc.process(event, "/取消");
      expect(firstSent(opts)).toContain("待确认的记忆操作已取消");
    });

    it("/取消 消息缓冲区有消息时取消缓冲", async () => {
      (opts.cancelMessageBuffer as ReturnType<typeof vi.fn>).mockReturnValue(true);
      await proc.process(event, "/取消");
      expect(firstSent(opts)).toContain("待合并发送的消息已取消");
    });

    it("/取消 无任何待处理时回复无任务", async () => {
      await proc.process(event, "/取消");
      expect(firstSent(opts)).toContain("当前没有正在运行的任务");
    });

    it("/确认 无待确认请求时报错", async () => {
      await proc.process(event, "/确认");
      expect(firstSent(opts)).toContain("没有待确认的高风险请求");
    });

    it("/确认 消费已暂存的高风险请求并执行", async () => {
      opts.highRiskConfirmation.stage("删除临时文件", true);
      await proc.process(event, "/确认");
      const runCalls = (opts.agent.run as ReturnType<typeof vi.fn>).mock.calls;
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0][0].prompt).toContain("删除临时文件");
    });
  });

  // ── 记忆指令 ──────────────────────────────────────────────────────────────
  describe("记忆指令", () => {
    it("/记住 不带内容时提示格式", async () => {
      await proc.process(event, "/记住");
      expect(firstSent(opts)).toContain("请在 /记住 后写");
    });

    it("/记住 偏好：回复简洁 暂存并预览候选", async () => {
      await proc.process(event, "/记住 偏好：回复简洁");
      expect(opts.memoryDrafts.hasPending()).toBe(true);
      // formatMemoryPreview 按双换行分段发送，标题在第二段
      expect(allSent(opts)).toContain("回复简洁");
    });

    it("/确认记忆 无待确认时报错", async () => {
      await proc.process(event, "/确认记忆");
      expect(firstSent(opts)).toContain("没有待确认的记忆");
    });

    it("/确认记忆 有待确认时写入记忆库", async () => {
      opts.memoryDrafts.stageRemember({
        category: "preference",
        title: "简洁回复",
        summary: "偏好简洁",
        forgetCondition: "用户更新时",
      });
      await proc.process(event, "/确认记忆");
      expect((opts.memoryRepository.add as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(opts.memoryDrafts.hasPending()).toBe(false);
      expect(firstSent(opts)).toContain("记忆已确认");
    });

    it("/取消记忆 有待确认时取消", async () => {
      opts.memoryDrafts.stageRemember({
        category: "preference",
        title: "测试",
        summary: "测试",
        forgetCondition: "用户更新时",
      });
      await proc.process(event, "/取消记忆");
      expect(firstSent(opts)).toContain("已取消");
      expect(opts.memoryDrafts.hasPending()).toBe(false);
    });

    it("/取消记忆 无待确认时回复无操作", async () => {
      await proc.process(event, "/取消记忆");
      expect(firstSent(opts)).toContain("没有待确认的记忆操作");
    });

    it("/记忆列表 调用 memoryRepository.list", async () => {
      (opts.memoryRepository.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { title: "简洁偏好", category: "preference" },
      ]);
      await proc.process(event, "/记忆列表");
      expect((opts.memoryRepository.list as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("/同步记忆 state=pulled 时回复已同步", async () => {
      (opts.memoryRepository.sync as ReturnType<typeof vi.fn>).mockResolvedValue({ state: "pulled" });
      await proc.process(event, "/同步记忆");
      expect(firstSent(opts)).toContain("安全同步");
    });

    it("/同步记忆 state=up-to-date 时回复已最新", async () => {
      await proc.process(event, "/同步记忆");
      expect(firstSent(opts)).toContain("最新状态");
    });

    it("/遗忘 不带编号时提示先查列表", async () => {
      await proc.process(event, "/遗忘");
      expect(firstSent(opts)).toContain("请先发送 /记忆列表");
    });

    it("/遗忘 1 暂存遗忘操作并预览", async () => {
      (opts.memoryRepository.list as ReturnType<typeof vi.fn>).mockResolvedValue([
        { title: "简洁偏好", category: "preference" },
      ]);
      await proc.process(event, "/遗忘 1");
      expect(opts.memoryDrafts.hasPending()).toBe(true);
      // formatForgetPreview 按双换行分段发送，标题在第二段
      expect(allSent(opts)).toContain("简洁偏好");
    });

    it("/遗忘 99 编号不存在时报错", async () => {
      await proc.process(event, "/遗忘 99");
      expect(firstSent(opts)).toContain("不在当前记忆列表");
    });

    it("/确认遗忘 无待确认时报错", async () => {
      await proc.process(event, "/确认遗忘");
      expect(firstSent(opts)).toContain("没有待确认的遗忘操作");
    });

    it("/确认遗忘 有待确认时从记忆库删除", async () => {
      const entry = { title: "简洁偏好", category: "preference" } as never;
      opts.memoryDrafts.stageForget(entry);
      await proc.process(event, "/确认遗忘");
      expect((opts.memoryRepository.remove as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
      expect(firstSent(opts)).toContain("已经从私有记忆库删除");
    });
  });

  // ── 高风险拦截 ────────────────────────────────────────────────────────────
  describe("高风险命令拦截", () => {
    it("检测到高风险词汇时暂存并要求确认", async () => {
      await proc.process(event, "请删除 /tmp 下的所有文件");
      expect(opts.highRiskConfirmation.hasPending()).toBe(true);
      expect(firstSent(opts)).toContain("高风险操作");
      expect((opts.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it("ALLOW_HIGH_RISK_COMMANDS=true 时跳过拦截直接执行", async () => {
      const o = makeOptions();
      (o.config as never as Record<string, unknown>).ALLOW_HIGH_RISK_COMMANDS = true;
      const p = new MessageProcessor(o);
      await p.process(event, "请删除 /tmp 下的所有文件");
      expect((o.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });
  });

  // ── 普通任务执行 ──────────────────────────────────────────────────────────
  describe("普通任务执行", () => {
    it("普通消息触发 agent.run 并把结果发回用户", async () => {
      await proc.process(event, "帮我写一段 TypeScript");
      const runCalls = (opts.agent.run as ReturnType<typeof vi.fn>).mock.calls;
      expect(runCalls).toHaveLength(1);
      expect(runCalls[0][0].workdir).toBe("/workdir");
      expect(firstSent(opts)).toBe("agent reply");
    });

    it("agent 返回 ok=false 时格式化错误信息", async () => {
      (opts.agent.run as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        output: "",
        error: "Task timed out",
        exitCode: null,
      });
      await proc.process(event, "长任务");
      expect(firstSent(opts)).toBeTruthy();
      expect((opts.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("agent 返回 Task cancelled 时静默返回不发消息", async () => {
      (opts.agent.run as ReturnType<typeof vi.fn>).mockResolvedValue({
        ok: false,
        output: "",
        error: "Task cancelled",
        exitCode: null,
      });
      await proc.process(event, "任务");
      expect((opts.sender.sendPrivateText as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });

    it("有 promptContext 时把上下文前置到 prompt", async () => {
      (opts.workspaceStore.promptContext as ReturnType<typeof vi.fn>).mockResolvedValue("历史上下文内容");
      await proc.process(event, "继续");
      const prompt = (opts.agent.run as ReturnType<typeof vi.fn>).mock.calls[0][0].prompt as string;
      expect(prompt).toContain("历史上下文内容");
      expect(prompt).toContain("继续");
    });

    it("有记忆时调用 readApprovedMemories 增强 prompt", async () => {
      await proc.process(event, "任务");
      expect((opts.memoryRepository.readApprovedMemories as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });
  });

  // ── /无记忆 ───────────────────────────────────────────────────────────────
  describe("/无记忆 模式", () => {
    it("/无记忆 帮我写代码 不调用记忆库并正常执行任务", async () => {
      await proc.process(event, "/无记忆 帮我写代码");
      expect((opts.memoryRepository.readApprovedMemories as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
      expect((opts.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1);
    });

    it("/无记忆 不带任务内容时提示补充内容", async () => {
      await proc.process(event, "/无记忆");
      expect(firstSent(opts)).toContain("请在 /无记忆 后写");
      expect((opts.agent.run as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(0);
    });
  });
});
