import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { BridgeWorkspaceStore } from "../src/workspace/bridge-workspace-store.js";

describe("BridgeWorkspaceStore", () => {
  it("separates account conversations from the shared persona library", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const first = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    const second = new BridgeWorkspaceStore(root, { qq: "10002", nickname: "二号" });
    await first.initialize();
    await second.initialize();

    const persona = await first.savePersona({
      category: "日常",
      name: "测试角色",
      content: "使用轻松但清楚的语气。",
    });
    await first.addPersonaDocument(persona.id, {
      name: "profile.md",
      sourceSizeBytes: 32,
      text: "用户询问工作安排时，先列出今天的优先事项。",
    });
    await first.selectPersona(persona.id);
    await first.appendMessage("user", "第一句话");

    const firstSnapshot = await first.snapshot() as any;
    const secondSnapshot = await second.snapshot() as any;
    expect(firstSnapshot.personas).toHaveLength(1);
    expect(firstSnapshot.personas[0].documents).toHaveLength(1);
    expect(secondSnapshot.personas).toHaveLength(1);
    expect(firstSnapshot.conversations).toHaveLength(1);
    expect(secondSnapshot.conversations).toHaveLength(0);
    expect(firstSnapshot.capacity.storageLimitMb).toBe(256);
    expect(firstSnapshot.activeConversation.name).toMatch(/^\d{4}\/\d{2}\/\d{2}\/\d{2}\/\d{2}\/\d{2}$/u);
  });

  it("retrieves relevant excerpts from multiple persona documents", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await store.initialize();
    const persona = await store.savePersona({ category: "项目", name: "项目搭档", content: "" });
    await store.addPersonaDocument(persona.id, {
      name: "garden.md",
      sourceSizeBytes: 20,
      text: "花园项目使用绿色主题，重点关注植物养护。",
    });
    await store.addPersonaDocument(persona.id, {
      name: "bridge.md",
      sourceSizeBytes: 20,
      text: "桥接项目的 WebUI 需要优先适配手机界面。",
    });
    await store.selectPersona(persona.id);
    const conversation = await store.createConversation("项目窗口");
    await store.appendMessage("user", "桥接项目的手机页面怎么做？", conversation.id);
    const context = await store.promptContext(conversation.id);
    expect(context).toContain("文档：bridge.md");
    expect(context).toContain("优先适配手机界面");
  });

  it("reads and updates the locally extracted text of a persona document", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await store.initialize();
    const persona = await store.savePersona({ category: "日常", name: "测试角色", content: "" });
    const document = await store.addPersonaDocument(persona.id, {
      name: "profile.md",
      sourceSizeBytes: 20,
      text: "修改前的人设内容。",
    });

    expect((await store.readPersonaDocument(persona.id, document.id)).text).toBe("修改前的人设内容。");
    const updated = await store.updatePersonaDocument(persona.id, document.id, "修改后的人设内容。\n\n动作描写独立成段。");
    expect(updated.extractedCharacterCount).toBe("修改后的人设内容。\n\n动作描写独立成段。".length);
    expect((await store.readPersonaDocument(persona.id, document.id)).text).toContain("动作描写独立成段");
  });

  it("remembers a separate persona binding for each conversation", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await store.initialize();
    const calm = await store.savePersona({ category: "日常", name: "沉静", content: "语气沉静。" });
    const lively = await store.savePersona({ category: "日常", name: "活泼", content: "语气活泼。" });
    await store.selectPersona(calm.id);
    const first = await store.createConversation("沉静窗口");
    const second = await store.createConversation("活泼窗口");
    await store.selectPersona(lively.id);

    await store.selectConversation(first.id);
    expect((await store.snapshot() as any).activePersona.name).toBe("沉静");
    await store.selectConversation(second.id);
    const snapshot = await store.snapshot() as any;
    expect(snapshot.activePersona.name).toBe("活泼");
    expect(snapshot.conversations.find((item: any) => item.id === first.id).personaName).toBe("沉静");
  });

  it("stores messages locally and builds context only from the selected window", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await store.initialize();
    const conversation = await store.createConversation("独立窗口");
    await store.appendMessage("user", "前文", conversation.id);
    await store.appendMessage("assistant", "回应", conversation.id);
    await store.appendMessage("user", "当前问题", conversation.id);

    const context = await store.promptContext(conversation.id);
    expect(context).toContain("用户：前文");
    expect(context).toContain("助手：回应");
    expect(context).not.toContain("当前问题");
    const raw = await readFile(join(root, "accounts", "10001", "conversations", `${conversation.id}.jsonl`), "utf8");
    expect(raw).toContain("当前问题");
  });

  it("clears future context without deleting the visible local transcript", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" });
    await store.initialize();
    const conversation = await store.createConversation("可清空窗口");
    await store.appendMessage("user", "需要忘掉的旧问题", conversation.id);
    await store.appendMessage("assistant", "旧问题的回应", conversation.id);
    await store.clearConversationContext(conversation.id);
    await store.appendMessage("user", "新的问题", conversation.id);

    const context = await store.promptContext(conversation.id);
    expect(context).not.toContain("需要忘掉的旧问题");
    expect(context).not.toContain("旧问题的回应");
    const raw = await readFile(join(root, "accounts", "10001", "conversations", `${conversation.id}.jsonl`), "utf8");
    expect(raw).toContain("需要忘掉的旧问题");
    expect(raw).toContain("新的问题");
  });

  it("persists configurable automatic memory rules and summary cursors", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const memoryRoot = join(root, "private-memory");
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "一号" }, memoryRoot);
    await store.initialize();
    expect(await store.memorySettings()).toMatchObject({
      mode: "automatic",
      onConversationSwitch: true,
      onTokenThreshold: false,
      tokenThreshold: 120000,
      onSchedule: true,
      timezone: "UTC+8",
      time: "00:00",
      memoryDirectory: memoryRoot,
    });
    await store.updateMemorySettings({
      mode: "manual",
      onConversationSwitch: false,
      onTokenThreshold: true,
      tokenThreshold: 64000,
      onSchedule: false,
      timezone: "Asia/Shanghai",
      time: "08:30",
    });
    const conversation = await store.createConversation("记忆游标");
    await store.appendMessage("user", "只处理一次", conversation.id);
    const pending = await store.pendingMemorySummary(conversation.id);
    expect(pending.messages).toHaveLength(1);
    await store.markMemorySummarized(conversation.id, pending.messageCount);
    expect((await store.pendingMemorySummary(conversation.id)).messages).toHaveLength(0);
    expect(await store.memorySettings()).toMatchObject({
      mode: "manual",
      tokenThreshold: 64000,
      timezone: "Asia/Shanghai",
      time: "08:30",
    });
  });

  it("defaults the local QQ message buffer to ten seconds and persists changes", async () => {
    const root = await mkdtemp(join(tmpdir(), "bridge-workspace-"));
    const store = new BridgeWorkspaceStore(root, { qq: "10001", nickname: "缓冲测试" });
    await store.initialize();
    expect(await store.messageBufferSettings()).toEqual({ waitSeconds: 10 });
    await store.updateMessageBufferSettings({ waitSeconds: 4 });
    expect(await store.messageBufferSettings()).toEqual({ waitSeconds: 4 });
  });
});
