import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { homedir, networkInterfaces } from "node:os";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { Logger } from "pino";
import type { AgentAdapter } from "../agent/agent-adapter.js";
import type { CodexRateLimitUsage } from "../agent/codex-rate-limit-client.js";
import {
  guardConfirmedHighRiskOutput,
  requiresConfirmation,
} from "../security/command-policy.js";
import {
  classifySensitiveContent,
  createSensitiveNoticeFacts,
} from "../security/sensitive-content-policy.js";
import {
  buildMemoryCandidate,
  UnsafeMemoryContentError,
} from "../memory/memory-commands.js";
import {
  buildMemoryAugmentedPrompt,
  fuzzyMemoryDate,
  selectRelevantMemories,
} from "../memory/memory-context.js";
import { isRecallStyle } from "../memory/memory-recall-style.js";
import { MemoryDraftManager } from "../memory/memory-draft-manager.js";
import {
  type ApprovedMemoryEntry,
  type MemoryListEntry,
  type MemoryMutationResult,
  MemoryRepositoryError,
  type MemorySyncResult,
} from "../memory/memory-repository.js";
import type { MemoryCandidate } from "../memory/memory-commands.js";
import { formatAgentFailure } from "../utils/user-messages.js";
import type { BridgeWorkspaceStore } from "../workspace/bridge-workspace-store.js";
import type { SoftwareUpdateController } from "../update/github-update-service.js";
import type { BridgeSystemController } from "../system/windows-system-control.js";
import type { PluginInfo } from "../plugins/plugin-types.js";
import {
  extractPersonaDocument,
  PERSONA_DOCUMENT_EXTENSIONS,
} from "../workspace/persona-document-extractor.js";
import { WebUiAuthStore } from "./webui-auth-store.js";

const SESSION_COOKIE = "bridge_session";
const MAX_BODY_BYTES = 32 * 1024;
const MAX_PERSONA_BODY_BYTES = 1024 * 1024;
const MAX_PERSONA_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_PERSONA_UPLOAD_BODY_BYTES = 28 * 1024 * 1024;

export interface WebUiStatus {
  napCatConnected: boolean;
  codexAvailable: boolean;
  taskRunning: boolean;
  memoryCount: number;
  memoryAvailable: boolean;
  codexUsage?: CodexRateLimitUsage;
}

export interface WebUiServerOptions {
  host: "127.0.0.1" | "0.0.0.0";
  port: number;
  allowPublicAccess?: boolean;
  sessionTtlMs: number;
  pairingTtlMs: number;
  staticRoot: string;
  authStorePath: string;
  logger: Logger;
  agent: AgentAdapter;
  memoryRepository: WebUiMemoryStore;
  allowedWorkspaceRoot?: string;
  autoMemory?: {
    onConversationSwitch(conversationId: string | undefined): Promise<void>;
    onConversationUpdated(conversationId: string): Promise<void>;
  };
  workdir: string;
  taskTimeoutMs: number;
  getStatus: () => Promise<WebUiStatus>;
  getModel?: () => string;
  setModel?: (model: string) => void;
  getReasoningEffort?: () => string;
  setReasoningEffort?: (effort: string) => void;
  getPlugins?: () => PluginInfo[];
  setPluginEnabled?: (id: string, enabled: boolean) => Promise<void>;
  workspaceStore?: BridgeWorkspaceStore;
  decayStore?: MemoryScopeStore;
  vectorIndexer?: { index(relativePath: string, text: string): Promise<void> };
  memoryVectorStore?: {
    removeMany(ids: ReadonlyArray<string>): Promise<void>;
    snapshot?(): Promise<(id: string) => { vector: number[] } | undefined>;
  };
  emotionPrimer?: { emotionsOf(vector: ReadonlyArray<number> | undefined): string[] };
  personaDocumentExtractorScriptPath?: string;
  softwareUpdate?: SoftwareUpdateController;
  systemControl?: BridgeSystemController;
  autoTrustLoopback?: boolean;
}

/** 记忆侧车里 webui 需要的窗口归属能力（由 MemoryDecayStore 实现）。 */
export interface MemoryScopeStore {
  snapshot(): Promise<(id: string) => { conversationId?: string } | undefined>;
  pathsForConversation(conversationId: string): Promise<string[]>;
  removeMany(ids: ReadonlyArray<string>): Promise<void>;
}

export interface WebUiMemoryStore {
  list(): Promise<MemoryListEntry[]>;
  add(candidate: MemoryCandidate): Promise<MemoryMutationResult>;
  remove(entry: MemoryListEntry): Promise<MemoryMutationResult>;
  update?(entry: MemoryListEntry, newSummary: string, newForgetCondition?: string): Promise<MemoryMutationResult>;
  sync(): Promise<MemorySyncResult>;
  readApprovedMemories(): Promise<ReadonlyArray<ApprovedMemoryEntry>>;
  getRoot?(): string;
  switchRoot?(root: string): Promise<void>;
}

class WebUiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly publicMessage: string,
  ) {
    super(publicMessage);
  }
}

interface WebUiSession {
  expiresAt: number;
  localAdmin: boolean;
  memoryDrafts: MemoryDraftManager;
  pendingHighRisk?: {
    prompt: string;
    useMemory: boolean;
    expiresAt: number;
    conversationId?: string;
  };
}

interface PairingAttempt {
  count: number;
  windowStartedAt: number;
  blockedUntil: number;
}

export class WebUiServer {
  private readonly server = createServer((request, response) => {
    void this.handle(request, response).catch((error) => {
      this.options.logger.error(
        { errorType: error instanceof Error ? error.name : "unknown" },
        "Contained WebUI request error",
      );
      if (!response.headersSent) {
        const mapped = mapRequestError(error);
        this.sendJson(response, mapped.status, { error: mapped.message });
      }
      else response.end();
    });
  });
  private readonly sessions = new Map<string, WebUiSession>();
  private readonly loginAttempts = new Map<string, PairingAttempt>();
  private readonly authStore: WebUiAuthStore;

