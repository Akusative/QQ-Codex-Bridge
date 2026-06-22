import { randomUUID } from "node:crypto";
import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { type RecallStyle, isRecallStyle } from "../memory/memory-recall-style.js";

export interface BridgeAccountIdentity {
  qq: string;
  nickname: string;
}

export interface PersonaRecord {
  id: string;
  category: string;
  name: string;
  content: string;
  documents: PersonaDocumentRecord[];
  enabled: boolean;
  recallStyle: RecallStyle;
  createdAt: string;
  updatedAt: string;
}

export interface PersonaDocumentRecord {
  id: string;
  name: string;
  sizeBytes: number;
  extractedCharacterCount: number;
  createdAt: string;
}

export interface ConversationRecord {
  id: string;
  name: string;
  customName: boolean;
  personaId: string | null;
  contextStartMessageIndex: number;
  memorySummaryMessageIndex: number;
  lastMemorySummaryAt: string | null;
  messageCount: number;
  createdAt: string;
  updatedAt: string;
  permanentMemory: string;
}

export interface ConversationMessage {
  id: string;
  role: "user" | "assistant" | "system";
  text: string;
  createdAt: string;
}

interface AccountSettings {
  activePersonaId: string | null;
  activeConversationId: string | null;
  storageLimitMb: number;
  messageBufferSeconds: number;
  memoryMode: "automatic" | "manual";
  autoMemoryOnConversationSwitch: boolean;
  autoMemoryOnTokenThreshold: boolean;
  autoMemoryTokenThreshold: number;
  autoMemoryOnSchedule: boolean;
  autoMemoryTimezone: string;
  autoMemoryTime: string;
  memoryDirectory: string;
  lastMemorySummaryAt: string | null;
  pluginStates: Record<string, boolean>;
  permanentMemory: string;
}

interface ConversationIndex {
  conversations: ConversationRecord[];
}

export interface MemoryAutomationSettings {
  mode: "automatic" | "manual";
  onConversationSwitch: boolean;
  onTokenThreshold: boolean;
  tokenThreshold: number;
  onSchedule: boolean;
  timezone: string;
  time: string;
}

export interface MessageBufferSettings {
  waitSeconds: number;
}

export class BridgeWorkspaceStore {
  private readonly sharedRoot: string;
  private readonly accountRoot: string;

  constructor(
    private readonly root: string,
    private readonly identity: BridgeAccountIdentity,
    private readonly defaultMemoryDirectory = resolve(dirname(root), "memory-repo"),
  ) {
    this.sharedRoot = join(root, "shared");
    this.accountRoot = join(root, "accounts", safeSegment(identity.qq));
  }

  async initialize(): Promise<void> {
    await Promise.all([
      mkdir(this.sharedRoot, { recursive: true }),
      mkdir(this.conversationRoot(), { recursive: true }),
    ]);
    await Promise.all([
      this.ensureJson(this.personasPath(), []),
      this.ensureJson(this.settingsPath(), this.defaultSettings()),
      this.ensureJson(this.conversationIndexPath(), { conversations: [] }),
      this.writeJson(this.accountPath(), this.identity),
    ]);
    await this.migrateAccountPermanentMemory();
  }

