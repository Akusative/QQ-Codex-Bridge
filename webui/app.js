const $ = (selector) => document.querySelector(selector);
const appView = $("#app-view");
const pairView = $("#pair-view");
const actionDialog = $("#action-dialog");
const personaDialog = $("#persona-dialog");
const personaDocumentDialog = $("#persona-document-dialog");
const toast = $("#toast");

const state = {
  bootstrap: null,
  workspace: null,
  memoryWindowId: null,
  busy: false,
  confirmAction: null,
  cancelAction: null,
  workspacePoll: null,
  updatePoll: null,
  softwareUpdate: null,
  settings: null,
  editingPersonaId: null,
  pendingPersonaFiles: [],
  selectNewPersonaAfterSave: false,
};

document.addEventListener("DOMContentLoaded", boot);

async function boot() {
  bindEvents();
  try {
    state.bootstrap = await api("/api/bootstrap");
    if (state.bootstrap.authenticated) await showApp();
    else showLogin();
  } catch (error) {
    showLogin(error.message);
  }
}

function bindEvents() {
  $("#login-form").addEventListener("submit", login);
  $("#chat-form").addEventListener("submit", sendTask);
  $("#stop-task").addEventListener("click", cancelTask);
  $("#new-conversation").addEventListener("click", createConversation);
  $("#rename-conversation").addEventListener("click", renameCurrentConversation);
  $("#toggle-conversations").addEventListener("click", () => $("#conversation-sidebar").classList.add("open"));
  $("#close-conversations").addEventListener("click", closeConversationSidebar);
  $("#conversation-selector").addEventListener("change", handleConversationSelector);
  $("#persona-selector").addEventListener("change", handlePersonaSelector);
  $("#account-switcher").addEventListener("click", () => showToast("当前只接入了这一个机器人账号；第二个 QQ 接入后会出现在这里。"));
  $("#add-persona").addEventListener("click", () => openPersonaEditor());
  $("#persona-cancel").addEventListener("click", () => {
    state.selectNewPersonaAfterSave = false;
    personaDialog.close();
  });
  $("#persona-form").addEventListener("submit", savePersona);
  $("#persona-documents").addEventListener("change", stagePersonaDocuments);
  $("#persona-document-form").addEventListener("submit", savePersonaDocument);
  $("#persona-document-cancel").addEventListener("click", () => personaDocumentDialog.close());
  $("#persona-filter").addEventListener("change", renderPersonas);
  $("#memory-form").addEventListener("submit", createMemoryDraft);
  $("#memory-path-form").addEventListener("submit", updateMemoryPath);
  $("#sync-memory").addEventListener("click", syncMemory);
  bindPermanentMemory();
  $("#refresh-status").addEventListener("click", refreshStatus);
  $("#model-form").addEventListener("submit", updateModelSetting);
  $("#storage-form").addEventListener("submit", updateStorageLimit);
  $("#message-buffer-form").addEventListener("submit", updateMessageBufferSettings);
  $("#memory-settings-form").addEventListener("submit", updateMemorySettings);
  document.querySelectorAll('input[name="memory-mode"]').forEach((input) => {
    input.addEventListener("change", updateAutoMemoryControls);
  });
  $("#password-form").addEventListener("submit", updatePassword);
  $("#revoke-devices").addEventListener("click", revokeDevices);
  $("#check-update").addEventListener("click", () => refreshSoftwareUpdate(true));
  $("#apply-update").addEventListener("click", confirmSoftwareUpdate);
  $("#restart-bridge").addEventListener("click", confirmBridgeRestart);
  document.querySelectorAll(".nav-item").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab));
  });
  document.querySelectorAll(".command-card").forEach((button) => {
    button.addEventListener("click", () => {
      const input = $("#chat-input");
      input.value = button.dataset.command || "";
      input.focus();
    });
  });
  $("#dialog-confirm").addEventListener("click", async (event) => {
    event.preventDefault();
    const action = state.confirmAction;
    state.confirmAction = null;
    state.cancelAction = null;
    actionDialog.close();
    if (action) await action();
  });
  $("#dialog-cancel").addEventListener("click", async () => {
    const action = state.cancelAction;
    state.confirmAction = null;
    state.cancelAction = null;
    if (action) await action();
  });
}

function showLogin(message = "") {
  appView.hidden = true;
  pairView.hidden = false;
  $("#login-error").textContent = message;
  $("#login-password").focus();
}

async function login(event) {
  event.preventDefault();
  const password = $("#login-password").value;
  try {
    await api("/api/login", { method: "POST", body: { password } });
    $("#login-password").value = "";
    state.bootstrap = await api("/api/bootstrap");
    await showApp();
  } catch (error) {
    $("#login-error").textContent = error.message;
  }
}

async function showApp() {
  pairView.hidden = true;
  appView.hidden = false;
  await Promise.all([refreshWorkspace(), refreshStatus(), refreshMemories(), refreshSettings()]);
  if (!state.workspacePoll) {
    state.workspacePoll = window.setInterval(() => {
      if (!document.hidden && !state.busy) void refreshWorkspace(true);
    }, 3000);
  }
  if (!state.updatePoll) {
    state.updatePoll = window.setInterval(() => void refreshSoftwareUpdate(), 30 * 60_000);
  }
}

async function refreshWorkspace(quiet = false) {
  try {
    state.workspace = await api("/api/workspace");
    renderAccount();
    renderConversations();
    renderMessages();
    renderPersonas();
    renderCapacity();
    renderAutoMemory();
  } catch (error) {
    if (!quiet) showToast(error.message);
  }
}

function renderAccount() {
  const account = state.workspace?.activeAccount;
  if (!account) return;
  $("#account-nickname").textContent = account.nickname;
  $("#account-qq").textContent = `QQ ${account.qq}`;
  $(".account-avatar").textContent = account.nickname.slice(0, 1).toUpperCase() || "Q";
}

