import { loadConfig } from "./config.js";
import { basename, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createLogger } from "./logger.js";
import { MockAgentAdapter } from "./agent/mock-agent-adapter.js";
import { CodexCliAdapter } from "./agent/codex-cli-adapter.js";
import { CodexRateLimitClient } from "./agent/codex-rate-limit-client.js";
import type { AgentAdapter } from "./agent/agent-adapter.js";
import { OneBotApiClient } from "./onebot/api-client.js";
import { OneBotEventServer } from "./onebot/event-server.js";
import { HighRiskConfirmation } from "./security/high-risk-confirmation.js";
import { MemoryDraftManager } from "./memory/memory-draft-manager.js";
import { MemoryRepository } from "./memory/memory-repository.js";
import { MemoryDecayStore } from "./memory/memory-decay-store.js";
import { MemoryVectorStore } from "./memory/memory-vector-store.js";
import { MemoryMaintenanceCoordinator } from "./memory/memory-maintenance.js";
import { SiliconFlowEmbedder } from "./memory/embedding-client.js";
import { MemoryVectorIndexer } from "./memory/memory-retrieval.js";
import { EmotionPrimer } from "./memory/memory-emotion.js";
import { AutoMemoryCoordinator } from "./memory/auto-memory-coordinator.js";
import { MessageProcessor } from "./message-processor.js";
import { MessagePipeline } from "./pipeline/message-pipeline.js";
import { PluginRegistry } from "./plugins/plugin-registry.js";
import { exampleEchoPlugin } from "./plugins/example-echo-plugin.js";
import { chunkReplyText } from "./utils/text.js";
import { WebUiServer } from "./webui/webui-server.js";
import { prepareWebUiAuthStorePath } from "./webui/webui-auth-path.js";
import { WindowsBridgeSystemControl } from "./system/windows-system-control.js";
import { BridgeWorkspaceStore } from "./workspace/bridge-workspace-store.js";
import { GitHubUpdateService } from "./update/github-update-service.js";
import { readFile } from "node:fs/promises";

