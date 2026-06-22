import "dotenv/config";
import { z } from "zod";

const booleanText = z
  .enum(["true", "false"])
  .transform((value) => value === "true");

const schema = z.object({
  ONEBOT_HTTP_URL: z.string().url(),
  BRIDGE_WS_HOST: z.literal("127.0.0.1"),
  BRIDGE_WS_PORT: z.coerce.number().int().min(1).max(65_535),
  BRIDGE_WS_PATH: z.string().startsWith("/"),
  ONEBOT_ACCESS_TOKEN: z.string().min(12),
  ALLOWED_QQ_USER_ID: z.coerce.number().int().positive(),
  AGENT_MODE: z.enum(["mock", "codex"]).default("mock"),
  CODEX_COMMAND: z.string().min(1).default("codex"),
  CODEX_MODEL: z.string().min(1).default("gpt-5.4-mini"),
  CODEX_REASONING_EFFORT: z.enum(["low", "medium", "high", "xhigh"]).default("medium"),
  CODEX_WORKDIR: z.string().min(1),
  ALLOWED_WORKSPACE_ROOT: z.string().min(1),
  MEMORY_REMOTE_URL: z.string().trim().default(""),
  SILICONFLOW_API_KEY: z.string().trim().default(""),
  SILICONFLOW_BASE_URL: z.string().url().default("https://api.siliconflow.cn/v1"),
  MEMORY_EMBED_MODEL: z.string().min(1).default("BAAI/bge-m3"),
  MEMORY_VECTOR_WEIGHT: z.coerce.number().min(0).max(1).default(0.85),
  MEMORY_RELEVANCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.3),
  MEMORY_DEDUP_THRESHOLD: z.coerce.number().min(0).max(1).default(0.95),
  MEMORY_PRUNE_DAYS: z.coerce.number().int().min(0).default(90),
  MEMORY_MAINTENANCE_HOURS: z.coerce.number().int().min(0).default(24),
  MEMORY_EMOTION_BOOST: z.coerce.number().min(1).default(1.3),
  MEMORY_EMOTION_THRESHOLD: z.coerce.number().min(0).max(1).default(0.45),
  MEMORY_SPREAD_DECAY: z.coerce.number().min(0).max(1).default(0.5),
  MEMORY_SPREAD_THRESHOLD: z.coerce.number().min(0).max(1).default(0.6),
  MEMORY_RUMINATION_RATE: z.coerce.number().min(0).max(1).default(0.06),
  MEMORY_RUMINATION_MIN_AGE_DAYS: z.coerce.number().int().min(0).default(14),
  MEMORY_TIME_EDGE_DAYS: z.coerce.number().int().min(1).default(14),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TASK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  QQ_MESSAGE_CHUNK_SIZE: z.coerce.number().int().min(100).max(4_000).default(1_500),
  ALLOW_HIGH_RISK_COMMANDS: booleanText.default("false"),
  WEBUI_ENABLED: booleanText.default("true"),
  WEBUI_HOST: z.enum(["127.0.0.1", "0.0.0.0"]).default("0.0.0.0"),
  WEBUI_ALLOW_PUBLIC_ACCESS: booleanText.default("false"),
  WEBUI_PORT: z.coerce.number().int().min(1).max(65_535).default(3080),
  WEBUI_SESSION_HOURS: z.coerce.number().int().min(1).max(24 * 90).default(24 * 30),
  WEBUI_PAIRING_MINUTES: z.coerce.number().int().min(2).max(30).default(10),
});

export type BridgeConfig = z.infer<typeof schema>;

export function loadConfig(): BridgeConfig {
  return schema.parse(process.env);
}