function renderConversations() {
  const workspace = state.workspace;
  const list = $("#conversation-list");
  list.replaceChildren();
  if (!workspace?.conversations?.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state small";
    empty.textContent = "还没有对话窗口";
    list.append(empty);
  } else {
    for (const conversation of workspace.conversations) {
      const item = document.createElement("article");
      item.className = `conversation-item${workspace.activeConversation?.id === conversation.id ? " active" : ""}`;
      const select = document.createElement("button");
      select.type = "button";
      select.className = "conversation-select";
      const title = document.createElement("strong");
      title.textContent = conversation.name;
      const meta = document.createElement("small");
      meta.textContent = `${conversation.personaName} · ${conversation.messageCount} 条 · ${formatShortDate(conversation.updatedAt)}`;
      select.append(title, meta);
      select.addEventListener("click", () => selectConversation(conversation.id));
      const remove = document.createElement("button");
      remove.type = "button";
      remove.className = "conversation-delete";
      remove.textContent = "×";
      remove.title = "删除对话";
      remove.addEventListener("click", () => confirmDeleteConversation(conversation));
      item.append(select, remove);
      list.append(item);
    }
  }
  const active = workspace?.activeConversation;
  $("#rename-conversation").disabled = !active;
  renderChatContextSelectors();
}

function renderChatContextSelectors() {
  const workspace = state.workspace;
  if (!workspace) return;
  const conversationSelector = $("#conversation-selector");
  const conversationOptions = workspace.conversations.map((item) =>
    new Option(`${item.name} — ${item.personaName}`, item.id),
  );
  if (!conversationOptions.length) conversationOptions.push(new Option("尚无窗口", "", true, true));
  conversationOptions.push(new Option("＋ 新建一个窗口", "__new__"));
  conversationSelector.replaceChildren(...conversationOptions);
  conversationSelector.value = workspace.activeConversation?.id || "";

  const personaSelector = $("#persona-selector");
  const personaOptions = [new Option("默认助手", "")];
  for (const persona of workspace.personas) personaOptions.push(new Option(persona.name, persona.id));
  personaOptions.push(new Option("＋ 新建一个人设", "__new__"));
  personaSelector.replaceChildren(...personaOptions);
  personaSelector.value = workspace.activePersona?.id || "";
}

function handleConversationSelector(event) {
  if (event.target.value === "__new__") void createConversation();
  else if (event.target.value) void selectConversation(event.target.value);
}

function handlePersonaSelector(event) {
  if (event.target.value === "__new__") {
    event.target.value = state.workspace?.activePersona?.id || "";
    openPersonaEditor(null, true);
  } else void selectPersona(event.target.value || null);
}

function renderMessages() {
  const messages = $("#messages");
  messages.replaceChildren();
  const entries = state.workspace?.messages || [];
  if (!entries.length) {
    const welcome = document.createElement("div");
    welcome.className = "welcome-state";
    welcome.innerHTML = '<div class="welcome-orbit">✦</div><h3>从这里开始一段新对话</h3><p class="muted">第一句话会按北京时间自动命名窗口。切换窗口时，人设会保持不变。</p>';
    messages.append(welcome);
    return;
  }
  for (const message of entries) appendMessageNode(message.role, message.text, false);
  messages.scrollTop = messages.scrollHeight;
}

function renderPersonas() {
  if (!state.workspace) return;
  const personas = state.workspace.personas || [];
  const categories = [...new Set(personas.map((item) => item.category))].sort();
  const filter = $("#persona-filter");
  const previous = filter.value;
  filter.replaceChildren(new Option("全部分类", ""), ...categories.map((value) => new Option(value, value)));
  filter.value = categories.includes(previous) ? previous : "";
  const shown = personas.filter((item) => !filter.value || item.category === filter.value);
  const list = $("#persona-list");
  list.replaceChildren();
  if (!shown.length) {
    const empty = document.createElement("div");
    empty.className = "empty-state";
    empty.textContent = personas.length ? "这个分类里暂时没有人设" : "还没有人设。新建一个，给对话一点灵魂。";
    list.append(empty);
    return;
  }
  for (const persona of shown) {
    const card = document.createElement("article");
    const active = state.workspace.activePersona?.id === persona.id;
    card.className = `persona-card${active ? " active" : ""}`;
    const head = document.createElement("div");
    head.className = "persona-card-head";
    const title = document.createElement("div");
    const name = document.createElement("h3");
    name.textContent = persona.name;
    const category = document.createElement("span");
    category.className = "persona-category";
    category.textContent = persona.category;
    title.append(name, category);
    if (active) {
      const badge = document.createElement("span");
      badge.className = "state-badge";
      badge.textContent = "使用中";
      head.append(title, badge);
    } else head.append(title);
    const content = document.createElement("p");
    content.textContent = persona.content || "详细设定由资料文档组成。";
    const documentSummary = document.createElement("span");
    documentSummary.className = "persona-document-summary";
    documentSummary.textContent = `${persona.documents?.length || 0} 份资料文档`;
    const actions = document.createElement("div");
    actions.className = "persona-card-actions";
    const choose = button(active ? "取消使用" : "选择", active ? "ghost" : "primary", () => selectPersona(active ? null : persona.id));
    const edit = button("编辑", "ghost", () => openPersonaEditor(persona));
    const remove = button("删除", "ghost danger", () => confirmDeletePersona(persona));
    actions.append(choose, edit, remove);
    card.append(head, content, documentSummary, actions);
    list.append(card);
  }
}

function renderCapacity() {
  const capacity = state.workspace?.capacity;
  if (!capacity) return;
  const percent = capacity.usagePercent;
  $("#sidebar-capacity").textContent = `${percent}%`;
  $("#capacity-percent").textContent = `${percent}%`;
  $("#capacity-detail").textContent = `${formatBytes(capacity.usedBytes)} / ${formatBytes(capacity.limitBytes)}`;
  $("#storage-limit").value = String(capacity.storageLimitMb);
  for (const id of ["#sidebar-progress", "#settings-progress"]) {
    const bar = $(id);
    bar.style.width = `${Math.min(100, percent)}%`;
    bar.parentElement.classList.toggle("warning", capacity.warning);
  }
  $("#capacity-warning").hidden = !capacity.warning;
  $("#send-task").disabled = state.busy || capacity.full;
  $("#chat-input").disabled = state.busy || capacity.full;
  if (capacity.full) $("#chat-input").placeholder = "聊天记录已达到上限，请先清理旧窗口或提高容量。";
}