  async snapshot(): Promise<Record<string, unknown>> {
    await this.initialize();
    const [personas, settings, index, usedBytes] = await Promise.all([
      this.personas(),
      this.settings(),
      this.conversationIndex(),
      directorySize(this.conversationRoot()),
    ]);
    const activeConversation = settings.activeConversationId
      ? index.conversations.find((item) => item.id === settings.activeConversationId) ?? null
      : null;
    const activePersona = settings.activePersonaId
      ? personas.find((item) => item.id === settings.activePersonaId && item.enabled) ?? null
      : null;
    const messages = activeConversation
      ? await this.readMessages(activeConversation.id)
      : [];
    const limitBytes = settings.storageLimitMb * 1024 * 1024;
    const usageRatio = limitBytes > 0 ? usedBytes / limitBytes : 0;
    return {
      accounts: [{ ...this.identity, connected: true }],
      activeAccount: this.identity,
      personas,
      activePersona,
      conversations: index.conversations.map((conversation) => ({
        ...conversation,
        personaName:
          personas.find((persona) => persona.id === conversation.personaId)?.name ?? "默认助手",
      })),
      activeConversation,
      messages,
      capacity: {
        usedBytes,
        limitBytes,
        storageLimitMb: settings.storageLimitMb,
        usagePercent: Math.min(100, Math.round(usageRatio * 1000) / 10),
        warning: usageRatio >= 0.8,
        full: usageRatio >= 1,
      },
      messageBuffer: {
        waitSeconds: settings.messageBufferSeconds,
        enabled: settings.messageBufferSeconds > 0,
      },
      autoMemory: {
        enabled: settings.memoryMode === "automatic",
        mode: settings.memoryMode,
        state: "configured",
        label:
          settings.memoryMode === "automatic"
            ? "自动记忆已启用；按所选条件总结新增内容"
            : "手动记忆；仅在用户确认后写入",
        onConversationSwitch: settings.autoMemoryOnConversationSwitch,
        onTokenThreshold: settings.autoMemoryOnTokenThreshold,
        tokenThreshold: settings.autoMemoryTokenThreshold,
        onSchedule: settings.autoMemoryOnSchedule,
        timezone: settings.autoMemoryTimezone,
        time: settings.autoMemoryTime,
        memoryDirectory: settings.memoryDirectory,
        lastSummaryAt: settings.lastMemorySummaryAt,
        reviewReminderDays: 3,
      },
    };
  }

  async savePersona(input: {
    id?: string;
    category: string;
    name: string;
    content: string;
    recallStyle?: RecallStyle;
  }): Promise<PersonaRecord> {
    const personas = await this.personas();
    const now = new Date().toISOString();
    const existing = input.id ? personas.find((item) => item.id === input.id) : undefined;
    const record: PersonaRecord = {
      id: existing?.id ?? randomUUID(),
      category: input.category.trim(),
      name: input.name.trim(),
      content: input.content.trim(),
      documents: existing?.documents ?? [],
      enabled: existing?.enabled ?? true,
      recallStyle: isRecallStyle(input.recallStyle) ? input.recallStyle : existing?.recallStyle ?? "balanced",
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
    };
    if (existing) Object.assign(existing, record);
    else personas.push(record);
    await this.writeJson(this.personasPath(), personas);
    return record;
  }

  async deletePersona(id: string): Promise<void> {
    const personas = await this.personas();
    const next = personas.filter((item) => item.id !== id);
    if (next.length === personas.length) throw new Error("人设不存在。");
    await this.writeJson(this.personasPath(), next);
    await rm(this.personaDocumentsRoot(id), { recursive: true, force: true });
    const settings = await this.settings();
    const index = await this.conversationIndex();
    let conversationsChanged = false;
    for (const conversation of index.conversations) {
      if (conversation.personaId === id) {
        conversation.personaId = null;
        conversationsChanged = true;
      }
    }
    if (settings.activePersonaId === id) {
      settings.activePersonaId = null;
    }
    await Promise.all([
      this.writeJson(this.settingsPath(), settings),
      conversationsChanged
        ? this.writeJson(this.conversationIndexPath(), index)
        : Promise.resolve(),
    ]);
  }

  async selectPersona(id: string | null): Promise<void> {
    if (id) {
      const match = (await this.personas()).find((item) => item.id === id && item.enabled);
      if (!match) throw new Error("人设不存在或已停用。");
    }
    const settings = await this.settings();
    settings.activePersonaId = id;
    const index = await this.conversationIndex();
    const activeConversation = settings.activeConversationId
      ? index.conversations.find((item) => item.id === settings.activeConversationId)
      : undefined;
    if (activeConversation) {
      activeConversation.personaId = id;
      activeConversation.updatedAt = new Date().toISOString();
    }
    await Promise.all([
      this.writeJson(this.settingsPath(), settings),
      activeConversation
        ? this.writeJson(this.conversationIndexPath(), index)
        : Promise.resolve(),
    ]);
  }

