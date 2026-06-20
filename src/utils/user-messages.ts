import type {
  MemoryCandidate,
  MemoryCategory,
} from "../memory/memory-commands.js";
import type { MemoryListEntry } from "../memory/memory-repository.js";
import type {
  CodexRateLimitUsage,
  CodexRateLimitWindow,
} from "../agent/codex-rate-limit-client.js";

export function formatAgentFailure(error?: string): string {
  if (error === "Task timed out") return "任务超时，已经自动停止。";
  if (error === "Another Codex task is already running") {
    return "现在还有一个任务正在运行，请稍后再试，或发送 /取消。";
  }
  if (error === "Codex CLI could not be started") {
    return "Codex 暂时无法启动，请检查本机运行状态。";
  }
  if (error === "Workdir is outside ALLOWED_WORKSPACE_ROOT") {
    return "工作目录超出允许范围，任务没有执行。";
  }
  if (error === "Workdir does not exist or is not a directory") {
    return "工作目录不存在或不可用，任务没有执行。";
  }

  const exitCode = error?.match(/^Codex exited with code (-?\d+)$/)?.[1];
  if (exitCode) return `Codex 运行失败（退出码 ${exitCode}）。`;
  return "任务执行失败，请稍后重试。";
}

export const HELP_MESSAGE = [
  "QQ Codex Bridge 使用帮助",
  "",
  "直接发送文字：提交一个只读 Codex 任务",
  "/状态：查看 Bridge、NapCat、Codex 和任务状态",
  "/查询额度：查看 Codex 5 小时与周额度及重置时间",
  "/测试：检查连接，正常会回复 pong",
  "/取消：取消当前任务或待确认请求",
  "/确认：确认 60 秒内暂存的高风险请求",
  "/清空对话：清空当前窗口上下文，但保留本地聊天记录",
  "/新对话：创建并切换到新的对话窗口",
  "/查看对话：查看对话窗口编号和绑定人设",
  "/切换对话 01：切换到指定编号的对话窗口",
  "/查看当前人设：查看当前窗口绑定的人设",
  "/查看人设列表：查看全部人设编号和名称",
  "/切换人设 01：给当前窗口切换人设；00 为默认助手",
  "/记住 <内容>：生成记忆预览，不会立即写入",
  "/确认记忆：保存当前预览并同步到私有记忆库",
  "/取消记忆：丢弃当前记忆或遗忘预览",
  "/记忆列表：查看已确认记忆的标题和类别",
  "/同步记忆：安全检查并同步私有记忆库",
  "/遗忘 <编号>：生成删除预览；再发 /确认遗忘 才会删除",
  "/无记忆 <任务>：仅本次任务不调用长期记忆",
  "/帮助：再次查看本说明",
  "",
  "请勿发送密码、Token、Cookie、验证码、私钥或身份证信息。",
].join("\n");

export interface BridgeStatusView {
  napCatConnected: boolean;
  codexAvailable: boolean;
  agentMode: "mock" | "codex";
  taskRunning: boolean;
  confirmationPending: boolean;
  memoryAvailable: boolean;
  memoryCount: number;
  memoryPending: boolean;
  memoryRecallEnabled: boolean;
  workdirLabel: string;
}

export function formatBridgeStatus(status: BridgeStatusView): string {
  const agentStatus =
    status.agentMode === "codex"
      ? status.codexAvailable
        ? "可用（只读模式）"
        : "不可用"
      : "模拟模式";
  return [
    "QQ Codex Bridge 状态",
    "",
    "Bridge：运行中",
    `NapCat：${status.napCatConnected ? "已连接" : "未连接"}`,
    `Codex：${agentStatus}`,
    `当前任务：${status.taskRunning ? "运行中" : "空闲"}`,
    `待确认请求：${status.confirmationPending ? "有" : "无"}`,
    `记忆库：${status.memoryAvailable ? `可用（${status.memoryCount} 条）` : "不可用"}`,
    `待确认记忆：${status.memoryPending ? "有" : "无"}`,
    `记忆调用：${status.memoryRecallEnabled ? "已启用" : "不可用"}`,
    `工作区：${status.workdirLabel}（受限）`,
  ].join("\n");
}

export function formatCodexUsage(usage: CodexRateLimitUsage): string {
  return [
    "Codex 用量",
    "",
    formatUsageWindow("5 小时额度", usage.fiveHour),
    formatUsageWindow("周额度", usage.weekly),
    "",
    `查询时间：${formatBeijingTime(Math.floor(usage.fetchedAt / 1_000))}`,
    "数据来源：Codex 实时限额",
  ].join("\n");
}

function formatUsageWindow(
  label: string,
  window: CodexRateLimitWindow | null,
): string {
  if (!window) return `${label}：Codex 暂未返回`;
  const reset = window.resetsAt
    ? formatBeijingTime(window.resetsAt)
    : "暂未提供";
  return `${label}：剩余 ${window.remainingPercent}%（已用 ${window.usedPercent}%）\n重置时间：${reset}`;
}

function formatBeijingTime(epochSeconds: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1_000));
}

const CATEGORY_LABELS: Record<MemoryCategory, string> = {
  preference: "偏好",
  person: "人物",
  project: "项目",
  event: "事件",
  rule: "规则",
};

export function formatMemoryPreview(candidate: MemoryCandidate): string {
  return [
    "记忆候选已生成（尚未写入）",
    "",
    `类别：${CATEGORY_LABELS[candidate.category]}`,
    `标题：${candidate.title}`,
    `摘要：${candidate.summary}`,
    `更新或遗忘条件：${candidate.forgetCondition}`,
    "",
    "确认无误请发送 /确认记忆；不想保存请发送 /取消记忆。",
  ].join("\n");
}

export function formatMemoryList(entries: MemoryListEntry[]): string {
  if (entries.length === 0) return "私有记忆库目前还是空的。";
  const visible = entries.slice(0, 20);
  const lines = visible.map(
    (entry, index) =>
      `${index + 1}. [${CATEGORY_LABELS[entry.category]}] ${entry.title}`,
  );
  if (entries.length > visible.length) {
    lines.push(`…另有 ${entries.length - visible.length} 条未显示。`);
  }
  return [
    `已确认记忆（${entries.length} 条）`,
    "",
    ...lines,
    "",
    "需要删除时发送 /遗忘 编号，例如 /遗忘 1。",
  ].join("\n");
}

export function formatForgetPreview(entry: MemoryListEntry): string {
  return [
    "遗忘预览（尚未删除）",
    "",
    `类别：${CATEGORY_LABELS[entry.category]}`,
    `标题：${entry.title}`,
    "",
    "确认删除请发送 /确认遗忘；保留它请发送 /取消记忆。",
  ].join("\n");
}