function renderAutoMemory() {
  const autoMemory = state.workspace?.autoMemory;
  if (!autoMemory) return;
  $("#auto-memory-label").textContent = autoMemory.label;
  const automatic = autoMemory.mode !== "manual";
  $("#auto-memory-state").textContent = automatic ? "自动" : "手动";
  $("#settings-auto-memory").textContent = automatic ? "自动记忆" : "手动记忆";
  $("#memory-mode-automatic").checked = automatic;
  $("#memory-mode-manual").checked = !automatic;
  $("#memory-on-switch").checked = autoMemory.onConversationSwitch !== false;
  $("#memory-on-token").checked = Boolean(autoMemory.onTokenThreshold);
  $("#memory-on-schedule").checked = autoMemory.onSchedule !== false;
  setInputValueUnlessEditing("#memory-token-threshold", autoMemory.tokenThreshold ?? 120000);
  setInputValueUnlessEditing("#memory-timezone", autoMemory.timezone || "UTC+8");
  setInputValueUnlessEditing("#memory-time", autoMemory.time || "00:00");
  setInputValueUnlessEditing("#memory-directory", autoMemory.memoryDirectory || "");
  updateAutoMemoryControls();
}

function setInputValueUnlessEditing(selector, value) {
  const input = $(selector);
  if (document.activeElement !== input) input.value = String(value);
}

function updateAutoMemoryControls() {
  $("#automatic-memory-options").disabled = !$("#memory-mode-automatic").checked;
}

async function createConversation() {
  try {
    await api("/api/conversations/create", { method: "POST", body: {} });
    await refreshWorkspace();
    closeConversationSidebar();
    $("#chat-input").focus();
  } catch (error) { showToast(error.message); }
}

async function selectConversation(id) {
  try {
    await api("/api/conversations/select", { method: "POST", body: { id } });
    await refreshWorkspace();
    closeConversationSidebar();
  } catch (error) { showToast(error.message); }
}

function renameCurrentConversation() {
  const active = state.workspace?.activeConversation;
  if (!active) return;
  const name = window.prompt("给当前对话起个新名字", active.name)?.trim();
  if (!name || name === active.name) return;
  void (async () => {
    try {
      await api("/api/conversations/rename", { method: "POST", body: { id: active.id, name } });
      await refreshWorkspace();
      showToast("对话名称已更新");
    } catch (error) { showToast(error.message); }
  })();
}

function confirmDeleteConversation(conversation) {
  openDialog("删除对话窗口", `“${conversation.name}”及其本地聊天记录会被删除。长期记忆不会受影响。`, async () => {
    try {
      await api("/api/conversations/delete", { method: "POST", body: { id: conversation.id } });
      await refreshWorkspace();
      showToast("对话窗口已删除");
    } catch (error) { showToast(error.message); }
  });
}

function closeConversationSidebar() { $("#conversation-sidebar").classList.remove("open"); }

function openPersonaEditor(persona = null, selectAfterSave = false) {
  $("#persona-dialog-title").textContent = persona ? "编辑人设" : "新建人设";
  $("#persona-id").value = persona?.id || "";
  $("#persona-category").value = persona?.category || "";
  $("#persona-name").value = persona?.name || "";
  $("#persona-content").value = persona?.content || "";
  $("#persona-recall-style").value = persona?.recallStyle || "balanced";
  $("#persona-documents").value = "";
  state.editingPersonaId = persona?.id || null;
  state.pendingPersonaFiles = [];
  state.selectNewPersonaAfterSave = selectAfterSave;
  renderPersonaEditorDocuments();
  personaDialog.showModal();
  $("#persona-category").focus();
}