  async addPersonaDocument(
    personaId: string,
    input: { name: string; sourceSizeBytes: number; text: string },
  ): Promise<PersonaDocumentRecord> {
    const personas = await this.personas();
    const persona = personas.find((item) => item.id === personaId);
    if (!persona) throw new Error("人设不存在。");
    const record: PersonaDocumentRecord = {
      id: randomUUID(),
      name: input.name.trim(),
      sizeBytes: input.sourceSizeBytes,
      extractedCharacterCount: input.text.length,
      createdAt: new Date().toISOString(),
    };
    await this.writeText(this.personaDocumentPath(personaId, record.id), input.text);
    persona.documents.push(record);
    persona.updatedAt = new Date().toISOString();
    await this.writeJson(this.personasPath(), personas);
    return record;
  }

  async readPersonaDocument(
    personaId: string,
    documentId: string,
  ): Promise<{ document: PersonaDocumentRecord; text: string }> {
    const personas = await this.personas();
    const persona = personas.find((item) => item.id === personaId);
    if (!persona) throw new Error("人设不存在。");
    const document = persona.documents.find((item) => item.id === documentId);
    if (!document) throw new Error("人设文档不存在。");
    const text = await readFile(this.personaDocumentPath(personaId, documentId), "utf8");
    return { document, text };
  }

  async updatePersonaDocument(
    personaId: string,
    documentId: string,
    text: string,
  ): Promise<PersonaDocumentRecord> {
    const personas = await this.personas();
    const persona = personas.find((item) => item.id === personaId);
    if (!persona) throw new Error("人设不存在。");
    const document = persona.documents.find((item) => item.id === documentId);
    if (!document) throw new Error("人设文档不存在。");
    await this.writeText(this.personaDocumentPath(personaId, documentId), text);
    document.extractedCharacterCount = text.length;
    persona.updatedAt = new Date().toISOString();
    await this.writeJson(this.personasPath(), personas);
    return document;
  }

  async deletePersonaDocument(personaId: string, documentId: string): Promise<void> {
    const personas = await this.personas();
    const persona = personas.find((item) => item.id === personaId);
    if (!persona) throw new Error("人设不存在。");
    const next = persona.documents.filter((item) => item.id !== documentId);
    if (next.length === persona.documents.length) throw new Error("人设文档不存在。");
    persona.documents = next;
    persona.updatedAt = new Date().toISOString();
    await Promise.all([
      this.writeJson(this.personasPath(), personas),
      rm(this.personaDocumentPath(personaId, documentId), { force: true }),
    ]);
  }

  async createConversation(name?: string): Promise<ConversationRecord> {
    const index = await this.conversationIndex();
    const settings = await this.settings();
    const now = new Date().toISOString();
    const customName = Boolean(name?.trim());
    const record: ConversationRecord = {
      id: randomUUID(),
      name: name?.trim() || "新对话（发送第一句话后自动命名）",
      customName,
      personaId: settings.activePersonaId,
      contextStartMessageIndex: 0,
      memorySummaryMessageIndex: 0,
      lastMemorySummaryAt: null,
      messageCount: 0,
      createdAt: now,
      updatedAt: now,
      permanentMemory: "",
    };
    index.conversations.unshift(record);
    settings.activeConversationId = record.id;
    await Promise.all([
      this.writeJson(this.conversationIndexPath(), index),
      this.writeJson(this.settingsPath(), settings),
    ]);
    return record;
  }

  async selectConversation(id: string): Promise<void> {
    const index = await this.conversationIndex();
    const selected = index.conversations.find((item) => item.id === id);
    if (!selected) throw new Error("对话不存在。");
    const settings = await this.settings();
    settings.activeConversationId = id;
    settings.activePersonaId = selected.personaId;
    await this.writeJson(this.settingsPath(), settings);
  }

  async renameConversation(id: string, name: string): Promise<void> {
    const index = await this.conversationIndex();
    const match = index.conversations.find((item) => item.id === id);
    if (!match) throw new Error("对话不存在。");
    match.name = name.trim();
    match.customName = true;
    match.updatedAt = new Date().toISOString();
    await this.writeJson(this.conversationIndexPath(), index);
  }

  async clearConversationContext(id: string): Promise<void> {
    const index = await this.conversationIndex();
    const conversation = index.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("对话不存在。");
    conversation.contextStartMessageIndex = conversation.messageCount;
    conversation.updatedAt = new Date().toISOString();
    await this.writeJson(this.conversationIndexPath(), index);
  }

