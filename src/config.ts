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
  CODEX_WORKDIR: z.string().min(1),
  ALLOWED_WORKSPACE_ROOT: z.string().min(1),
  MEMORY_REMOTE_URL: z.string().trim().default(""),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error"]).default("info"),
  TASK_TIMEOUT_SECONDS: z.coerce.number().int().positive().default(600),
  QQ_MESSAGE_CHUNK_SIZE: z.coerce.number().int().min(100).max(4_000).default(1_500),
  QQ_SENTENCES_PER_MESSAGE: z.coerce.number().int().min(1).max(10).default(2),
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