async function savePersona(event) {
  event.preventDefault();
  const existing = state.workspace?.personas?.find((item) => item.id === state.editingPersonaId);
  if (!$("#persona-content").value.trim() && !existing?.documents?.length && !state.pendingPersonaFiles.length) {
    showToast("请填写核心设定，或至少选择一份人设文档");
    return;
  }
  const saveButton = $("#persona-save");
  saveButton.disabled = true;
  saveButton.textContent = state.pendingPersonaFiles.length ? "正在保存文档…" : "正在保存…";
  try {
    const result = await api("/api/personas/save", {
      method: "POST",
      body: {
        id: $("#persona-id").value || undefined,
        category: $("#persona-category").value,
        name: $("#persona-name").value,
        content: $("#persona-content").value,
        recallStyle: $("#persona-recall-style").value,
      },
    });
    state.editingPersonaId = result.persona.id;
    while (state.pendingPersonaFiles.length) {
      const file = state.pendingPersonaFiles[0];
      saveButton.textContent = `正在读取 ${file.name}`;
      const dataBase64 = await fileToBase64(file);
      await api("/api/personas/documents/upload", {
        method: "POST",
        body: { personaId: result.persona.id, name: file.name, dataBase64 },
      });
      state.pendingPersonaFiles.shift();
      renderPendingPersonaDocuments();
    }
    if (state.selectNewPersonaAfterSave) {
      await api("/api/personas/select", { method: "POST", body: { id: result.persona.id } });
      state.selectNewPersonaAfterSave = false;
    }
    personaDialog.close();
    await refreshWorkspace();
    showToast("人设与资料文档已保存在本地共享库");
  } catch (error) {
    await refreshWorkspace();
    renderPersonaEditorDocuments();
    showToast(error.payload?.type === "sensitive-blocked" ? sensitiveNotice(error.payload.facts) : error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "保存人设与文档";
  }
}

function stagePersonaDocuments() {
  const selected = [...$("#persona-documents").files];
  for (const file of selected) {
    if (file.size > 20 * 1024 * 1024) {
      showToast(`${file.name} 超过 20 MB，未加入`);
      continue;
    }
    const duplicate = state.pendingPersonaFiles.some((item) => item.name === file.name && item.size === file.size);
    if (!duplicate) state.pendingPersonaFiles.push(file);
  }
  $("#persona-documents").value = "";
  renderPendingPersonaDocuments();
}

function renderPersonaEditorDocuments() {
  const persona = state.workspace?.personas?.find((item) => item.id === state.editingPersonaId);
  const documents = persona?.documents || [];
  $("#persona-document-count").textContent = String(documents.length + state.pendingPersonaFiles.length);
  const list = $("#persona-document-list");
  list.replaceChildren();
  for (const document of documents) {
    list.append(documentRow(
      document.name,
      `${document.extractedCharacterCount.toLocaleString("zh-CN")} 字符 · 已保存在本地`,
      [
        { label: "修改", className: "ghost compact", action: () => openPersonaDocumentEditor(persona.id, document.id) },
        { label: "移除", className: "ghost compact danger", action: () => deletePersonaDocument(persona.id, document.id) },
      ],
    ));
  }
  renderPendingPersonaDocuments();
}

function renderPendingPersonaDocuments() {
  const list = $("#pending-document-list");
  list.replaceChildren();
  state.pendingPersonaFiles.forEach((file) => {
    list.append(documentRow(
      file.name,
      `${formatBytes(file.size)} · 等待保存`,
      [{
        label: "取消",
        className: "ghost compact danger",
        action: () => {
          state.pendingPersonaFiles = state.pendingPersonaFiles.filter((item) => item !== file);
          renderPendingPersonaDocuments();
        },
      }],
    ));
  });
  const existingCount = state.workspace?.personas?.find((item) => item.id === state.editingPersonaId)?.documents?.length || 0;
  $("#persona-document-count").textContent = String(existingCount + state.pendingPersonaFiles.length);
}

function documentRow(name, detail, actions) {
  const row = document.createElement("article");
  row.className = "document-row";
  const body = document.createElement("div");
  const title = document.createElement("strong");
  title.textContent = name;
  const meta = document.createElement("small");
  meta.textContent = detail;
  body.append(title, meta);
  row.append(body, ...actions.map((item) => button(item.label, item.className, item.action)));
  return row;
}

async function openPersonaDocumentEditor(personaId, documentId) {
  try {
    const result = await api("/api/personas/documents/read", {
      method: "POST",
      body: { personaId, documentId },
    });
    $("#persona-document-persona-id").value = personaId;
    $("#persona-document-id").value = documentId;
    $("#persona-document-edit-name").textContent = result.document.name;
    $("#persona-document-text").value = result.text;
    personaDocumentDialog.showModal();
    $("#persona-document-text").focus();
  } catch (error) { showToast(error.message); }
}

async function savePersonaDocument(event) {
  event.preventDefault();
  const saveButton = $("#persona-document-save");
  const text = $("#persona-document-text").value;
  if (!text.trim()) {
    showToast("人设资料内容不能为空");
    return;
  }
  saveButton.disabled = true;
  saveButton.textContent = "正在保存…";
  try {
    await api("/api/personas/documents/update", {
      method: "POST",
      body: {
        personaId: $("#persona-document-persona-id").value,
        documentId: $("#persona-document-id").value,
        text,
      },
    });
    personaDocumentDialog.close();
    await refreshWorkspace();
    renderPersonaEditorDocuments();
    showToast("人设资料已更新");
  } catch (error) {
    showToast(error.payload?.type === "sensitive-blocked" ? sensitiveNotice(error.payload.facts) : error.message);
  } finally {
    saveButton.disabled = false;
    saveButton.textContent = "保存修改";
  }
}

async function deletePersonaDocument(personaId, documentId) {
  try {
    await api("/api/personas/documents/delete", { method: "POST", body: { personaId, documentId } });
    await refreshWorkspace();
    renderPersonaEditorDocuments();
    showToast("人设文档已移除");
  } catch (error) { showToast(error.message); }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener("load", () => resolve(String(reader.result).split(",", 2)[1] || ""), { once: true });
    reader.addEventListener("error", () => reject(new Error(`${file.name} 读取失败`)), { once: true });
    reader.readAsDataURL(file);
  });
}

async function selectPersona(id) {
  try {
    await api("/api/personas/select", { method: "POST", body: { id } });
    await refreshWorkspace();
    showToast(id ? "已切换人设；当前对话窗口保持不变" : "已恢复默认助手");
  } catch (error) { showToast(error.message); }
}

function confirmDeletePersona(persona) {
  openDialog("删除人设", `确定删除“${persona.name}”吗？这不会删除任何对话或长期记忆。`, async () => {
    try {
      await api("/api/personas/delete", { method: "POST", body: { id: persona.id } });
      await refreshWorkspace();
      showToast("人设已删除");
    } catch (error) { showToast(error.message); }
  });
}

async function sendTask(event) {
  event.preventDefault();
  const input = $("#chat-input");
  const message = input.value.trim();
  if (!message || state.busy || state.workspace?.capacity?.full) return;
  appendMessageNode("user", message);
  input.value = "";
  setBusy(true);
  try {
    const result = await api("/api/chat", {
      method: "POST",
      body: { message, useMemory: $("#use-memory").checked },
      acceptStatuses: [202, 502],
    });
    if (result.type === "confirmation-required") {
      appendMessageNode("system", "检测到高风险操作，任务尚未执行。确认后仍只会在只读模式中运行。", true);
      openDialog("确认只读执行", `这项请求需要再次确认。确认窗口将在 ${result.expiresInSeconds} 秒后失效。`, confirmHighRisk, cancelTask);
    } else if (result.text) appendMessageNode("assistant", result.text, true);
  } catch (error) {
    if (error.payload?.type === "sensitive-blocked") appendMessageNode("system", sensitiveNotice(error.payload.facts), true);
    else appendMessageNode("system", error.message, true);
  } finally {
    setBusy(false);
    await refreshWorkspace();
  }
}

async function confirmHighRisk() {
  setBusy(true);
  try {
    const result = await api("/api/chat/confirm", { method: "POST", body: {}, acceptStatuses: [502] });
    if (result.text) appendMessageNode("assistant", result.text, true);
  } catch (error) { appendMessageNode("system", error.message, true); }
  finally { setBusy(false); await refreshWorkspace(); }
}

async function cancelTask() {
  try {
    await api("/api/cancel", { method: "POST", body: {} });
    showToast("当前操作已取消");
  } catch (error) { showToast(error.message); }
  finally { setBusy(false); }
}

async function createMemoryDraft(event) {
  event.preventDefault();
  const content = $("#memory-input").value.trim();
  try {
    const result = await api("/api/memory/draft", { method: "POST", body: { content } });
    const preview = result.preview;
    openDialog("确认写入记忆", `类别：${categoryLabel(preview.category)}\n标题：${preview.title}\n\n${preview.summary}`, async () => {
      try {
        const saved = await api("/api/memory/confirm", { method: "POST", body: {} });
        $("#memory-input").value = "";
        showToast(saved.synced ? "记忆已写入并同步" : "记忆已写入本机，远端同步待处理");
        await refreshMemories();
      } catch (error) { showToast(error.message); }
    }, cancelMemoryDraft);
  } catch (error) { showToast(error.message); }
}