  async listConversations(): Promise<ConversationRecord[]> {
    return (await this.conversationIndex()).conversations;
  }

  async pendingMemorySummary(conversationId: string): Promise<{
    conversation: ConversationRecord;
    messages: ConversationMessage[];
    messageCount: number;
    estimatedTokens: number;
  }> {
    const conversation = (await this.conversationIndex()).conversations.find(
      (item) => item.id === conversationId,
    );
    if (!conversation) throw new Error("对话不存在。");
    const allMessages = await this.readMessages(conversationId);
    const start = Math.min(conversation.memorySummaryMessageIndex, allMessages.length);
    const messages = allMessages.slice(start);
    const characterCount = messages.reduce((total, message) => total + message.text.length, 0);
    return {
      conversation,
      messages,
      messageCount: allMessages.length,
      estimatedTokens: Math.ceil(characterCount / 2),
    };
  }

  async markMemorySummarized(conversationId: string, messageCount: number): Promise<void> {
    const index = await this.conversationIndex();
    const conversation = index.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("对话不存在。");
    conversation.memorySummaryMessageIndex = Math.max(
      conversation.memorySummaryMessageIndex,
      Math.min(messageCount, conversation.messageCount),
    );
    conversation.lastMemorySummaryAt = new Date().toISOString();
    const settings = await this.settings();
    settings.lastMemorySummaryAt = conversation.lastMemorySummaryAt;
    await Promise.all([
      this.writeJson(this.conversationIndexPath(), index),
      this.writeJson(this.settingsPath(), settings),
    ]);
  }

  async listPersonas(): Promise<PersonaRecord[]> {
    return this.personas();
  }

  async activeConversation(): Promise<ConversationRecord | null> {
    const [settings, index] = await Promise.all([this.settings(), this.conversationIndex()]);
    return settings.activeConversationId
      ? index.conversations.find((item) => item.id === settings.activeConversationId) ?? null
      : null;
  }

  async activePersona(): Promise<PersonaRecord | null> {
    const [settings, personas] = await Promise.all([this.settings(), this.personas()]);
    return settings.activePersonaId
      ? personas.find((item) => item.id === settings.activePersonaId) ?? null
      : null;
  }

  async deleteConversation(id: string): Promise<void> {
    const index = await this.conversationIndex();
    const next = index.conversations.filter((item) => item.id !== id);
    if (next.length === index.conversations.length) throw new Error("对话不存在。");
    index.conversations = next;
    const settings = await this.settings();
    if (settings.activeConversationId === id) {
      settings.activeConversationId = next[0]?.id ?? null;
      settings.activePersonaId = next[0]?.personaId ?? null;
    }
    await Promise.all([
      this.writeJson(this.conversationIndexPath(), index),
      this.writeJson(this.settingsPath(), settings),
      rm(this.conversationPath(id), { force: true }),
    ]);
  }

  async appendMessage(
    role: ConversationMessage["role"],
    text: string,
    conversationId?: string,
  ): Promise<string> {
    const settings = await this.settings();
    let id = conversationId ?? settings.activeConversationId;
    if (!id) id = (await this.createConversation()).id;
    const index = await this.conversationIndex();
    const conversation = index.conversations.find((item) => item.id === id);
    if (!conversation) throw new Error("当前对话不存在。");
    const now = new Date().toISOString();
    if (role === "user" && conversation.messageCount === 0 && !conversation.customName) {
      conversation.name = formatBeijingTimestamp(new Date());
    }
    conversation.messageCount += 1;
    conversation.updatedAt = now;
    const message: ConversationMessage = { id: randomUUID(), role, text, createdAt: now };
    await Promise.all([
      appendFile(this.conversationPath(id), `${JSON.stringify(message)}\n`, "utf8"),
      this.writeJson(this.conversationIndexPath(), index),
    ]);
    return id;
  }