  constructor(private readonly options: WebUiServerOptions) {
    this.authStore = new WebUiAuthStore(options.authStorePath);
  }

  async start(): Promise<void> {
    await this.authStore.load();
    await new Promise<void>((resolvePromise, reject) => {
      this.server.once("error", reject);
      this.server.listen(this.options.port, this.options.host, () => {
        this.server.off("error", reject);
        resolvePromise();
      });
    });
    this.options.logger.info(
      {
        host: this.options.host,
        port: this.address().port,
        lanAddressCount: this.lanUrls().length,
        publicAccessEnabled: this.options.allowPublicAccess === true,
      },
      "WebUI is listening with local administration and persistent remote auth",
    );
  }

  async stop(): Promise<void> {
    this.sessions.clear();
    await new Promise<void>((resolvePromise, reject) => {
      this.server.close((error) => (error ? reject(error) : resolvePromise()));
    });
  }

  address(): { host: string; port: number } {
    const address = this.server.address();
    return {
      host: this.options.host,
      port: typeof address === "object" && address ? address.port : this.options.port,
    };
  }

  lanUrls(): string[] {
    if (this.options.host === "127.0.0.1") return [];
    const port = this.address().port;
    const urls = new Set<string>();
    for (const entries of Object.values(networkInterfaces())) {
      for (const entry of entries ?? []) {
        if (entry.family !== "IPv4" || entry.internal || !isPrivateAddress(entry.address)) {
          continue;
        }
        urls.add(`http://${entry.address}:${port}`);
      }
    }
    return [...urls];
  }

  private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    this.setSecurityHeaders(response);
    const remoteAddress = normalizeAddress(request.socket.remoteAddress ?? "");
    if (!isWebUiRemoteAddressAllowed(remoteAddress, this.options.allowPublicAccess === true)) {
      this.sendJson(response, 403, { error: "只允许本机、局域网或私有 Tailscale 网络访问。" });
      return;
    }

    const url = new URL(request.url ?? "/", "http://bridge.local");
    if (request.method === "GET" && isStaticPath(url.pathname)) {
      await this.sendStatic(url.pathname, response);
      return;
    }
    if (request.method === "GET" && url.pathname === "/favicon.ico") {
      response.writeHead(204);
      response.end();
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/bootstrap") {
      await this.handleBootstrap(request, response, remoteAddress);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/login") {
      if (!this.validOrigin(request)) {
        this.sendJson(response, 403, { error: "请求来源不匹配。" });
        return;
      }
      await this.handleLogin(request, response, remoteAddress);
      return;
    }

    const session = this.getSession(request);
    if (!session) {
      this.sendJson(response, 401, { error: "设备尚未配对。" });
      return;
    }
    if (request.method === "POST" && !this.validOrigin(request)) {
      this.sendJson(response, 403, { error: "请求来源不匹配。" });
      return;
    }