async function refreshMemories() {
  if (!state.workspace) {
    try { state.workspace = await api("/api/workspace"); } catch { /* 忽略 */ }
  }
  renderMemoryWindowSelect();
  await Promise.all([refreshPermanentMemory(), refreshNonPermanentMemories()]);
}

function renderMemoryWindowSelect() {
  const select = $("#memory-window");
  if (!select) return;
  const conversations = state.workspace?.conversations || [];
  const activeId = state.workspace?.activeConversation?.id || "";
  if (!state.memoryWindowId || !conversations.some((c) => c.id === state.memoryWindowId)) {
    state.memoryWindowId = activeId || conversations[0]?.id || "";
  }
  if (conversations.length) {
    select.replaceChildren(...conversations.map((c) => new Option(c.name, c.id)));
    select.value = state.memoryWindowId;
  } else {
    select.replaceChildren(new Option("尚无窗口", ""));
  }
}

function memoryWindowQuery() {
  return state.memoryWindowId
    ? `?conversationId=${encodeURIComponent(state.memoryWindowId)}`
    : "";
}

async function refreshPermanentMemory() {
  try {
    const { text } = await api(`/api/memory/permanent${memoryWindowQuery()}`);
    const box = $("#permanent-memory");
    box._saved = text || "";
    if (!box.dataset.editing) box.value = text || "";
  } catch { /* 永久记忆不可用时保留空框 */ }
}

async function refreshNonPermanentMemories() {
  try {
    const result = await api(`/api/memories${memoryWindowQuery()}`);
    const list = $("#memory-list");
    list.replaceChildren();
    $("#memory-count").textContent = String(result.entries.length);
    if (!result.entries.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = "还没有非永久记忆";
      list.append(empty);
      return;
    }
    for (const entry of result.entries) {
      list.append(renderMemoryRow(entry));
    }
  } catch (error) { showToast(error.message); }
}

function renderMemoryRow(entry) {
  const article = document.createElement("article");
  article.className = "memory-item compact";
  const main = document.createElement("div");
  main.className = "memory-main";
  const meta = document.createElement("div");
  meta.className = "memory-meta";
  const date = document.createElement("span");
  date.className = "memory-date";
  date.textContent = entry.fuzzyDate || "";
  const category = document.createElement("span");
  category.className = "category";
  category.textContent = categoryLabel(entry.category);
  meta.append(date, category);
  for (const emotion of entry.emotions || []) {
    const tag = document.createElement("span");
    tag.className = "emotion-tag";
    tag.textContent = emotion;
    meta.append(tag);
  }
  const text = document.createElement("p");
  text.className = "memory-summary";
  text.textContent = entry.summary || entry.title;
  main.append(meta, text);
  const actions = document.createElement("div");
  actions.className = "memory-actions";
  actions.append(
    button("编辑", "ghost", () => startMemoryEdit(article, entry, text)),
    button("遗忘", "ghost danger", () => prepareForget(entry)),
  );
  article.append(main, actions);
  return article;
}

function startMemoryEdit(article, entry, textElement) {
  if (article.querySelector(".memory-edit")) return;
  const editor = document.createElement("textarea");
  editor.className = "memory-edit";
  editor.rows = 3;
  editor.value = entry.summary || entry.title;
  const bar = document.createElement("div");
  bar.className = "memory-actions";
  const save = button("保存", "primary", async () => {
    const value = editor.value.trim();
    if (value.length < 2) { showToast("记忆内容太短"); return; }
    save.disabled = true;
    try {
      const result = await api("/api/memory/update", { method: "POST", body: { index: entry.index, text: value, conversationId: state.memoryWindowId } });
      showToast(result.synced ? "记忆已更新并同步" : "记忆已更新，远端同步待处理");
      await refreshNonPermanentMemories();
    } catch (error) { save.disabled = false; showToast(error.message); }
  });
  const cancel = button("取消", "ghost", () => refreshNonPermanentMemories());
  bar.append(save, cancel);
  textElement.replaceWith(editor);
  const oldActions = article.querySelector(".memory-actions");
  if (oldActions) oldActions.replaceWith(bar);
  editor.focus();
}

function bindPermanentMemory() {
  const box = $("#permanent-memory");
  const edit = $("#permanent-edit");
  const save = $("#permanent-save");
  const cancel = $("#permanent-cancel");
  $("#memory-window").addEventListener("change", (event) => {
    state.memoryWindowId = event.target.value;
    void refreshPermanentMemory();
    void refreshNonPermanentMemories();
  });
  edit.addEventListener("click", () => {
    box.dataset.editing = "1";
    box.readOnly = false;
    edit.hidden = true;
    save.hidden = false;
    cancel.hidden = false;
    box.focus();
  });
  const exitEdit = () => {
    delete box.dataset.editing;
    box.readOnly = true;
    edit.hidden = false;
    save.hidden = true;
    cancel.hidden = true;
  };
  cancel.addEventListener("click", () => { box.value = box._saved || ""; exitEdit(); });
  save.addEventListener("click", () => {
    openDialog("保存永久记忆", "这块记忆会在新对话开始时带给 AI。确认保存？", async () => {
      save.disabled = true;
      try {
        await api("/api/memory/permanent", { method: "POST", body: { text: box.value, conversationId: state.memoryWindowId } });
        box._saved = box.value;
        showToast("永久记忆已保存");
        exitEdit();
      } catch (error) { showToast(error.message); }
      finally { save.disabled = false; }
    });
  });
}

async function prepareForget(entry) {
  try {
    await api("/api/memory/forget", { method: "POST", body: { index: entry.index, conversationId: state.memoryWindowId } });
    openDialog("确认遗忘", `类别：${categoryLabel(entry.category)}\n标题：${entry.title}\n\n删除后会同步到私有记忆库。`, async () => {
      try {
        const result = await api("/api/memory/forget/confirm", { method: "POST", body: {} });
        showToast(result.synced ? "记忆已删除并同步" : "记忆已删除，远端同步待处理");
        await refreshMemories();
      } catch (error) { showToast(error.message); }
    }, cancelMemoryDraft);
  } catch (error) { showToast(error.message); }
}