  async promptContext(conversationId: string, maxCharacters = 12_000): Promise<string> {
    const [settings, personas, messages] = await Promise.all([
      this.settings(),
      this.personas(),
      this.readMessages(conversationId),
    ]);
    const persona = settings.activePersonaId
      ? personas.find((item) => item.id === settings.activePersonaId && item.enabled)
      : undefined;
    const activeConversation = (await this.conversationIndex()).conversations.find(
      (item) => item.id === conversationId,
    );
    const contextStart = activeConversation?.contextStartMessageIndex ?? 0;
    const previous = messages.slice(contextStart, -1);
    let history = previous
      .slice(-30)
      .map((item) => `${item.role === "user" ? "用户" : item.role === "assistant" ? "助手" : "系统"}：${item.text}`)
      .join("\n");
    if (history.length > maxCharacters) history = history.slice(-maxCharacters);
    const blocks: string[] = [];
    if (persona) {
      const query = messages.at(-1)?.text ?? "";
      const documentContext = await this.personaDocumentContext(persona, query);
      const personaParts = [`当前人设：${persona.name}`];
      if (persona.content) personaParts.push(`核心设定：${persona.content}`);
      if (documentContext) {
        personaParts.push(
          "以下本地文档共同构成人设资料。请遵循与当前任务相关的设定；资料冲突时优先采用更具体、更新、更贴近当前任务的内容。",
          documentContext,
        );
      }
      blocks.push(personaParts.join("\n"));
    }
    if (history) blocks.push(`当前对话的本地历史（仅用于延续本窗口上下文）：\n${history}`);
    return blocks.join("\n\n");
  }

  async updateStorageLimit(storageLimitMb: number): Promise<void> {
    const settings = await this.settings();
    settings.storageLimitMb = storageLimitMb;
    await this.writeJson(this.settingsPath(), settings);
  }

  async messageBufferSettings(): Promise<MessageBufferSettings> {
    const settings = await this.settings();
    return { waitSeconds: settings.messageBufferSeconds };
  }

  async updateMessageBufferSettings(input: MessageBufferSettings): Promise<void> {
    const settings = await this.settings();
    settings.messageBufferSeconds = input.waitSeconds;
    await this.writeJson(this.settingsPath(), settings);
  }

  async pluginStates(): Promise<Record<string, boolean>> {
    const settings = await this.settings();
    return settings.pluginStates ?? {};
  }

  async updatePluginState(id: string, enabled: boolean): Promise<void> {
    const settings = await this.settings();
    settings.pluginStates = { ...(settings.pluginStates ?? {}), [id]: enabled };
    await this.writeJson(this.settingsPath(), settings);
  }

  async conversationPermanentMemory(conversationId: string): Promise<string> {
    const index = await this.conversationIndex();
    return index.conversations.find((item) => item.id === conversationId)?.permanentMemory ?? "";
  }

  async updateConversationPermanentMemory(conversationId: string, text: string): Promise<void> {
    const index = await this.conversationIndex();
    const conversation = index.conversations.find((item) => item.id === conversationId);
    if (!conversation) throw new Error("对话不存在。");
    conversation.permanentMemory = text;
    conversation.updatedAt = new Date().toISOString();
    await this.writeJson(this.conversationIndexPath(), index);
  }

  /** 一次性迁移：把旧的账号级永久记忆搬进当前 active 窗口，然后清空账号字段。 */
  private async migrateAccountPermanentMemory(): Promise<void> {
    const settings = await this.settings();
    if (!settings.permanentMemory) return;
    const index = await this.conversationIndex();
    const target = settings.activeConversationId
      ? index.conversations.find((item) => item.id === settings.activeConversationId)
      : index.conversations[0];
    if (target && !target.permanentMemory) {
      target.permanentMemory = settings.permanentMemory;
      await this.writeJson(this.conversationIndexPath(), index);
    }
    settings.permanentMemory = "";
    await this.writeJson(this.settingsPath(), settings);
  }

  async memorySettings(): Promise<MemoryAutomationSettings & { memoryDirectory: string }> {
    const settings = await this.settings();
    return {
      mode: settings.memoryMode,
      onConversationSwitch: settings.autoMemoryOnConversationSwitch,
      onTokenThreshold: settings.autoMemoryOnTokenThreshold,
      tokenThreshold: settings.autoMemoryTokenThreshold,
      onSchedule: settings.autoMemoryOnSchedule,
      timezone: settings.autoMemoryTimezone,
      time: settings.autoMemoryTime,
      memoryDirectory: settings.memoryDirectory,
    };
  }

