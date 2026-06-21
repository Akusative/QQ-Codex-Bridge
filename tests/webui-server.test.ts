import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentAdapter, AgentRunOptions } from "../src/agent/agent-adapter.js";
import type { MemoryCandidate } from "../src/memory/memory-commands.js";
import type {
  ApprovedMemoryEntry,
  MemoryListEntry,
} from "../src/memory/memory-repository.js";
import {
  WebUiServer,
  isLocalAdminAddress,
  isWebUiRemoteAddressAllowed,
  type WebUiMemoryStore,
} from "../src/webui/webui-server.js";
import { BridgeWorkspaceStore } from "../src/workspace/bridge-workspace-store.js";
import type { SoftwareUpdateController } from "../src/update/github-update-service.js";
import type { BridgeSystemController } from "../src/system/windows-system-control.js";

class FakeAgent implements AgentAdapter {
  runs: AgentRunOptions[] = [];

  async checkAvailable() {
    return { ok: true, detail: "available" };
  }

  async run(options: AgentRunOptions) {
    this.runs.push(options);
    return { ok: true, output: "WEBUI_OK" };
  }

  async cancel() {
    return false;
  }

  isBusy() {
    return false;
  }
}

class FakeMemoryStore implements WebUiMemoryStore {
  constructor(private root: string) {}

  entries: ApprovedMemoryEntry[] = [
    {
      relativePath: "approved/preference.memory.md",
      title: "优先使用简体中文",
      category: "preference",
      updatedAt: "2026-06-19T00:00:00.000Z",
      summary: "回复时优先使用简体中文。",
    },
  ];
  added: MemoryCandidate[] = [];

  async list(): Promise<MemoryListEntry[]> {
    return this.entries;
  }

  async add(candidate: MemoryCandidate) {
    this.added.push(candidate);
    return { synced: true };
  }

  async remove() {
    return { synced: true };
  }

  async sync() {
    return { state: "up-to-date" as const };
  }

  async readApprovedMemories() {
    return this.entries;
  }

  getRoot() {
    return this.root;
  }

  async switchRoot(root: string) {
    this.root = root;
  }
}

const servers: WebUiServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.stop()));
});

async function createFixture(options: {
  softwareUpdate?: SoftwareUpdateController;
  systemControl?: BridgeSystemController;
} = {}) {
  const staticRoot = await mkdtemp(join(tmpdir(), "bridge-webui-"));
  await Promise.all([
    writeFile(join(staticRoot, "index.html"), "<!doctype html><title>Bridge</title>"),
    writeFile(join(staticRoot, "app.js"), "void 0;"),
    writeFile(join(staticRoot, "styles.css"), "body{}"),
  ]);
  const agent = new FakeAgent();
  const memoryRepository = new FakeMemoryStore(join(staticRoot, "memory-repo"));
  const workspaceStore = new BridgeWorkspaceStore(join(staticRoot, "bridge-data"), {
    qq: "10001",
    nickname: "测试机器人",
  });
  await workspaceStore.initialize();
  const server = new WebUiServer({
    host: "127.0.0.1",
    port: 0,
    sessionTtlMs: 60_000,
    pairingTtlMs: 60_000,
    staticRoot,
    authStorePath: join(staticRoot, "webui-auth.json"),
    logger: pino({ level: "silent" }),
    agent,
    memoryRepository,
    allowedWorkspaceRoot: staticRoot,
    workdir: "F:\\AI\\codex\\bridge\\workspace",
    taskTimeoutMs: 1_000,
    getStatus: async () => ({
      napCatConnected: true,
      codexAvailable: true,
      taskRunning: false,
      memoryCount: memoryRepository.entries.length,
      memoryAvailable: true,
      codexUsage: {
        fetchedAt: Date.UTC(2026, 5, 20, 8, 0, 0),
        fiveHour: {
          usedPercent: 20,
          remainingPercent: 80,
          resetsAt: 1_800_000_000,
          windowDurationMins: 300,
        },
        weekly: {
          usedPercent: 35,
          remainingPercent: 65,
          resetsAt: 1_800_500_000,
          windowDurationMins: 10_080,
        },
      },
    }),
    workspaceStore,
    softwareUpdate: options.softwareUpdate,
    systemControl: options.systemControl,
  });
  await server.start();
  servers.push(server);
  const baseUrl = `http://127.0.0.1:${server.address().port}`;
  return { server, baseUrl, agent, memoryRepository, workspaceStore };
}