async function syncMemory() {
  try {
    const result = await api("/api/memory/sync", { method: "POST", body: {} });
    showToast(({ "up-to-date": "记忆库已经是最新状态", pulled: "已安全获取另一台设备的更新", pushed: "本机待同步提交已推送" })[result.state] || "同步完成");
    await refreshMemories();
  } catch (error) { showToast(error.message); }
}

async function refreshStatus() {
  try {
    if (state.bootstrap?.localDevice) {
      state.bootstrap = await api("/api/bootstrap");
      renderAccessCard();
    }
    const status = await api("/api/status");
    renderCodexUsage(status.codexUsage);
    $("#header-dot").classList.toggle("online", status.napCatConnected);
    $("#header-status").textContent = status.napCatConnected ? "已连接" : "未连接";
    const rows = [
      ["Bridge", status.webUiOnline ? "运行中" : "不可用"],
      ["NapCat", status.napCatConnected ? "已连接" : "未连接"],
      ["Codex", status.codexAvailable ? "只读可用" : "不可用"],
      ["当前任务", status.taskRunning ? "运行中" : "空闲"],
      ["记忆库", status.memoryAvailable ? `${status.memoryCount} 条` : "不可用"],
      ["设备访问", status.mobileAccess ? "局域网已启用" : "仅本机"],
    ];
    const grid = $("#status-grid");
    grid.replaceChildren();
    for (const [label, value] of rows) {
      const card = document.createElement("article");
      card.className = "status-card";
      const labelNode = document.createElement("span");
      labelNode.textContent = label;
      const valueNode = document.createElement("strong");
      valueNode.textContent = value;
      card.append(labelNode, valueNode);
      grid.append(card);
    }
  } catch (error) {
    $("#header-status").textContent = "连接失败";
    showToast(error.message);
  }
}

function renderCodexUsage(usage) {
  const renderWindow = (prefix, window) => {
    const value = $(`#usage-${prefix}`);
    const progress = $(`#usage-${prefix}-progress`);
    const reset = $(`#usage-${prefix}-reset`);
    if (!window) {
      value.textContent = "暂不可用";
      progress.style.width = "0%";
      reset.textContent = "重置时间：Codex 暂未返回";
      return;
    }
    value.textContent = `剩余 ${window.remainingPercent}%`;
    progress.style.width = `${window.remainingPercent}%`;
    reset.textContent = `重置时间：${formatBeijingTimestamp(window.resetsAt)}`;
  };

  renderWindow("five-hour", usage?.fiveHour);
  renderWindow("weekly", usage?.weekly);
  $("#usage-updated-at").textContent = usage
    ? `更新于 ${formatBeijingTimestamp(Math.floor(usage.fetchedAt / 1000))}`
    : "暂时没能从 Codex 取得限额";
}

function formatBeijingTimestamp(epochSeconds) {
  if (!epochSeconds) return "暂未提供";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  }).format(new Date(epochSeconds * 1000));
}

function renderAccessCard() {
  const card = $("#access-card");
  card.hidden = false;
  $("#password-state").textContent = state.bootstrap.passwordConfigured ? "已设置" : "未设置";
  const urls = $("#lan-urls");
  urls.replaceChildren();
  for (const value of state.bootstrap.lanUrls || []) {
    const item = document.createElement("div");
    item.className = "lan-url";
    item.textContent = value;
    urls.append(item);
  }
}

function switchTab(name) {
  closeConversationSidebar();
  for (const panel of document.querySelectorAll(".tab-panel")) {
    const active = panel.id === `tab-${name}`;
    panel.hidden = !active;
    panel.classList.toggle("active", active);
  }
  for (const button of document.querySelectorAll(".nav-item")) button.classList.toggle("active", button.dataset.tab === name);
  if (name === "status") void refreshStatus();
  if (name === "memory") void refreshMemories();
  if (name === "settings") { void refreshSettings(); void refreshWorkspace(); }
  if (name === "personas") renderPersonas();
}

async function refreshSettings() {
  try {
    const settings = await api("/api/settings");
    state.settings = settings;
    $("#local-settings").hidden = false;
    $("#current-password").hidden = settings.localAdmin;
    $("#current-password").required = !settings.localAdmin;
    $("#trusted-device-count").textContent = String(settings.trustedDeviceCount);
    try {
      const { models } = await api("/api/models");
      const modelSelect = $("#codex-model");
      const effortSelect = $("#codex-reasoning-effort");
      if (models.length > 0) {
        modelSelect.innerHTML = models
          .map((m) => `<option value="${m.slug}">${m.displayName}</option>`)
          .join("");
        modelSelect._modelsData = models;
        modelSelect.addEventListener("change", () => updateReasoningOptions(modelSelect, effortSelect));
      }
      if (settings.model) modelSelect.value = settings.model;
      updateReasoningOptions(modelSelect, effortSelect);
      if (settings.reasoningEffort) effortSelect.value = settings.reasoningEffort;
    } catch { /* 保留 HTML 里的兜底选项 */ }
    try {
      const { plugins } = await api("/api/plugins");
      renderPluginList(plugins);
    } catch { /* 忽略：插件管理不可用时保持空列表 */ }
    $("#message-buffer-seconds").value = String(settings.messageBuffer?.waitSeconds ?? 10);
    $("#memory-directory").readOnly = false;
    $("#memory-path-form button[type=submit]").disabled = false;
    $("#memory-path-note").textContent = "这里填写的是云服务器路径；目录必须位于 Bridge 私有工作区内，并包含现有的私人 memory-repo。";
    void refreshSoftwareUpdate();
  } catch (error) { showToast(error.message); }
}

function renderPluginList(plugins) {
  const list = $("#plugin-list");
  list.replaceChildren();
  if (!plugins || plugins.length === 0) {
    const empty = document.createElement("p");
    empty.className = "muted";
    empty.textContent = "暂无已安装插件。";
    list.append(empty);
    return;
  }
  for (const plugin of plugins) {
    const row = document.createElement("article");
    row.className = "plugin-item";
    const main = document.createElement("div");
    const title = document.createElement("strong");
    title.textContent = `${plugin.name}（v${plugin.version}）`;
    const desc = document.createElement("p");
    desc.className = "muted";
    desc.textContent = plugin.description || "";
    main.append(title, desc);
    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.checked = plugin.enabled;
    toggle.addEventListener("change", async () => {
      try {
        await api("/api/settings/plugin", {
          method: "POST",
          body: { id: plugin.id, enabled: toggle.checked },
        });
        showToast(`${plugin.name} ${toggle.checked ? "已启用" : "已禁用"}`);
      } catch (error) {
        toggle.checked = !toggle.checked; // 回滚
        showToast(error.message);
      }
    });
    row.append(main, toggle);
    list.append(row);
  }
}