  async updateMemorySettings(input: MemoryAutomationSettings): Promise<void> {
    const settings = await this.settings();
    settings.memoryMode = input.mode;
    settings.autoMemoryOnConversationSwitch = input.onConversationSwitch;
    settings.autoMemoryOnTokenThreshold = input.onTokenThreshold;
    settings.autoMemoryTokenThreshold = input.tokenThreshold;
    settings.autoMemoryOnSchedule = input.onSchedule;
    settings.autoMemoryTimezone = input.timezone;
    settings.autoMemoryTime = input.time;
    await this.writeJson(this.settingsPath(), settings);
  }

  async updateMemoryDirectory(memoryDirectory: string): Promise<void> {
    const settings = await this.settings();
    settings.memoryDirectory = resolve(memoryDirectory);
    await this.writeJson(this.settingsPath(), settings);
  }

  async isCapacityFull(): Promise<boolean> {
    const [settings, usedBytes] = await Promise.all([
      this.settings(),
      directorySize(this.conversationRoot()),
    ]);
    return usedBytes >= settings.storageLimitMb * 1024 * 1024;
  }

  private async readMessages(id: string): Promise<ConversationMessage[]> {
    try {
      return (await readFile(this.conversationPath(id), "utf8"))
        .split(/\r?\n/u)
        .filter(Boolean)
        .map((line) => JSON.parse(line) as ConversationMessage);
    } catch (error) {
      if (isMissing(error)) return [];
      throw error;
    }
  }

  private async personas(): Promise<PersonaRecord[]> {
    await this.initializeDirectories();
    const records = await this.readJson<PersonaRecord[]>(this.personasPath(), []);
    return records.map((record) => ({
      ...record,
      documents: record.documents ?? [],
      recallStyle: isRecallStyle(record.recallStyle) ? record.recallStyle : "balanced",
    }));
  }

  private async personaDocumentContext(persona: PersonaRecord, query: string): Promise<string> {
    const excerpts: Array<{ score: number; order: number; text: string }> = [];
    const queryTerms = buildSearchTerms(query);
    let order = 0;
    for (const document of persona.documents) {
      let text: string;
      try {
        text = await readFile(this.personaDocumentPath(persona.id, document.id), "utf8");
      } catch (error) {
        if (isMissing(error)) continue;
        throw error;
      }
      for (const chunk of splitIntoChunks(text, 2_400)) {
        const normalized = chunk.toLowerCase();
        const score = queryTerms.reduce(
          (total, term) => total + (normalized.includes(term) ? Math.max(1, term.length) : 0),
          0,
        );
        excerpts.push({
          score: score + (order === 0 ? 0.5 : 0),
          order: order++,
          text: `【文档：${document.name}】\n${chunk}`,
        });
      }
    }
    excerpts.sort((left, right) => right.score - left.score || left.order - right.order);
    const selected: string[] = [];
    let size = 0;
    for (const excerpt of excerpts) {
      if (selected.length >= 18 || size + excerpt.text.length > 42_000) continue;
      selected.push(excerpt.text);
      size += excerpt.text.length;
    }
    return selected.join("\n\n");
  }

  private async settings(): Promise<AccountSettings> {
    await this.initializeDirectories();
    const stored = await this.readJson<Partial<AccountSettings>>(
      this.settingsPath(),
      this.defaultSettings(),
    );
    return { ...this.defaultSettings(), ...stored };
  }

  private defaultSettings(): AccountSettings {
    return {
      activePersonaId: null,
      activeConversationId: null,
      storageLimitMb: 256,
      messageBufferSeconds: 10,
      memoryMode: "automatic",
      autoMemoryOnConversationSwitch: true,
      autoMemoryOnTokenThreshold: false,
      autoMemoryTokenThreshold: 120_000,
      autoMemoryOnSchedule: true,
      autoMemoryTimezone: "UTC+8",
      autoMemoryTime: "00:00",
      memoryDirectory: resolve(this.defaultMemoryDirectory),
      lastMemorySummaryAt: null,
      pluginStates: {},
      permanentMemory: "",
    };
  }