try {
  const config = loadConfig();
  const logger = createLogger(config.LOG_LEVEL);
  const sender = new OneBotApiClient({
    baseUrl: config.ONEBOT_HTTP_URL,
    accessToken: config.ONEBOT_ACCESS_TOKEN,
    allowedUserId: config.ALLOWED_QQ_USER_ID,
  });
  const codexAdapter =
    config.AGENT_MODE === "codex"
      ? new CodexCliAdapter({
          command: config.CODEX_COMMAND,
          model: config.CODEX_MODEL,
          reasoningEffort: config.CODEX_REASONING_EFFORT,
          allowedWorkspaceRoot: config.ALLOWED_WORKSPACE_ROOT,
        })
      : undefined;
  const agent: AgentAdapter = codexAdapter ?? new MockAgentAdapter();
  const availability = await agent.checkAvailable();
  if (!availability.ok) throw new Error(availability.detail);
  const rateLimitClient = config.AGENT_MODE === "codex"
    ? new CodexRateLimitClient({ command: config.CODEX_COMMAND })
    : undefined;
  logger.info({ agentMode: config.AGENT_MODE }, availability.detail);
  const highRiskConfirmation = new HighRiskConfirmation(60_000);
  const memoryDrafts = new MemoryDraftManager();
  let botIdentity = { qq: "current", nickname: "当前 NapCat" };
  try {
    const loginInfo = await sender.getLoginInfo();
    botIdentity = { qq: String(loginInfo.userId), nickname: loginInfo.nickname };
  } catch (error) {
    logger.warn(
      { errorType: error instanceof Error ? error.name : "unknown" },
      "Bot identity is temporarily unavailable; WebUI will use a local placeholder",
    );
  }
  const workspaceStore = new BridgeWorkspaceStore(
    join(config.ALLOWED_WORKSPACE_ROOT, "bridge-data"),
    botIdentity,
  );
  await workspaceStore.initialize();
  const savedMemorySettings = await workspaceStore.memorySettings();
  const memoryRepository = new MemoryRepository(
    savedMemorySettings.memoryDirectory,
    config.MEMORY_REMOTE_URL || undefined,
  );
  const decayStore = new MemoryDecayStore(
    join(config.ALLOWED_WORKSPACE_ROOT, "bridge-data", "memory-decay.json"),
  );
  const vectorStore = new MemoryVectorStore(
    join(config.ALLOWED_WORKSPACE_ROOT, "bridge-data", "memory-vectors.json"),
  );
  const embedder = config.SILICONFLOW_API_KEY
    ? new SiliconFlowEmbedder({
        apiKey: config.SILICONFLOW_API_KEY,
        baseUrl: config.SILICONFLOW_BASE_URL,
        model: config.MEMORY_EMBED_MODEL,
      })
    : undefined;
  const vectorIndexer = embedder ? new MemoryVectorIndexer(embedder, vectorStore) : undefined;
  let primer: EmotionPrimer | undefined;
  if (embedder) {
    logger.info({ model: config.MEMORY_EMBED_MODEL }, "Vector memory retrieval is enabled");
    try {
      const built = new EmotionPrimer(embedder, {
        threshold: config.MEMORY_EMOTION_THRESHOLD,
        boost: config.MEMORY_EMOTION_BOOST,
      });
      await built.init();
      primer = built;
      logger.info("Emotion priming is enabled");
    } catch (error) {
      logger.warn(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Emotion priming anchors failed to embed; continuing without it",
      );
    }
  }
  const memoryMaintenance = new MemoryMaintenanceCoordinator({
    memory: memoryRepository,
    decayStore,
    vectorStore: embedder ? vectorStore : undefined,
    logger,
    dedupThreshold: config.MEMORY_DEDUP_THRESHOLD,
    pruneDays: config.MEMORY_PRUNE_DAYS,
    maintenanceHours: config.MEMORY_MAINTENANCE_HOURS,
  });
  const autoMemory = new AutoMemoryCoordinator(
    workspaceStore,
    memoryRepository,
    agent,
    logger,
    config.CODEX_WORKDIR,
    config.TASK_TIMEOUT_SECONDS * 1_000,
    decayStore,
    vectorIndexer,
  );
  let eventServer: OneBotEventServer;
  let pipeline: MessagePipeline;
  const processor = new MessageProcessor({
    config,
    sender,
    agent,
    workspaceStore,
    memoryRepository,
    decayStore,
    embedder,
    vectorStore,
    primer,
    vectorWeight: config.MEMORY_VECTOR_WEIGHT,
    relevanceThreshold: config.MEMORY_RELEVANCE_THRESHOLD,
    spreadDecay: config.MEMORY_SPREAD_DECAY,
    spreadThreshold: config.MEMORY_SPREAD_THRESHOLD,
    autoMemory,
    highRiskConfirmation,
    memoryDrafts,
    rateLimitClient,
    availability,
    logger,
    isNapCatConnected: () => eventServer.isNapCatConnected(),
    cancelMessageBuffer: (key) => pipeline.cancel(key),
  });

  const pluginRegistry = new PluginRegistry({
    logger,
    store: workspaceStore,
    sendReply: async (userId, replyText) => {
      for (const part of chunkReplyText(replyText, config.QQ_MESSAGE_CHUNK_SIZE)) {
        await sender.sendPrivateText(userId, part);
      }
    },
  });
  pluginRegistry.register(exampleEchoPlugin);
  await pluginRegistry.initialize();

  pipeline = new MessagePipeline({ processor, workspaceStore, logger, pluginRegistry });

  eventServer = new OneBotEventServer({
    host: config.BRIDGE_WS_HOST,
    port: config.BRIDGE_WS_PORT,
    path: config.BRIDGE_WS_PATH,
    accessToken: config.ONEBOT_ACCESS_TOKEN,
    allowedUserId: config.ALLOWED_QQ_USER_ID,
    logger,
    sender,
    onTextMessage: async (event, text) => {
      await pipeline.handle(event, text);
    },
    onSensitiveContent: async (_event, facts) => {
      logger.warn(
        {
          category: facts.category,
          recommendedAction: facts.recommendedAction,
        },
        "Persona-aware sensitive notice is pending; original content was discarded",
      );
    },
  });

  await eventServer.start();

  let webUiServer: WebUiServer | undefined;
  if (config.WEBUI_ENABLED) {
    let currentVersion = "0.0.0";
    try {
      const runtimePackage = JSON.parse(
        await readFile(join(process.cwd(), "package.json"), "utf8"),
      ) as { version?: string };
      if (runtimePackage.version) currentVersion = runtimePackage.version;
    } catch {
      logger.warn("Runtime package version is unavailable; update checks will use 0.0.0");
    }
    const softwareUpdate = new GitHubUpdateService({
      installRoot: process.cwd(),
      currentVersion,
      repository: "Akusative/QQ-Codex-Bridge",
    });
    const systemControl = new WindowsBridgeSystemControl({ installRoot: process.cwd() });
    const authStorePath = await prepareWebUiAuthStorePath(process.cwd());
    webUiServer = new WebUiServer({
      host: config.WEBUI_HOST,
      port: config.WEBUI_PORT,
      allowPublicAccess: config.WEBUI_ALLOW_PUBLIC_ACCESS,
      sessionTtlMs: config.WEBUI_SESSION_HOURS * 60 * 60_000,
      pairingTtlMs: config.WEBUI_PAIRING_MINUTES * 60_000,
      staticRoot: fileURLToPath(new URL("../webui/", import.meta.url)),
      authStorePath,
      logger,
      agent,
      memoryRepository,
      decayStore,
      vectorIndexer,
      memoryVectorStore: vectorStore,
      emotionPrimer: embedder ? primer : undefined,
      allowedWorkspaceRoot: config.ALLOWED_WORKSPACE_ROOT,
      autoMemory,
      workdir: config.CODEX_WORKDIR,
      taskTimeoutMs: config.TASK_TIMEOUT_SECONDS * 1_000,
      getStatus: async () => {
        const memoryStatus = await memoryRepository.status();
        const codexUsage = rateLimitClient
          ? await rateLimitClient.read().catch((error) => {
              logger.warn(
                { errorType: error instanceof Error ? error.name : "unknown" },
                "Codex rate-limit status is temporarily unavailable",
              );
              return undefined;
            })
          : undefined;
        return {
          napCatConnected: eventServer.isNapCatConnected(),
          codexAvailable: availability.ok,
          taskRunning: agent.isBusy(),
          memoryCount: memoryStatus.count,
          memoryAvailable: memoryStatus.available,
          codexUsage,
        };
      },
      workspaceStore,
      personaDocumentExtractorScriptPath: fileURLToPath(
        new URL("../scripts/extract-persona-document.py", import.meta.url),
      ),
      softwareUpdate,
      systemControl,
      getModel: codexAdapter ? () => codexAdapter.model : undefined,
      setModel: codexAdapter ? (m) => { codexAdapter.model = m; } : undefined,
      getReasoningEffort: codexAdapter ? () => codexAdapter.reasoningEffort : undefined,
      setReasoningEffort: codexAdapter ? (e) => { codexAdapter.reasoningEffort = e; } : undefined,
      getPlugins: () => pluginRegistry.list(),
      setPluginEnabled: (id, enabled) => pluginRegistry.setEnabled(id, enabled),
    });
    try {
      await webUiServer.start();
    } catch (error) {
      logger.error(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "WebUI failed to start; QQ Bridge remains available",
      );
      webUiServer = undefined;
    }
  }

  autoMemory.start();
  memoryMaintenance.start();

  // 启动后异步回填缺向量的记忆（不阻塞启动；硅基失败则跳过、下次再补）。
  if (vectorIndexer) {
    void memoryRepository
      .readApprovedMemories()
      .then((entries) => vectorIndexer.backfill(entries))
      .catch(() => undefined);
  }

  let stopping = false;
  const shutdown = async () => {
    if (stopping) return;
    stopping = true;
    logger.info("Stopping QQ Codex Bridge");
    pipeline.clear();
    autoMemory.stop();
    memoryMaintenance.stop();
    if (webUiServer) await webUiServer.stop();
    await pluginRegistry.shutdown();
    await eventServer.stop();
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());
} catch (error) {
  const logger = createLogger("error");
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  if (code === "EADDRINUSE") {
    const err = error as NodeJS.ErrnoException & { address?: string; port?: number };
    logger.error(
      { error },
      `端口被占用，Bridge 无法启动（${err.address ?? ""}:${err.port ?? ""}）。可能有旧实例没退出——先结束占用该端口的进程或重启服务器。`,
    );
  } else if (error instanceof Error && error.name === "ZodError") {
    logger.error({ error }, "Bridge configuration is incomplete or invalid");
  } else {
    logger.error({ error }, error instanceof Error ? `Bridge 启动失败：${error.message}` : "Bridge failed to start");
  }
  process.exitCode = 1;
}