async function refreshSoftwareUpdate(force = false) {
  const checkButton = $("#check-update");
  checkButton.disabled = true;
  checkButton.textContent = "正在检查…";
  try {
    const status = await api(`/api/update/status${force ? "?force=1" : ""}`);
    state.softwareUpdate = status;
    renderSoftwareUpdate();
    if (force) showToast(status.message);
    return status;
  } catch (error) {
    state.softwareUpdate = null;
    $("#update-message").textContent = error.message;
    $("#update-badge").textContent = "不可用";
    $("#apply-update").hidden = true;
    $("#nav-settings").classList.remove("has-update");
    if (force) showToast(error.message);
    return null;
  } finally {
    checkButton.disabled = false;
    checkButton.textContent = "检查更新";
  }
}

function renderSoftwareUpdate() {
  const status = state.softwareUpdate;
  if (!status) return;
  $("#update-current-version").textContent = `v${status.currentVersion}`;
  $("#update-latest-version").textContent = status.latestVersion ? `v${status.latestVersion}` : "尚未发布";
  $("#update-message").textContent = status.message;
  $("#update-badge").textContent = status.updateAvailable
    ? "有新版本"
    : status.latestVersion
      ? "已是最新"
      : "尚未发布";
  $("#update-badge").classList.toggle("update-available", status.updateAvailable);
  $("#nav-settings").classList.toggle("has-update", status.updateAvailable);
  const applyButton = $("#apply-update");
  applyButton.hidden = !status.canApply;
  applyButton.textContent = status.latestVersion ? `更新到 v${status.latestVersion}` : "一键更新";
  const releaseLink = $("#update-release-link");
  releaseLink.hidden = !status.releaseUrl;
  releaseLink.href = status.releaseUrl || "#";
  const notes = $("#update-release-notes");
  notes.hidden = !status.releaseNotes;
  notes.textContent = status.releaseNotes || "";
  const lastRun = $("#update-last-run");
  if (status.lastRun) {
    lastRun.hidden = false;
    lastRun.textContent = formatLastRun(status.lastRun);
    lastRun.classList.toggle("update-failed", status.lastRun.state === "failed");
  } else {
    lastRun.hidden = true;
  }
}

function formatLastRun(run) {
  const labels = {
    checking: "检查中",
    downloading: "下载中",
    installing: "安装中",
    succeeded: "成功",
    current: "已是最新",
    failed: "失败",
  };
  const label = labels[run.state] || run.state;
  const version = run.version ? ` → v${run.version}` : "";
  const detail = run.message ? `：${run.message}` : "";
  let when = "";
  if (run.updatedAt) {
    const parsed = new Date(run.updatedAt);
    if (!Number.isNaN(parsed.getTime())) when = `（${parsed.toLocaleString()}）`;
  }
  return `上次更新：${label}${version}${detail}${when}`;
}

function confirmSoftwareUpdate() {
  const status = state.softwareUpdate;
  if (!status?.canApply || !status.latestVersion) return;
  openDialog(
    "安装软件更新",
    `将更新到 v${status.latestVersion}。Bridge 会短暂离线，更新器会保留全部用户数据并在完成后自动重启。`,
    async () => {
      const applyButton = $("#apply-update");
      applyButton.disabled = true;
      applyButton.textContent = "正在启动更新…";
      try {
        const result = await api("/api/update/apply", { method: "POST", body: {} });
        $("#update-message").textContent = result.message;
        showToast(result.message);
        window.setTimeout(waitForBridgeRestart, 4_000);
      } catch (error) {
        applyButton.disabled = false;
        renderSoftwareUpdate();
        showToast(error.message);
      }
    },
  );
}

function confirmBridgeRestart() {
  openDialog(
    "重启 Bridge",
    "Bridge 会短暂离线，通常几十秒内恢复。正在运行的任务会被中断。",
    async () => {
      const button = $("#restart-bridge");
      button.disabled = true;
      try {
        const result = await api("/api/system/restart", { method: "POST", body: {} });
        showToast(result.message);
        window.setTimeout(waitForBridgeRestart, 2_500);
      } catch (error) {
        button.disabled = false;
        showToast(error.message);
      }
    },
  );
}

async function waitForBridgeRestart() {
  const deadline = Date.now() + 3 * 60_000;
  while (Date.now() < deadline) {
    try {
      const response = await fetch("/api/bootstrap", { cache: "no-store", credentials: "same-origin" });
      if (response.ok) {
        window.location.reload();
        return;
      }
    } catch { /* Bridge 正在替换文件并重启。 */ }
    await new Promise((resolve) => window.setTimeout(resolve, 2_000));
  }
  $("#update-message").textContent = "自动重连超时；请刷新页面或在服务器运行状态检查。";
  showToast("更新后自动重连超时，请稍后刷新页面");
}

function updateReasoningOptions(modelSelect, effortSelect) {
  const models = modelSelect._modelsData;
  if (!models) return;
  const current = models.find((m) => m.slug === modelSelect.value);
  if (!current || !current.supportedReasoningLevels?.length) return;
  const effortLabels = { low: "低", medium: "中", high: "高", xhigh: "超高" };
  const prev = effortSelect.value;
  effortSelect.innerHTML = current.supportedReasoningLevels
    .map((r) => `<option value="${r.effort}">${effortLabels[r.effort] ?? r.effort}</option>`)
    .join("");
  if ([...effortSelect.options].some((o) => o.value === prev)) effortSelect.value = prev;
  else effortSelect.value = current.defaultReasoningLevel ?? "medium";
}

async function updateModelSetting(event) {
  event.preventDefault();
  const model = $("#codex-model").value;
  const effort = $("#codex-reasoning-effort").value;
  try {
    await Promise.all([
      api("/api/settings/model", { method: "POST", body: { model } }),
      api("/api/settings/reasoning-effort", { method: "POST", body: { effort } }),
    ]);
    showToast(`模型已切换为 ${model}，推理等级：${effort}`);
  } catch (error) { showToast(error.message); }
}

