import { classifySensitiveContent } from "../security/sensitive-content-policy.js";

export type MemoryCategory = "preference" | "person" | "project" | "event" | "rule";

export type MemoryCommand =
  | { type: "remember"; content: string }
  | { type: "confirm-memory" }
  | { type: "cancel-memory" }
  | { type: "list-memory" }
  | { type: "sync-memory" }
  | { type: "forget"; index?: number }
  | { type: "confirm-forget" };

const CATEGORY_PREFIXES: ReadonlyArray<{
  pattern: RegExp;
  category: MemoryCategory;
}> = [
  { pattern: /^(?:偏好|习惯)\s*[：:]\s*/i, category: "preference" },
  { pattern: /^(?:人物|关系)\s*[：:]\s*/i, category: "person" },
  { pattern: /^(?:项目|工程)\s*[：:]\s*/i, category: "project" },
  { pattern: /^(?:事件|经历)\s*[：:]\s*/i, category: "event" },
  { pattern: /^(?:规则|要求)\s*[：:]\s*/i, category: "rule" },
];

export interface MemoryCandidate {
  category: MemoryCategory;
  title: string;
  summary: string;
  forgetCondition: string;
}

export function parseMemoryCommand(text: string): MemoryCommand | undefined {
  const trimmed = text.trim();
  const remember = trimmed.match(/^\/记住(?:\s+([\s\S]*))?$/);
  if (remember) return { type: "remember", content: remember[1]?.trim() ?? "" };
  if (trimmed === "/确认记忆") return { type: "confirm-memory" };
  if (trimmed === "/取消记忆") return { type: "cancel-memory" };
  if (trimmed === "/记忆列表") return { type: "list-memory" };
  if (trimmed === "/同步记忆") return { type: "sync-memory" };
  if (trimmed === "/确认遗忘") return { type: "confirm-forget" };

  const forget = trimmed.match(/^\/遗忘(?:\s+(\d+))?$/);
  if (forget) {
    return {
      type: "forget",
      index: forget[1] ? Number.parseInt(forget[1], 10) : undefined,
    };
  }
  return undefined;
}

export class UnsafeMemoryContentError extends Error {
  constructor() {
    super("Memory content contains a private identifier or unsupported structure");
  }
}

export function buildMemoryCandidate(input: string): MemoryCandidate {
  let content = input.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
  if (content.length < 2) throw new Error("Memory content is empty");
  if (content.length > 500) throw new Error("Memory content is too long");
  if (
    classifySensitiveContent(content).blocked ||
    /(?:QQ号|QQ号码|QQ\s*ID|账号|身份证|银行卡|手机号|手机号码|邮箱)\s*(?:是|为|[：:=])\s*\S+/i.test(
      content,
    ) ||
    /\b\d{5,18}\b/.test(content)
  ) {
    throw new UnsafeMemoryContentError();
  }

  let category: MemoryCategory | undefined;
  for (const prefix of CATEGORY_PREFIXES) {
    if (prefix.pattern.test(content)) {
      category = prefix.category;
      content = content.replace(prefix.pattern, "").trim();
      break;
    }
  }
  if (!content) throw new Error("Memory content is empty");

  category ??= inferCategory(content);
  const titleSource = content
    .replace(/[`#<>\[\]{}"']/g, "")
    .replace(/[：:]+/g, " ")
    .trim();
  const title = `${titleSource.slice(0, 26)}${titleSource.length > 26 ? "…" : ""}`;
  const sentence = /[。！？.!?]$/.test(content) ? content : `${content}。`;
  const summaryPrefixes: Record<MemoryCategory, string> = {
    preference: "用户确认的长期偏好是：",
    person: "经用户确认的人物关系摘要：",
    project: "用户确认的项目背景或长期约定：",
    event: "用户确认需要长期保留的事件摘要：",
    rule: "用户明确要求长期遵守：",
  };

  return {
    category,
    title: title || "用户确认记忆",
    summary: `${summaryPrefixes[category]}${sentence}`,
    forgetCondition: "用户提出更新、纠正或删除时。",
  };
}

function inferCategory(content: string): MemoryCategory {
  if (/(?:喜欢|偏好|习惯|希望你|称呼|回复风格)/.test(content)) return "preference";
  if (/(?:项目|工程|仓库|代码库|工作流)/.test(content)) return "project";
  if (/(?:朋友|同事|家人|亲友|搭档|是我的)/.test(content)) return "person";
  if (/(?:必须|禁止|不要|不允许|务必|规则)/.test(content)) return "rule";
  return "event";
}