async function bootstrap(baseUrl: string) {
  const response = await fetch(`${baseUrl}/api/bootstrap`);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
  return { response, cookie, body: await response.json() as Record<string, unknown> };
}

function post(baseUrl: string, path: string, cookie: string, body: unknown, origin = baseUrl) {
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      Cookie: cookie,
      Origin: origin,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
}

describe("WebUiServer", () => {
  it("serves only same-origin assets with strict browser security headers", async () => {
    const { baseUrl } = await createFixture();
    const response = await fetch(baseUrl);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-security-policy")).toContain("default-src 'self'");
    expect(response.headers.get("x-frame-options")).toBe("DENY");
    expect(response.headers.get("cache-control")).toBe("no-store");
  });

  it("auto-authenticates loopback with an HttpOnly strict cookie", async () => {
    const { baseUrl } = await createFixture();
    const { response, body } = await bootstrap(baseUrl);
    expect(body.authenticated).toBe(true);
    expect(body.localDevice).toBe(true);
    expect(body.passwordConfigured).toBe(false);
    expect(response.headers.get("set-cookie")).toContain("HttpOnly");
    expect(response.headers.get("set-cookie")).toContain("SameSite=Strict");
  });

  it("does not grant local admin to a reverse-proxied tailnet host", () => {
    expect(isLocalAdminAddress("127.0.0.1", "bridge.example.ts.net")).toBe(false);
    expect(isLocalAdminAddress("127.0.0.1", "127.0.0.1:3080")).toBe(true);
    expect(isLocalAdminAddress("::1", "localhost:3080")).toBe(true);
  });

  it("keeps public addresses blocked unless the operator delegates filtering to the firewall", () => {
    expect(isWebUiRemoteAddressAllowed("203.0.113.10")).toBe(false);
    expect(isWebUiRemoteAddressAllowed("192.168.1.20")).toBe(true);
    expect(isWebUiRemoteAddressAllowed("100.100.10.20")).toBe(true);
    expect(isWebUiRemoteAddressAllowed("203.0.113.10", true)).toBe(true);
  });

  it("lets an authenticated remote administrator change the password after reauthentication", async () => {
    const { baseUrl } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const changed = await post(baseUrl, "/api/settings/password", cookie, {
      password: "test-only-long-passphrase",
    });
    expect(changed.status).toBe(200);

    const login = await post(baseUrl, "/api/login", "", {
      password: "test-only-long-passphrase",
    });
    expect(login.status).toBe(200);
    const remoteCookie = login.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    const remoteSettings = await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: remoteCookie },
    });
    expect(await remoteSettings.json()).toMatchObject({
      localAdmin: false,
      passwordConfigured: true,
    });
    const rejected = await post(baseUrl, "/api/settings/password", remoteCookie, {
      password: "another-test-passphrase",
    });
    expect(rejected.status).toBe(401);
    const remoteChange = await post(baseUrl, "/api/settings/password", remoteCookie, {
      currentPassword: "test-only-long-passphrase",
      password: "another-test-passphrase",
    });
    expect(remoteChange.status).toBe(200);
    const refreshedCookie = remoteChange.headers.get("set-cookie")?.split(";", 1)[0] ?? "";
    expect(refreshedCookie).toContain("bridge_session=");
    expect((await fetch(`${baseUrl}/api/settings`, {
      headers: { Cookie: refreshedCookie },
    })).status).toBe(200);
  });

  it("checks and starts a verified software update through authenticated WebUI routes", async () => {
    let starts = 0;
    const softwareUpdate: SoftwareUpdateController = {
      status: async () => ({
        repository: "Akusative/QQ-Codex-Bridge",
        currentVersion: "0.1.0",
        latestVersion: "0.2.0",
        updateAvailable: true,
        canApply: true,
        releaseUrl: "https://github.com/Akusative/QQ-Codex-Bridge/releases/tag/v0.2.0",
        lastCheckedAt: "2026-06-20T00:00:00.000Z",
        message: "发现可安装的新版本。",
      }),
      startUpdate: async () => {
        starts += 1;
        return { version: "0.2.0", message: "更新程序已启动。" };
      },
      localStatus: async () => ({
        state: "succeeded",
        message: "Update installed successfully.",
        version: "0.2.0",
        updatedAt: "2026-06-20T00:01:00.000Z",
      }),
    };
    const { baseUrl } = await createFixture({ softwareUpdate });
    const { cookie } = await bootstrap(baseUrl);

    const status = await fetch(`${baseUrl}/api/update/status?force=1`, { headers: { Cookie: cookie } });
    expect(status.status).toBe(200);
    expect(await status.json()).toMatchObject({
      updateAvailable: true,
      canApply: true,
      lastRun: { state: "succeeded", version: "0.2.0" },
    });
    const apply = await post(baseUrl, "/api/update/apply", cookie, {});
    expect(apply.status).toBe(202);
    expect(starts).toBe(1);
  });

  it("restarts the Bridge through an authenticated WebUI route", async () => {
    let restarts = 0;
    const systemControl: BridgeSystemController = {
      restart: async () => {
        restarts += 1;
        return { message: "restart scheduled" };
      },
    };
    const { baseUrl } = await createFixture({ systemControl });
    const { cookie } = await bootstrap(baseUrl);
    const response = await post(baseUrl, "/api/system/restart", cookie, {});
    expect(response.status).toBe(202);
    expect(restarts).toBe(1);
  });

  it("saves memory mode, automatic triggers and a private workspace memory path", async () => {
    const { baseUrl, workspaceStore, memoryRepository } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const alternate = join(memoryRepository.getRoot(), "alternate");
    const response = await post(baseUrl, "/api/settings/memory", cookie, {
      mode: "automatic",
      onConversationSwitch: true,
      onTokenThreshold: true,
      tokenThreshold: 120000,
      onSchedule: true,
      timezone: "UTC+8",
      time: "00:00",
      memoryDirectory: alternate,
    });
    expect(response.status).toBe(200);
    expect(await workspaceStore.memorySettings()).toMatchObject({
      mode: "automatic",
      onConversationSwitch: true,
      onTokenThreshold: true,
      tokenThreshold: 120000,
      onSchedule: true,
      timezone: "UTC+8",
      time: "00:00",
      memoryDirectory: alternate,
    });
    expect(memoryRepository.getRoot()).toBe(alternate);
  });

  it("reads and updates the local QQ message buffer wait time", async () => {
    const { baseUrl, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const settings = await fetch(`${baseUrl}/api/settings`, { headers: { Cookie: cookie } });
    expect(await settings.json()).toMatchObject({ messageBuffer: { waitSeconds: 10 } });

    const updated = await post(baseUrl, "/api/settings/message-buffer", cookie, {
      waitSeconds: 3,
    });
    expect(updated.status).toBe(200);
    expect(await workspaceStore.messageBufferSettings()).toEqual({ waitSeconds: 3 });
    const rejected = await post(baseUrl, "/api/settings/message-buffer", cookie, {
      waitSeconds: 121,
    });
    expect(rejected.status).toBe(400);
  });

  it("rejects unauthenticated API calls and cross-origin writes", async () => {
    const { baseUrl } = await createFixture();
    expect((await fetch(`${baseUrl}/api/status`)).status).toBe(401);
    const { cookie } = await bootstrap(baseUrl);
    const response = await post(baseUrl, "/api/chat", cookie, { message: "你好" }, "http://example.invalid");
    expect(response.status).toBe(403);
  });

  it("returns Codex rate-limit usage to an authenticated status view", async () => {
    const { baseUrl } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const response = await fetch(`${baseUrl}/api/status`, { headers: { Cookie: cookie } });
    expect(response.status).toBe(200);
    const body = await response.json() as any;
    expect(body.codexUsage.fiveHour.remainingPercent).toBe(80);
    expect(body.codexUsage.weekly.remainingPercent).toBe(65);
  });

  it("blocks sensitive text before the agent receives it", async () => {
    const { baseUrl, agent, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const response = await post(baseUrl, "/api/chat", cookie, {
      message: "password=example-only-value",
    });
    expect(response.status).toBe(422);
    const body = await response.json() as { type: string; facts: { contentWasPersisted: boolean } };
    expect(body.type).toBe("sensitive-blocked");
    expect(body.facts.contentWasPersisted).toBe(false);
    expect(agent.runs).toHaveLength(0);
    expect((await workspaceStore.snapshot() as any).conversations).toHaveLength(0);
  });

  it("manages local personas and account-scoped conversations through the WebUI API", async () => {
    const { baseUrl, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const saved = await post(baseUrl, "/api/personas/save", cookie, {
      category: "项目",
      name: "清晰助手",
      content: "优先给出可执行结论。",
    });
    expect(saved.status).toBe(200);
    const persona = (await saved.json() as any).persona;
    expect((await post(baseUrl, "/api/personas/select", cookie, { id: persona.id })).status).toBe(200);
    const uploaded = await post(baseUrl, "/api/personas/documents/upload", cookie, {
      personaId: persona.id,
      name: "character.md",
      dataBase64: Buffer.from("遇到复杂问题时，先给出结论。", "utf8").toString("base64"),
    });
    expect(uploaded.status).toBe(200);
    const document = (await uploaded.json() as any).document;
    const readDocument = await post(baseUrl, "/api/personas/documents/read", cookie, {
      personaId: persona.id,
      documentId: document.id,
    });
    expect((await readDocument.json() as any).text).toContain("先给出结论");
    const updated = await post(baseUrl, "/api/personas/documents/update", cookie, {
      personaId: persona.id,
      documentId: document.id,
      text: "更新后先分段，再给出结论。",
    });
    expect(updated.status).toBe(200);
    expect((await workspaceStore.readPersonaDocument(persona.id, document.id)).text).toBe("更新后先分段，再给出结论。");
    expect((await post(baseUrl, "/api/conversations/create", cookie, {})).status).toBe(200);

    const snapshot = await workspaceStore.snapshot() as any;
    expect(snapshot.personas).toHaveLength(1);
    expect(snapshot.personas[0].documents).toHaveLength(1);
    expect(snapshot.activePersona.name).toBe("清晰助手");
    expect(snapshot.conversations).toHaveLength(1);
    expect(snapshot.conversations[0].personaName).toBe("清晰助手");
  });

  it("blocks credentials in persona content before local persistence", async () => {
    const { baseUrl, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const response = await post(baseUrl, "/api/personas/save", cookie, {
      category: "测试",
      name: "不安全人设",
      content: "password=example-only-value",
    });
    expect(response.status).toBe(422);
    expect((await workspaceStore.snapshot() as any).personas).toHaveLength(0);
  });

  it("blocks credentials extracted from an uploaded persona document", async () => {
    const { baseUrl, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const saved = await post(baseUrl, "/api/personas/save", cookie, {
      category: "测试",
      name: "文档人设",
      content: "",
    });
    const persona = (await saved.json() as any).persona;
    const response = await post(baseUrl, "/api/personas/documents/upload", cookie, {
      personaId: persona.id,
      name: "unsafe.txt",
      dataBase64: Buffer.from("password=example-only-value", "utf8").toString("base64"),
    });
    expect(response.status).toBe(422);
    expect((await workspaceStore.snapshot() as any).personas[0].documents).toHaveLength(0);
  });

  it("allows locally edited persona text to contain credential-like examples", async () => {
    const { baseUrl, workspaceStore } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const saved = await post(baseUrl, "/api/personas/save", cookie, {
      category: "测试",
      name: "可编辑人设",
      content: "",
    });
    const persona = (await saved.json() as any).persona;
    const document = await workspaceStore.addPersonaDocument(persona.id, {
      name: "profile.md",
      sourceSizeBytes: 16,
      text: "原始安全内容。",
    });

    const response = await post(baseUrl, "/api/personas/documents/update", cookie, {
      personaId: persona.id,
      documentId: document.id,
      text: "password=example-only-value",
    });

    expect(response.status).toBe(200);
    expect((await workspaceStore.readPersonaDocument(persona.id, document.id)).text).toBe("password=example-only-value");
  });

  it("stages high-risk tasks and only runs after explicit confirmation", async () => {
    const { baseUrl, agent } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const staged = await post(baseUrl, "/api/chat", cookie, { message: "检查删除文件是否可行" });
    expect(staged.status).toBe(202);
    expect(agent.runs).toHaveLength(0);
    const confirmed = await post(baseUrl, "/api/chat/confirm", cookie, {});
    expect(confirmed.status).toBe(200);
    expect(agent.runs).toHaveLength(1);
  });

  it("previews memory without writing and writes only after confirmation", async () => {
    const { baseUrl, memoryRepository } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const draft = await post(baseUrl, "/api/memory/draft", cookie, {
      content: "偏好：回复时使用短句",
    });
    expect(draft.status).toBe(200);
    expect(memoryRepository.added).toHaveLength(0);
    const confirmed = await post(baseUrl, "/api/memory/confirm", cookie, {});
    expect(confirmed.status).toBe(200);
    expect(memoryRepository.added).toHaveLength(1);
  });

  it("returns a client error for malformed JSON instead of leaking details", async () => {
    const { baseUrl } = await createFixture();
    const { cookie } = await bootstrap(baseUrl);
    const response = await fetch(`${baseUrl}/api/chat`, {
      method: "POST",
      headers: { Cookie: cookie, Origin: baseUrl, "Content-Type": "application/json" },
      body: "{not-json",
    });
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "请求格式不正确。" });
  });
});