async function updateStorageLimit(event) {
  event.preventDefault();
  try {
    await api("/api/settings/storage", { method: "POST", body: { storageLimitMb: Number($("#storage-limit").value) } });
    await refreshWorkspace();
    showToast("聊天记录容量上限已保存");
  } catch (error) { showToast(error.message); }
}

async function updateMessageBufferSettings(event) {
  event.preventDefault();
  const waitSeconds = Number($("#message-buffer-seconds").value);
  try {
    await api("/api/settings/message-buffer", {
      method: "POST",
      body: { waitSeconds },
    });
    showToast(waitSeconds === 0 ? "QQ 消息合并已关闭" : `QQ 消息将在静默 ${waitSeconds} 秒后合并发送`);
  } catch (error) { showToast(error.message); }
}

function collectMemorySettings() {
  return {
    mode: $("#memory-mode-manual").checked ? "manual" : "automatic",
    onConversationSwitch: $("#memory-on-switch").checked,
    onTokenThreshold: $("#memory-on-token").checked,
    tokenThreshold: Number($("#memory-token-threshold").value),
    onSchedule: $("#memory-on-schedule").checked,
    timezone: $("#memory-timezone").value.trim(),
    time: $("#memory-time").value,
    memoryDirectory: $("#memory-directory").value.trim(),
  };
}

async function updateMemorySettings(event) {
  event.preventDefault();
  try {
    await api("/api/settings/memory", { method: "POST", body: collectMemorySettings() });
    await refreshWorkspace();
    showToast("记忆方式和自动整理条件已保存");
  } catch (error) { showToast(error.message); }
}

async function updateMemoryPath(event) {
  event.preventDefault();
  try {
    const result = await api("/api/settings/memory", { method: "POST", body: collectMemorySettings() });
    $("#memory-directory").value = result.memoryDirectory;
    await Promise.all([refreshWorkspace(), refreshMemories()]);
    showToast("记忆储存路径已更新，后续记忆将使用这个目录");
  } catch (error) { showToast(error.message); }
}

async function updatePassword(event) {
  event.preventDefault();
  const currentPassword = $("#current-password").value;
  const password = $("#new-password").value;
  if (password !== $("#confirm-password").value) return showToast("两次输入的密码不一致");
  try {
    await api("/api/settings/password", { method: "POST", body: { currentPassword, password } });
    $("#current-password").value = $("#new-password").value = $("#confirm-password").value = "";
    showToast("密码已更新，全部远程设备需要重新登录");
    state.bootstrap = await api("/api/bootstrap");
    renderAccessCard();
    await refreshSettings();
  } catch (error) { showToast(error.message); }
}

function revokeDevices() {
  openDialog("撤销全部远程设备", "所有手机、平板和其他电脑都需要重新输入密码。本机免密管理不受影响。", async () => {
    try {
      await api("/api/settings/revoke", { method: "POST", body: {} });
      showToast("全部远程设备已撤销");
      if (!state.settings?.localAdmin) {
        showLogin("当前设备已撤销，请重新输入管理密码。");
        return;
      }
      await refreshSettings();
    } catch (error) { showToast(error.message); }
  });
}

function setBusy(value) {
  state.busy = value;
  $("#send-task").disabled = value || Boolean(state.workspace?.capacity?.full);
  $("#stop-task").hidden = !value;
  $("#chat-input").disabled = value || Boolean(state.workspace?.capacity?.full);
}

function appendMessageNode(role, text, scroll = true) {
  const welcome = $("#messages .welcome-state");
  if (welcome) welcome.remove();
  const article = document.createElement("article");
  article.className = `message ${role}`;
  const avatar = document.createElement("div");
  avatar.className = "avatar";
  avatar.textContent = role === "user" ? "你" : role === "assistant" ? "B" : "!";
  const paragraph = document.createElement("p");
  paragraph.textContent = text;
  article.append(avatar, paragraph);
  $("#messages").append(article);
  if (scroll) article.scrollIntoView({ behavior: "smooth", block: "end" });
}

function openDialog(title, content, onConfirm, onCancel = null) {
  $("#dialog-title").textContent = title;
  $("#dialog-content").textContent = content;
  state.confirmAction = onConfirm;
  state.cancelAction = onCancel;
  actionDialog.showModal();
}

async function cancelMemoryDraft() {
  try { await api("/api/memory/cancel", { method: "POST", body: {} }); } catch { /* 草稿只在服务内存中。 */ }
}

function button(text, className, action) {
  const element = document.createElement("button");
  element.type = "button";
  element.className = className;
  element.textContent = text;
  element.addEventListener("click", action);
  return element;
}

function showToast(message) {
  toast.textContent = message;
  toast.hidden = false;
  clearTimeout(showToast.timer);
  showToast.timer = setTimeout(() => { toast.hidden = true; }, 3400);
}

function sensitiveNotice(facts) {
  const actions = {
    change_password_at_source: "请立即回到原服务修改密码。",
    revoke_and_replace_at_source: "请立即到原平台撤销并重新生成凭证。",
    invalidate_sessions_and_reauthenticate: "请注销相关会话并重新登录。",
    let_code_expire_and_do_not_reuse: "请等待验证码失效，不要再次使用。",
    revoke_and_replace_keypair: "请立即撤销并更换密钥对。",
    do_not_send_again: "请不要再次发送这类身份信息。",
  };
  return `这段内容被挡在任务和本地记录之外，没有保存。${actions[facts.recommendedAction] || "请在信息来源处自行处理。"}`;
}

function categoryLabel(category) {
  return ({ preference: "偏好", person: "人物", project: "项目", event: "事件", rule: "规则" })[category] || "记忆";
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) return `${Math.max(0, bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function formatShortDate(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "刚刚";
  return new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
}

async function api(path, options = {}) {
  const init = { method: options.method || "GET", credentials: "same-origin", headers: {} };
  if (options.body !== undefined) {
    init.headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(options.body);
  }
  const response = await fetch(path, init);
  let payload;
  try { payload = await response.json(); } catch { payload = { error: "服务返回了无法识别的内容。" }; }
  if (!response.ok && !(options.acceptStatuses || []).includes(response.status)) {
    if (response.status === 401) showLogin();
    const error = new Error(payload.error || "请求失败。");
    error.payload = payload;
    error.status = response.status;
    throw error;
  }
  return payload;
}