    if (request.method === "GET" && url.pathname === "/api/models") {
      try {
        const raw = await readFile(join(homedir(), ".codex", "models_cache.json"), "utf8");
        const cache = JSON.parse(raw) as {
          models?: Array<{
            slug: string;
            display_name: string;
            visibility: string;
            default_reasoning_level?: string;
            supported_reasoning_levels?: Array<{ effort: string; description: string }>;
          }>;
        };
        const models = (cache.models ?? [])
          .filter((m) => m.visibility === "list")
          .map((m) => ({
            slug: m.slug,
            displayName: m.display_name,
            defaultReasoningLevel: m.default_reasoning_level,
            supportedReasoningLevels: (m.supported_reasoning_levels ?? []).map(
              (r: { effort: string; description: string }) => ({ effort: r.effort, description: r.description }),
            ),
          }));
        this.sendJson(response, 200, { models });
      } catch {
        this.sendJson(response, 200, { models: [] });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/plugins") {
      const plugins = this.options.getPlugins?.() ?? [];
      this.sendJson(response, 200, { plugins });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/status") {
      const status = await this.options.getStatus();
      this.sendJson(response, 200, {
        ...status,
        webUiOnline: true,
        mobileAccess: this.options.host === "0.0.0.0",
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/settings") {
      const memorySettings = this.options.workspaceStore
        ? await this.options.workspaceStore.memorySettings()
        : undefined;
      const messageBufferSettings = this.options.workspaceStore
        ? await this.options.workspaceStore.messageBufferSettings()
        : undefined;
      this.sendJson(response, 200, {
        localAdmin: session.localAdmin,
        passwordConfigured: this.authStore.isPasswordConfigured(),
        trustedDeviceCount: this.authStore.sessionCount(),
        model: this.options.getModel?.(),
        reasoningEffort: this.options.getReasoningEffort?.(),
        messageBuffer: messageBufferSettings,
        memory: memorySettings
          ? {
              ...memorySettings,
              memoryDirectory:
                this.options.memoryRepository.getRoot?.() ?? memorySettings.memoryDirectory,
            }
          : undefined,
      });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/update/status") {
      if (!this.options.softwareUpdate) {
        this.sendJson(response, 503, { error: "当前运行包没有启用软件更新服务。" });
        return;
      }
      const force = url.searchParams.get("force") === "1";
      const status = await this.options.softwareUpdate.status(force);
      const lastRun = await this.options.softwareUpdate.localStatus();
      this.sendJson(response, 200, { ...status, lastRun });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/update/apply") {
      if (!this.options.softwareUpdate) {
        this.sendJson(response, 503, { error: "当前运行包没有启用软件更新服务。" });
        return;
      }
      try {
        const result = await this.options.softwareUpdate.startUpdate();
        this.sendJson(response, 202, result);
      } catch (error) {
        this.sendJson(response, 409, {
          error: error instanceof Error ? error.message : "更新程序未能启动。",
        });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/system/restart") {
      if (!this.options.systemControl) {
        this.sendJson(response, 503, { error: "当前运行包没有启用一键重启服务。" });
        return;
      }
      try {
        this.sendJson(response, 202, await this.options.systemControl.restart());
      } catch (error) {
        this.sendJson(response, 409, {
          error: error instanceof Error ? error.message : "重启程序未能启动。",
        });
      }
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/workspace") {
      if (!this.options.workspaceStore) {
        this.sendJson(response, 503, { error: "本地对话工作区尚未启用。" });
        return;
      }
      this.sendJson(response, 200, await this.options.workspaceStore.snapshot());
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/save") {
      const store = this.requireWorkspaceStore();
      const body = await readJson(request, MAX_PERSONA_BODY_BYTES);
      const id = typeof body.id === "string" ? body.id : undefined;
      const category = typeof body.category === "string" ? body.category.trim() : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const content = typeof body.content === "string" ? body.content.trim() : "";
      const recallStyle = isRecallStyle(body.recallStyle) ? body.recallStyle : undefined;
      if (!category || !name || name.length > 80 || content.length > 200_000) {
        this.sendJson(response, 400, { error: "请填写分类和名称；核心设定内容过长时请拆成文档上传。" });
        return;
      }
      if (this.rejectSensitiveText(response, `${name}\n${content}`)) return;
      const persona = await store.savePersona({ id, category, name, content, recallStyle });
      this.sendJson(response, 200, { persona });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/documents/upload") {
      const body = await readJson(request, MAX_PERSONA_UPLOAD_BODY_BYTES);
      const personaId = typeof body.personaId === "string" ? body.personaId : "";
      const name = typeof body.name === "string" ? body.name.trim() : "";
      const dataBase64 = typeof body.dataBase64 === "string" ? body.dataBase64 : "";
      if (!personaId || !name || name.length > 180 || !dataBase64) {
        this.sendJson(response, 400, { error: "人设文档参数不完整。" });
        return;
      }
      const extension = name.includes(".") ? `.${name.split(".").pop()?.toLowerCase()}` : "";
      if (!PERSONA_DOCUMENT_EXTENSIONS.includes(extension)) {
        this.sendJson(response, 415, {
          error: "暂不支持这种文档格式。请使用 TXT、Markdown、JSON、YAML、CSV、HTML、DOCX 或 PDF。",
        });
        return;
      }
      const bytes = Buffer.from(dataBase64, "base64");
      if (!bytes.length || bytes.length > MAX_PERSONA_DOCUMENT_BYTES) {
        this.sendJson(response, 413, { error: "单份文档需要小于 20 MB。" });
        return;
      }
      let text: string;
      try {
        text = await extractPersonaDocument(
          name,
          bytes,
          this.options.personaDocumentExtractorScriptPath ?? "scripts/extract-persona-document.py",
        );
      } catch (error) {
        this.options.logger.warn(
          { fileType: extension, errorType: error instanceof Error ? error.name : "unknown" },
          "Persona document extraction failed without persistence",
        );
        this.sendJson(response, 422, { error: "文档无法读取或没有可提取的文字，本次没有保存。" });
        return;
      }
      if (!text) {
        this.sendJson(response, 422, { error: "文档中没有可提取的文字，本次没有保存。" });
        return;
      }
      if (this.rejectSensitiveText(response, text)) return;
      const document = await this.requireWorkspaceStore().addPersonaDocument(personaId, {
        name,
        sourceSizeBytes: bytes.length,
        text,
      });
      this.sendJson(response, 200, { document });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/documents/read") {
      const body = await readJson(request);
      const personaId = typeof body.personaId === "string" ? body.personaId : "";
      const documentId = typeof body.documentId === "string" ? body.documentId : "";
      if (!personaId || !documentId) {
        this.sendJson(response, 400, { error: "人设文档编号无效。" });
        return;
      }
      const result = await this.requireWorkspaceStore().readPersonaDocument(personaId, documentId);
      this.sendJson(response, 200, result);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/documents/update") {
      const body = await readJson(request, MAX_PERSONA_UPLOAD_BODY_BYTES);
      const personaId = typeof body.personaId === "string" ? body.personaId : "";
      const documentId = typeof body.documentId === "string" ? body.documentId : "";
      const text = typeof body.text === "string" ? body.text.trim() : "";
      if (!personaId || !documentId) {
        this.sendJson(response, 400, { error: "人设文档编号无效。" });
        return;
      }
      if (!text) {
        this.sendJson(response, 400, { error: "人设文档内容不能为空。" });
        return;
      }
      if (Buffer.byteLength(text, "utf8") > MAX_PERSONA_DOCUMENT_BYTES) {
        this.sendJson(response, 413, { error: "单份人设文档需要小于 20 MB。" });
        return;
      }
      const document = await this.requireWorkspaceStore().updatePersonaDocument(
        personaId,
        documentId,
        text,
      );
      this.sendJson(response, 200, { document });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/documents/delete") {
      const body = await readJson(request);
      const personaId = typeof body.personaId === "string" ? body.personaId : "";
      const documentId = typeof body.documentId === "string" ? body.documentId : "";
      if (!personaId || !documentId) {
        this.sendJson(response, 400, { error: "人设文档编号无效。" });
        return;
      }
      await this.requireWorkspaceStore().deletePersonaDocument(personaId, documentId);
      this.sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/select") {
      const body = await readJson(request);
      const id = typeof body.id === "string" && body.id ? body.id : null;
      await this.requireWorkspaceStore().selectPersona(id);
      this.sendJson(response, 200, { selected: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/personas/delete") {
      const body = await readJson(request);
      if (typeof body.id !== "string" || !body.id) {
        this.sendJson(response, 400, { error: "人设编号无效。" });
        return;
      }
      await this.requireWorkspaceStore().deletePersona(body.id);
      this.sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/conversations/create") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (name.length > 100 || (name && this.rejectSensitiveText(response, name))) return;
      const previous = await this.requireWorkspaceStore().activeConversation();
      const conversation = await this.requireWorkspaceStore().createConversation(name || undefined);
      this.sendJson(response, 200, { conversation });
      void this.options.autoMemory?.onConversationSwitch(previous?.id);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/conversations/select") {
      const body = await readJson(request);
      if (typeof body.id !== "string" || !body.id) {
        this.sendJson(response, 400, { error: "对话编号无效。" });
        return;
      }
      const previous = await this.requireWorkspaceStore().activeConversation();
      await this.requireWorkspaceStore().selectConversation(body.id);
      this.sendJson(response, 200, { selected: true });
      if (previous?.id !== body.id) void this.options.autoMemory?.onConversationSwitch(previous?.id);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/conversations/rename") {
      const body = await readJson(request);
      const name = typeof body.name === "string" ? body.name.trim() : "";
      if (typeof body.id !== "string" || !body.id || !name || name.length > 100) {
        this.sendJson(response, 400, { error: "对话名称需为 1 至 100 个字符。" });
        return;
      }
      if (this.rejectSensitiveText(response, name)) return;
      await this.requireWorkspaceStore().renameConversation(body.id, name);
      this.sendJson(response, 200, { renamed: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/conversations/delete") {
      const body = await readJson(request);
      if (typeof body.id !== "string" || !body.id) {
        this.sendJson(response, 400, { error: "对话编号无效。" });
        return;
      }
      await this.deleteConversationMemories(body.id);
      await this.requireWorkspaceStore().deleteConversation(body.id);
      this.sendJson(response, 200, { deleted: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/model") {
      if (!this.options.setModel) {
        this.sendJson(response, 503, { error: "当前运行模式不支持动态修改模型。" });
        return;
      }
      const body = await readJson(request);
      const model = typeof body.model === "string" ? body.model.trim() : "";
      if (!model || model.length > 128) {
        this.sendJson(response, 400, { error: "模型名称无效。" });
        return;
      }
      this.options.setModel(model);
      this.sendJson(response, 200, { updated: true, model });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/reasoning-effort") {
      if (!this.options.setReasoningEffort) {
        this.sendJson(response, 503, { error: "当前运行模式不支持动态修改推理等级。" });
        return;
      }
      const body = await readJson(request);
      const effort = typeof body.effort === "string" ? body.effort.trim() : "";
      if (!["low", "medium", "high", "xhigh"].includes(effort)) {
        this.sendJson(response, 400, { error: "推理等级无效，可选：low、medium、high、xhigh。" });
        return;
      }
      this.options.setReasoningEffort(effort);
      this.sendJson(response, 200, { updated: true, effort });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/plugin") {
      if (!this.options.setPluginEnabled) {
        this.sendJson(response, 503, { error: "当前运行模式不支持插件管理。" });
        return;
      }
      const body = await readJson(request);
      const id = typeof body.id === "string" ? body.id.trim() : "";
      const enabled = body.enabled === true;
      if (!id) {
        this.sendJson(response, 400, { error: "插件编号无效。" });
        return;
      }
      await this.options.setPluginEnabled(id, enabled);
      this.sendJson(response, 200, { updated: true, id, enabled });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/storage") {
      const body = await readJson(request);
      const storageLimitMb = Number(body.storageLimitMb);
      if (!Number.isInteger(storageLimitMb) || storageLimitMb < 50 || storageLimitMb > 102_400) {
        this.sendJson(response, 400, { error: "聊天记录上限需为 50 至 102400 MB 的整数。" });
        return;
      }
      await this.requireWorkspaceStore().updateStorageLimit(storageLimitMb);
      this.sendJson(response, 200, { updated: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/message-buffer") {
      const waitSeconds = Number((await readJson(request)).waitSeconds);
      if (!Number.isInteger(waitSeconds) || waitSeconds < 0 || waitSeconds > 120) {
        this.sendJson(response, 400, { error: "消息合并等待时间需要是 0 到 120 秒的整数。" });
        return;
      }
      await this.requireWorkspaceStore().updateMessageBufferSettings({ waitSeconds });
      this.sendJson(response, 200, { updated: true, waitSeconds });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/memory") {
      const store = this.requireWorkspaceStore();
      const body = await readJson(request);
      const mode = body.mode === "manual" ? "manual" : body.mode === "automatic" ? "automatic" : "";
      const onConversationSwitch = body.onConversationSwitch === true;
      const onTokenThreshold = body.onTokenThreshold === true;
      const tokenThreshold = Number(body.tokenThreshold);
      const onSchedule = body.onSchedule === true;
      const timezone = typeof body.timezone === "string" ? body.timezone.trim() : "";
      const time = typeof body.time === "string" ? body.time.trim() : "";
      const memoryDirectory =
        typeof body.memoryDirectory === "string" ? resolve(body.memoryDirectory.trim()) : "";
      if (
        !mode ||
        !Number.isInteger(tokenThreshold) ||
        tokenThreshold < 1_000 ||
        tokenThreshold > 1_000_000 ||
        !isValidTimeZoneSetting(timezone) ||
        !/^([01]\d|2[0-3]):[0-5]\d$/u.test(time) ||
        !memoryDirectory
      ) {
        this.sendJson(response, 400, { error: "请检查自动记忆模式、Token 阈值、时区、时间点和记忆目录。" });
        return;
      }
      const currentDirectory = this.options.memoryRepository.getRoot?.() ?? memoryDirectory;
      if (memoryDirectory !== resolve(currentDirectory)) {
        if (
          !this.options.allowedWorkspaceRoot ||
          !isPathInside(this.options.allowedWorkspaceRoot, memoryDirectory)
        ) {
          this.sendJson(response, 400, { error: "记忆目录必须位于 Bridge 私有工作区内。" });
          return;
        }
        if (!this.options.memoryRepository.switchRoot) {
          this.sendJson(response, 503, { error: "当前记忆库不支持运行时切换目录。" });
          return;
        }
        try {
          await this.options.memoryRepository.switchRoot(memoryDirectory);
        } catch {
          this.sendJson(response, 400, {
            error: "这个目录不是可用的私人记忆库；请填写包含现有 memory-repo 的目录。",
          });
          return;
        }
        await store.updateMemoryDirectory(memoryDirectory);
      }
      await store.updateMemorySettings({
        mode,
        onConversationSwitch,
        onTokenThreshold,
        tokenThreshold,
        onSchedule,
        timezone,
        time,
      });
      this.sendJson(response, 200, {
        updated: true,
        memoryDirectory: this.options.memoryRepository.getRoot?.() ?? memoryDirectory,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/password") {
      const body = await readJson(request);
      const currentPassword =
        typeof body.currentPassword === "string" ? body.currentPassword : "";
      const password = typeof body.password === "string" ? body.password : "";
      if (
        !session.localAdmin &&
        (!currentPassword || !(await this.authStore.verifyPassword(currentPassword)))
      ) {
        this.sendJson(response, 401, { error: "当前管理密码不正确。" });
        return;
      }
      if (password.length < 12 || password.length > 256) {
        this.sendJson(response, 400, { error: "新密码需为 12 至 256 个字符，请使用只在这里使用的长密码。" });
        return;
      }
      await this.authStore.setPassword(password);
      this.revokeRemoteRuntimeSessions();
      if (!session.localAdmin) {
        const created = this.createSession(false);
        await this.authStore.addSession(hashToken(created.token), created.session.expiresAt);
        this.setSessionCookie(response, created.token, request);
      }
      this.sendJson(response, 200, {
        updated: true,
        remoteSessionsRevoked: true,
        currentDeviceKept: !session.localAdmin,
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/settings/revoke") {
      await this.authStore.revokeSessions();
      this.revokeRemoteRuntimeSessions();
      this.sendJson(response, 200, { revoked: true });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memories") {
      const conversationId = await this.resolveConversationId(url.searchParams.get("conversationId"));
      const entries = await this.scopedMemories(conversationId);
      const vectorLookup =
        this.options.emotionPrimer && this.options.memoryVectorStore?.snapshot
          ? await this.options.memoryVectorStore.snapshot()
          : undefined;
      const mapped = entries.map((entry, index) => ({
        index: index + 1,
        title: entry.title,
        category: entry.category,
        summary: entry.summary,
        updatedAt: entry.updatedAt,
        fuzzyDate: fuzzyMemoryDate(entry.updatedAt),
        emotions:
          this.options.emotionPrimer && vectorLookup
            ? this.options.emotionPrimer.emotionsOf(vectorLookup(entry.relativePath)?.vector)
            : [],
      }));
      this.sendJson(response, 200, { entries: mapped, conversationId });
      return;
    }
    if (request.method === "GET" && url.pathname === "/api/memory/permanent") {
      const conversationId = await this.resolveConversationId(url.searchParams.get("conversationId"));
      const text = conversationId
        ? await this.requireWorkspaceStore().conversationPermanentMemory(conversationId)
        : "";
      this.sendJson(response, 200, { text, conversationId });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/permanent") {
      const body = await readJson(request);
      const conversationId = await this.resolveConversationId(
        typeof body.conversationId === "string" ? body.conversationId : null,
      );
      if (!conversationId) {
        this.sendJson(response, 400, { error: "请先选择一个对话窗口。" });
        return;
      }
      const text = typeof body.text === "string" ? body.text : "";
      if (text.length > 8_000) {
        this.sendJson(response, 400, { error: "永久记忆过长（上限 8000 字）。" });
        return;
      }
      if (text.trim() && classifySensitiveContent(text).blocked) {
        this.sendJson(response, 400, { error: "内容包含敏感信息，未保存。" });
        return;
      }
      await this.requireWorkspaceStore().updateConversationPermanentMemory(conversationId, text);
      this.sendJson(response, 200, { updated: true });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/update") {
      if (!this.options.memoryRepository.update) {
        this.sendJson(response, 503, { error: "当前运行模式不支持编辑记忆。" });
        return;
      }
      const body = await readJson(request);
      const conversationId = await this.resolveConversationId(
        typeof body.conversationId === "string" ? body.conversationId : null,
      );
      const index = Number(body.index);
      const text = typeof body.text === "string" ? body.text.trim() : "";
      const entries = await this.scopedMemories(conversationId);
      const entry = Number.isInteger(index) ? entries[index - 1] : undefined;
      if (!entry) {
        this.sendJson(response, 400, { error: "记忆编号无效。" });
        return;
      }
      if (text.length < 2 || text.length > 1_000) {
        this.sendJson(response, 400, { error: "记忆内容长度需在 2 至 1000 字之间。" });
        return;
      }
      try {
        const result = await this.options.memoryRepository.update(entry, text);
        await this.options.vectorIndexer?.index(entry.relativePath, `${entry.title} ${text}`);
        this.sendJson(response, 200, { synced: result.synced });
      } catch (error) {
        const message =
          error instanceof MemoryRepositoryError && error.code === "unsafe"
            ? "内容包含敏感信息，未保存。"
            : error instanceof MemoryRepositoryError && error.code === "dirty"
              ? "记忆库有未提交改动，请稍后再试。"
              : "记忆更新失败。";
        this.sendJson(response, 400, { error: message });
      }
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat") {
      await this.handleChat(request, response, session, false);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/chat/confirm") {
      const pending = session.pendingHighRisk;
      session.pendingHighRisk = undefined;
      if (!pending || pending.expiresAt <= Date.now()) {
        this.sendJson(response, 409, { error: "待确认任务已超时或不存在。" });
        return;
      }
      await this.runTask(
        response,
        pending.prompt,
        pending.useMemory,
        true,
        pending.conversationId,
      );
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/cancel") {
      session.pendingHighRisk = undefined;
      const draftCancelled = session.memoryDrafts.cancel();
      const taskCancelled = await this.options.agent.cancel();
      this.sendJson(response, 200, { taskCancelled, draftCancelled });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/draft") {
      await this.handleMemoryDraft(request, response, session);
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/confirm") {
      const candidate = session.memoryDrafts.getRemember();
      if (!candidate) {
        this.sendJson(response, 409, { error: "没有待确认的记忆。" });
        return;
      }
      const result = await this.options.memoryRepository.add(candidate);
      if (result.relativePath) {
        await this.options.vectorIndexer?.index(result.relativePath, `${candidate.title} ${candidate.summary}`);
      }
      session.memoryDrafts.clear();
      this.sendJson(response, 200, { synced: result.synced });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/forget") {
      const body = await readJson(request);
      const conversationId = await this.resolveConversationId(
        typeof body.conversationId === "string" ? body.conversationId : null,
      );
      const index = Number(body.index);
      const entries = await this.scopedMemories(conversationId);
      const entry = Number.isInteger(index) ? entries[index - 1] : undefined;
      if (!entry) {
        this.sendJson(response, 400, { error: "记忆编号无效。" });
        return;
      }
      session.memoryDrafts.stageForget(entry);
      this.sendJson(response, 200, {
        preview: { title: entry.title, category: entry.category },
      });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/forget/confirm") {
      const entry = session.memoryDrafts.getForget();
      if (!entry) {
        this.sendJson(response, 409, { error: "没有待确认的遗忘操作。" });
        return;
      }
      const result = await this.options.memoryRepository.remove(entry);
      await this.options.decayStore?.removeMany([entry.relativePath]);
      await this.options.memoryVectorStore?.removeMany([entry.relativePath]);
      session.memoryDrafts.clear();
      this.sendJson(response, 200, { synced: result.synced });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/cancel") {
      this.sendJson(response, 200, { cancelled: session.memoryDrafts.cancel() });
      return;
    }
    if (request.method === "POST" && url.pathname === "/api/memory/sync") {
      const result = await this.options.memoryRepository.sync();
      this.sendJson(response, 200, result);
      return;
    }

    this.sendJson(response, 404, { error: "页面或接口不存在。" });
  }

  private async handleBootstrap(
    request: IncomingMessage,
    response: ServerResponse,
    remoteAddress: string,
  ): Promise<void> {
    const loopback = isLocalAdminRequest(request, remoteAddress);
    let session = this.getSession(request);
    if (!session && loopback && this.options.autoTrustLoopback !== false) {
      const created = this.createSession(true);
      session = created.session;
      this.setSessionCookie(response, created.token);
    }
    this.sendJson(response, 200, {
      authenticated: Boolean(session),
      localDevice: loopback,
      lanUrls: loopback ? this.lanUrls() : undefined,
      passwordConfigured: this.authStore.isPasswordConfigured(),
      sessionExpiresAt: session?.expiresAt,
    });
  }

  private async handleLogin(
    request: IncomingMessage,
    response: ServerResponse,
    remoteAddress: string,
  ): Promise<void> {
    const attempt = this.loginAttempts.get(remoteAddress);
    if (attempt?.blockedUntil && attempt.blockedUntil > Date.now()) {
      this.sendJson(response, 429, { error: "尝试次数过多，请稍后再试。" });
      return;
    }
    const body = await readJson(request);
    if (!this.authStore.isPasswordConfigured()) {
      this.sendJson(response, 503, { error: "请先在桥接主机的本地设置页创建远程访问密码。" });
      return;
    }
    const password = typeof body.password === "string" ? body.password : "";
    if (!password || !(await this.authStore.verifyPassword(password))) {
      this.recordLoginFailure(remoteAddress);
      this.sendJson(response, 401, { error: "密码不正确。" });
      return;
    }

    this.loginAttempts.delete(remoteAddress);
    const created = this.createSession(false);
    await this.authStore.addSession(hashToken(created.token), created.session.expiresAt);
    this.setSessionCookie(response, created.token, request);
    this.sendJson(response, 200, {
      authenticated: true,
      sessionExpiresAt: created.session.expiresAt,
    });
  }

  private async handleChat(
    request: IncomingMessage,
    response: ServerResponse,
    session: WebUiSession,
    confirmedHighRisk: boolean,
  ): Promise<void> {
    const body = await readJson(request);
    const message = typeof body.message === "string" ? body.message.trim() : "";
    if (!message || message.length > 4_000) {
      this.sendJson(response, 400, { error: "消息长度必须在 1 到 4000 字之间。" });
      return;
    }
    const useMemory = body.useMemory !== false;
    const sensitive = classifySensitiveContent(message);
    if (sensitive.blocked && sensitive.category) {
      this.sendJson(response, 422, {
        type: "sensitive-blocked",
        facts: createSensitiveNoticeFacts(sensitive.category),
      });
      return;
    }
    if (this.options.workspaceStore && await this.options.workspaceStore.isCapacityFull()) {
      this.sendJson(response, 507, {
        error: "聊天记录已达到设定上限。请先清理旧窗口，或在设置里提高容量后再继续。",
      });
      return;
    }
    const conversationId = this.options.workspaceStore
      ? await this.options.workspaceStore.appendMessage("user", message)
      : undefined;
    if (!confirmedHighRisk && requiresConfirmation(message)) {
      session.pendingHighRisk = {
        prompt: message,
        useMemory,
        expiresAt: Date.now() + 60_000,
        conversationId,
      };
      this.sendJson(response, 202, {
        type: "confirmation-required",
        expiresInSeconds: 60,
      });
      return;
    }
    await this.runTask(response, message, useMemory, confirmedHighRisk, conversationId);
  }

  private async runTask(
    response: ServerResponse,
    message: string,
    useMemory: boolean,
    confirmedHighRisk: boolean,
    conversationId?: string,
  ): Promise<void> {
    let prompt = message;
    let selectedMemoryCount = 0;
    if (useMemory) {
      try {
        const approved = await this.options.memoryRepository.readApprovedMemories();
        const selected = selectRelevantMemories(message, approved);
        selectedMemoryCount = selected.length;
        prompt = buildMemoryAugmentedPrompt(message, selected);
      } catch (error) {
        this.options.logger.warn(
          {
            source: "webui",
            memoryStatus:
              error instanceof MemoryRepositoryError ? error.code : "unknown",
          },
          "WebUI task is continuing without memory context",
        );
      }
    }

    if (conversationId && this.options.workspaceStore) {
      const context = await this.options.workspaceStore.promptContext(conversationId);
      if (context) prompt = `${context}\n\n当前任务：\n${prompt}`;
    }

    const result = await this.options.agent.run({
      prompt,
      workdir: this.options.workdir,
      timeoutMs: this.options.taskTimeoutMs,
    });
    const reply = result.ok
      ? confirmedHighRisk
        ? guardConfirmedHighRiskOutput(result.output)
        : result.output
      : formatAgentFailure(result.error);
    this.options.logger.info(
      { source: "webui", ok: result.ok, useMemory, selectedMemoryCount },
      "WebUI task reply prepared",
    );
    if (conversationId && this.options.workspaceStore) {
      await this.options.workspaceStore.appendMessage("assistant", reply, conversationId);
      void this.options.autoMemory?.onConversationUpdated(conversationId);
    }
    this.sendJson(response, result.ok ? 200 : 502, { type: "reply", text: reply });
  }

  private requireWorkspaceStore(): BridgeWorkspaceStore {
    if (!this.options.workspaceStore) {
      throw new WebUiRequestError(503, "本地对话工作区尚未启用。");
    }
    return this.options.workspaceStore;
  }

  private async resolveConversationId(explicit?: string | null): Promise<string | undefined> {
    if (explicit) return explicit;
    const active = await this.options.workspaceStore?.activeConversation();
    return active?.id ?? undefined;
  }

  /** 本窗口名下的非永久记忆（含无归属遗留），按最老在前排序；index = 位置+1。 */
  private async scopedMemories(conversationId: string | undefined): Promise<ApprovedMemoryEntry[]> {
    const all = await this.options.memoryRepository.readApprovedMemories();
    const snapshot = this.options.decayStore ? await this.options.decayStore.snapshot() : undefined;
    return all
      .filter((memory) => {
        const owner = snapshot?.(memory.relativePath)?.conversationId;
        return !owner || owner === conversationId;
      })
      .slice()
      .sort(
        (left, right) =>
          left.updatedAt.localeCompare(right.updatedAt) ||
          left.relativePath.localeCompare(right.relativePath),
      );
  }

  /** 删窗口前清掉它名下的非永久记忆 + 侧车项。 */
  private async deleteConversationMemories(conversationId: string): Promise<void> {
    if (!this.options.decayStore) return;
    const paths = new Set(await this.options.decayStore.pathsForConversation(conversationId));
    if (paths.size === 0) return;
    const all = await this.options.memoryRepository.list();
    for (const entry of all) {
      if (!paths.has(entry.relativePath)) continue;
      try {
        await this.options.memoryRepository.remove(entry);
      } catch {
        /* 单条删除失败不阻断整窗口删除 */
      }
    }
    await this.options.decayStore.removeMany([...paths]);
    await this.options.memoryVectorStore?.removeMany([...paths]);
  }

  private rejectSensitiveText(response: ServerResponse, text: string): boolean {
    const sensitive = classifySensitiveContent(text);
    if (!sensitive.blocked || !sensitive.category) return false;
    this.sendJson(response, 422, {
      type: "sensitive-blocked",
      facts: createSensitiveNoticeFacts(sensitive.category),
    });
    return true;
  }

  private async handleMemoryDraft(
    request: IncomingMessage,
    response: ServerResponse,
    session: WebUiSession,
  ): Promise<void> {
    const body = await readJson(request);
    const content = typeof body.content === "string" ? body.content.trim() : "";
    const sensitive = classifySensitiveContent(content);
    if (sensitive.blocked && sensitive.category) {
      this.sendJson(response, 422, {
        type: "sensitive-blocked",
        facts: createSensitiveNoticeFacts(sensitive.category),
      });
      return;
    }
    try {
      const candidate = buildMemoryCandidate(content);
      session.memoryDrafts.stageRemember(candidate);
      this.sendJson(response, 200, { preview: candidate });
    } catch (error) {
      this.sendJson(response, 400, {
        error:
          error instanceof UnsafeMemoryContentError
            ? "内容疑似包含账号或私密标识，未生成记忆。"
            : "记忆内容必须在 2 到 500 字之间。",
      });
    }
  }

  private getSession(request: IncomingMessage): WebUiSession | undefined {
    this.cleanupSessions();
    const cookies = parseCookies(request.headers.cookie ?? "");
    const token = cookies[SESSION_COOKIE];
    if (!token) return undefined;
    const hash = hashToken(token);
    let session = this.sessions.get(hash);
    if (!session && this.authStore.hasSession(hash)) {
      session = {
        expiresAt: Date.now() + this.options.sessionTtlMs,
        localAdmin: false,
        memoryDrafts: new MemoryDraftManager(),
      };
      this.sessions.set(hash, session);
    }
    if (!session || session.expiresAt <= Date.now()) return undefined;
    return session;
  }

  private createSession(localAdmin: boolean): { token: string; session: WebUiSession } {
    const token = randomBytes(32).toString("base64url");
    const session: WebUiSession = {
      expiresAt: Date.now() + this.options.sessionTtlMs,
      localAdmin,
      memoryDrafts: new MemoryDraftManager(),
    };
    this.sessions.set(hashToken(token), session);
    return { token, session };
  }

  private setSessionCookie(response: ServerResponse, token: string, request?: IncomingMessage): void {
    const secure = request && isHttpsRequest(request) ? "; Secure" : "";
    response.setHeader(
      "Set-Cookie",
      `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(
        this.options.sessionTtlMs / 1_000,
      )}${secure}`,
    );
  }

  private recordLoginFailure(remoteAddress: string): void {
    const now = Date.now();
    const previous = this.loginAttempts.get(remoteAddress);
    const current =
      previous && now - previous.windowStartedAt < 10 * 60_000
        ? previous
        : { count: 0, windowStartedAt: now, blockedUntil: 0 };
    current.count += 1;
    if (current.count >= 5) current.blockedUntil = now + 15 * 60_000;
    this.loginAttempts.set(remoteAddress, current);
  }

  private revokeRemoteRuntimeSessions(): void {
    for (const [hash, session] of this.sessions) {
      if (!session.localAdmin) this.sessions.delete(hash);
    }
  }

  private cleanupSessions(): void {
    const now = Date.now();
    for (const [key, session] of this.sessions) {
      if (session.expiresAt <= now) this.sessions.delete(key);
    }
  }

  private validOrigin(request: IncomingMessage): boolean {
    const origin = request.headers.origin;
    const host = request.headers.host;
    if (!origin || !host) return false;
    try {
      const parsed = new URL(origin);
      return ["http:", "https:"].includes(parsed.protocol) && parsed.host === host;
    } catch {
      return false;
    }
  }

  private setSecurityHeaders(response: ServerResponse): void {
    response.setHeader(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'",
    );
    response.setHeader("X-Frame-Options", "DENY");
    response.setHeader("X-Content-Type-Options", "nosniff");
    response.setHeader("Referrer-Policy", "no-referrer");
    response.setHeader(
      "Permissions-Policy",
      "camera=(), microphone=(), geolocation=(), payment=(), usb=()",
    );
    response.setHeader("Cache-Control", "no-store");
  }

  private async sendStatic(pathname: string, response: ServerResponse): Promise<void> {
    const fileName =
      pathname === "/" || pathname === "/index.html"
        ? "index.html"
        : pathname === "/app.js"
          ? "app.js"
          : "styles.css";
    const content = await readFile(join(this.options.staticRoot, fileName));
    const contentType =
      fileName.endsWith(".html")
        ? "text/html; charset=utf-8"
        : fileName.endsWith(".js")
          ? "text/javascript; charset=utf-8"
          : "text/css; charset=utf-8";
    response.writeHead(200, { "Content-Type": contentType });
    response.end(content);
  }

  private sendJson(response: ServerResponse, status: number, value: unknown): void {
    response.writeHead(status, { "Content-Type": "application/json; charset=utf-8" });
    response.end(JSON.stringify(value));
  }
}

async function readJson(
  request: IncomingMessage,
  maxBodyBytes = MAX_BODY_BYTES,
): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > maxBodyBytes) {
      throw new WebUiRequestError(413, "内容太长，未进行处理。");
    }
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
  } catch {
    throw new WebUiRequestError(400, "请求格式不正确。");
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new WebUiRequestError(400, "请求格式不正确。");
  }
  return parsed as Record<string, unknown>;
}

function mapRequestError(error: unknown): { status: number; message: string } {
  if (error instanceof WebUiRequestError) {
    return { status: error.status, message: error.publicMessage };
  }
  if (error instanceof MemoryRepositoryError) {
    if (error.code === "dirty" || error.code === "conflict") {
      return { status: 409, message: "记忆库存在尚未处理的本地改动或同步冲突，本次操作已停止。" };
    }
    if (error.code === "unsafe" || error.code === "invalid") {
      return { status: 422, message: "记忆内容未通过安全复检，本次没有写入。" };
    }
    return { status: 503, message: "私有记忆库暂时不可用，现有内容未被改动。" };
  }
  return { status: 500, message: "请求处理失败。" };
}

function isPathInside(root: string, target: string): boolean {
  const candidate = relative(resolve(root), resolve(target));
  return (
    candidate === "" ||
    (!candidate.startsWith(`..${sep}`) && candidate !== ".." && !isAbsolute(candidate))
  );
}

function isValidTimeZoneSetting(value: string): boolean {
  if (/^UTC(?:[+-](?:\d|1[0-4])(?::[0-5]\d)?)?$/u.test(value)) return true;
  try {
    new Intl.DateTimeFormat("zh-CN", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function isStaticPath(pathname: string): boolean {
  return ["/", "/index.html", "/app.js", "/styles.css"].includes(pathname);
}

function parseCookies(header: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 1) continue;
    result[part.slice(0, separator).trim()] = part.slice(separator + 1).trim();
  }
  return result;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function normalizeAddress(address: string): string {
  return address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
}

function isLoopback(address: string): boolean {
  return address === "127.0.0.1" || address === "::1";
}

function isPrivateAddress(address: string): boolean {
  if (isLoopback(address)) return true;
  if (/^10\./.test(address) || /^192\.168\./.test(address)) return true;
  const match = address.match(/^172\.(\d+)\./);
  if (match && Number(match[1]) >= 16 && Number(match[1]) <= 31) return true;
  return /^(?:fc|fd|fe8|fe9|fea|feb)/i.test(address.replaceAll(":", ""));
}

export function isWebUiRemoteAddressAllowed(
  address: string,
  allowPublicAccess = false,
): boolean {
  if (allowPublicAccess) return true;
  if (isPrivateAddress(address)) return true;
  const match = address.match(/^100\.(\d+)\./);
  return Boolean(match && Number(match[1]) >= 64 && Number(match[1]) <= 127);
}

function isLocalAdminRequest(request: IncomingMessage, remoteAddress: string): boolean {
  return isLocalAdminAddress(remoteAddress, request.headers.host ?? "");
}

export function isLocalAdminAddress(remoteAddress: string, requestHost: string): boolean {
  if (!isLoopback(remoteAddress)) return false;
  const host = requestHost.toLowerCase();
  const hostname = host.startsWith("[") ? host.slice(0, host.indexOf("]") + 1) : host.split(":", 1)[0];
  return hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]";
}

function isHttpsRequest(request: IncomingMessage): boolean {
  const forwarded = request.headers["x-forwarded-proto"];
  if (typeof forwarded === "string" && forwarded.split(",", 1)[0].trim() === "https") return true;
  const origin = request.headers.origin;
  return typeof origin === "string" && origin.startsWith("https://");
}