  private async conversationIndex(): Promise<ConversationIndex> {
    await this.initializeDirectories();
    const index = await this.readJson<ConversationIndex>(this.conversationIndexPath(), { conversations: [] });
    return {
      conversations: index.conversations.map((conversation) => ({
        ...conversation,
        personaId: conversation.personaId ?? null,
        contextStartMessageIndex: conversation.contextStartMessageIndex ?? 0,
        memorySummaryMessageIndex: conversation.memorySummaryMessageIndex ?? 0,
        lastMemorySummaryAt: conversation.lastMemorySummaryAt ?? null,
        permanentMemory: conversation.permanentMemory ?? "",
      })),
    };
  }

  private async initializeDirectories(): Promise<void> {
    await Promise.all([
      mkdir(this.sharedRoot, { recursive: true }),
      mkdir(this.conversationRoot(), { recursive: true }),
    ]);
  }

  private async ensureJson(path: string, fallback: unknown): Promise<void> {
    try {
      await stat(path);
    } catch (error) {
      if (!isMissing(error)) throw error;
      await this.writeJson(path, fallback);
    }
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
      if (isMissing(error)) {
        await this.writeJson(path, fallback);
        return structuredClone(fallback);
      }
      throw error;
    }
  }

  private async writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await rm(path, { force: true });
    await rename(temporary, path);
  }

  private async writeText(path: string, value: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const temporary = `${path}.${process.pid}.tmp`;
    await writeFile(temporary, value, "utf8");
    await rm(path, { force: true });
    await rename(temporary, path);
  }

  private personasPath(): string { return join(this.sharedRoot, "personas.json"); }
  private personaDocumentsRoot(personaId: string): string {
    return join(this.sharedRoot, "persona-documents", safeSegment(personaId));
  }
  private personaDocumentPath(personaId: string, documentId: string): string {
    return join(this.personaDocumentsRoot(personaId), `${safeSegment(documentId)}.txt`);
  }
  private accountPath(): string { return join(this.accountRoot, "account.json"); }
  private settingsPath(): string { return join(this.accountRoot, "settings.json"); }
  private conversationRoot(): string { return join(this.accountRoot, "conversations"); }
  private conversationIndexPath(): string { return join(this.conversationRoot(), "index.json"); }
  private conversationPath(id: string): string { return join(this.conversationRoot(), `${safeSegment(id)}.jsonl`); }
}

function safeSegment(value: string): string {
  const result = value.replace(/[^a-zA-Z0-9_-]/gu, "_");
  return result || "current";
}

function formatBeijingTimestamp(date: Date): string {
  const formatter = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}/${parts.month}/${parts.day}/${parts.hour}/${parts.minute}/${parts.second}`;
}

async function directorySize(path: string): Promise<number> {
  try {
    const entries = await readdir(path, { withFileTypes: true });
    const sizes = await Promise.all(entries.map(async (entry) => {
      const target = join(path, entry.name);
      if (entry.isDirectory()) return directorySize(target);
      return entry.isFile() ? (await stat(target)).size : 0;
    }));
    return sizes.reduce((total, size) => total + size, 0);
  } catch (error) {
    if (isMissing(error)) return 0;
    throw error;
  }
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function splitIntoChunks(value: string, size: number): string[] {
  const paragraphs = value.split(/\n{2,}/u).map((part) => part.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";
  for (const paragraph of paragraphs) {
    if (paragraph.length > size) {
      if (current) chunks.push(current);
      current = "";
      for (let index = 0; index < paragraph.length; index += size) {
        chunks.push(paragraph.slice(index, index + size));
      }
      continue;
    }
    if (current && current.length + paragraph.length + 2 > size) {
      chunks.push(current);
      current = paragraph;
    } else current = current ? `${current}\n\n${paragraph}` : paragraph;
  }
  if (current) chunks.push(current);
  return chunks;
}

function buildSearchTerms(value: string): string[] {
  const normalized = value.toLowerCase();
  const terms = normalized.match(/[a-z0-9_\-]{2,}|[\u3400-\u9fff]{2,}/gu) ?? [];
  const chineseBigrams = [...normalized.matchAll(/[\u3400-\u9fff]+/gu)]
    .flatMap((match) => {
      const token = match[0];
      return Array.from({ length: Math.max(0, token.length - 1) }, (_, index) => token.slice(index, index + 2));
    });
  return [...new Set([...terms, ...chineseBigrams])].slice(0, 80);
}
