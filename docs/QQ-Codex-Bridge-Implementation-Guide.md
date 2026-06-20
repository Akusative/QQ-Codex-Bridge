# QQ 版 Cyberboss：本地 Codex Agent 桥接实施文档

> 项目讨论、已确认决策与隐私边界统一记录在 [讨论与决策记录.md](./讨论与决策记录.md)。真实实施过程与验证结果记录在 [实施日志.md](./实施日志.md)。实施前应同时阅读这两个文件。

> 给 Codex 的任务说明。请先阅读完整文档，再开始修改文件。  
> 目标：在 Windows 本地搭建一个最小可用的 QQ 桥接层，使指定 QQ 小号能够通过 QQ 私聊遥控本机 Codex，并接收 Codex 主动推送的执行结果、提醒、文本和文件。  
> 本项目不是 AstrBot 插件，不调用远程聊天 API 充当主脑。核心 Agent 必须是本机 Codex CLI。

---

## 0. 开工规则

请严格遵守以下规则：

1. 先检查环境，再写代码。不要假设 Node.js、Codex CLI、NapCatQQ 或 QQ 登录状态已经正确。
2. 先做 MVP，不要一开始复刻完整 Cyberboss。优先打通：
   - QQ 私聊消息进入本地桥接层；
   - 白名单用户发送文本指令；
   - 桥接层调用本机 Codex CLI；
   - 将 Codex 的最终回复发回 QQ；
   - 本地命令可以主动向 QQ 推送消息；
   - 能向 QQ 发送本地文件。
3. 默认只监听私聊，只允许一个白名单 QQ 号。群聊、多人、多 Agent、长期记忆、随机催促，放到第二阶段。
4. 所有服务默认仅监听 `127.0.0.1`，不要开放公网端口。
5. 不要读取或上传无关文件，不要把 QQ 消息、Codex 输出、环境变量或访问令牌发送到任何第三方服务。
6. 不要使用主 QQ 号测试。项目默认面向专门的小号。
7. 每完成一个阶段，先运行测试并汇报结果，再继续下一阶段。
8. 遇到不确定的 NapCatQQ 配置项时，优先查看本机 NapCatQQ 配置页面和当前版本文档，不要凭记忆硬写。

---

## 1. 项目定位

### 1.1 要解决的问题

用户希望在离开电脑时，用 QQ 私聊控制本机 Codex：

```text
用户手机 QQ
   ↓
QQ 小号
   ↓
NapCatQQ
   ↓ OneBot v11 WebSocket / HTTP
本地 QQ Bridge
   ↓
Codex CLI
   ↓
本地项目、文件系统、终端任务
```

Codex 执行完成后，桥接层把最终结果、错误信息、文件路径或生成文件推回 QQ。

### 1.2 明确排除

以下内容不属于第一阶段：

- AstrBot；
- OpenAI API、Claude API 或其他远程模型 API；
- 将 QQ 作为公开机器人服务；
- 群聊机器人；
- 多用户权限系统；
- 自动联网搜索；
- 自动执行高风险命令；
- 完整复刻 Cyberboss 的随机唤醒、时间线、日记和人格系统。

---

## 2. 推荐技术方案

### 2.1 QQ 协议端

使用：

```text
NapCatQQ + OneBot v11
```

NapCatQQ 负责：

- 登录专用 QQ 小号；
- 接收 QQ 私聊消息；
- 将消息事件通过 OneBot v11 推送给本地桥接层；
- 接收桥接层发出的 OneBot v11 动作请求；
- 向用户 QQ 发送文本和文件。

### 2.2 本地桥接层

使用：

```text
Node.js 22+
TypeScript
WebSocket
HTTP
```

建议第一阶段采用：

- WebSocket：接收 NapCatQQ 推送的 OneBot v11 消息事件；
- HTTP：调用 NapCatQQ 的 OneBot v11 动作接口，发送私聊消息和文件；
- 子进程：调用本机 `codex` CLI；
- JSON 文件：保存最小状态；
- 日志文件：保存可排查日志。

不要引入数据库。MVP 阶段使用本地 JSON 即可。

### 2.3 Codex 调用原则

优先检查本机 `codex --help`，确认当前 CLI 支持的非交互调用方式。不要硬编码未经验证的参数。

目标行为：

```text
QQ 用户发送一句话
→ Bridge 组装带上下文的任务文本
→ 启动一次 Codex CLI 非交互任务
→ 捕获 stdout / stderr
→ 提取最终可读结果
→ 发回 QQ
```

如果当前 Codex CLI 不适合直接进行稳定的非交互调用，先实现 `AgentAdapter` 抽象层，并提供一个 `MockAgentAdapter` 打通 QQ 收发链路。随后再根据本机 Codex CLI 的实际帮助文档补全 `CodexCliAdapter`。

---

## 3. 项目目录

请在用户指定目录中创建项目。若用户未指定，先询问，不要擅自在桌面或系统盘乱放文件。

建议目录结构：

```text
qq-codex-bridge/
├─ package.json
├─ tsconfig.json
├─ .env.example
├─ .gitignore
├─ README.md
├─ data/
│  ├─ state.json
│  └─ tasks.json
├─ logs/
│  └─ .gitkeep
├─ scripts/
│  ├─ check-env.ts
│  └─ push-message.ts
├─ src/
│  ├─ index.ts
│  ├─ config.ts
│  ├─ logger.ts
│  ├─ onebot/
│  │  ├─ types.ts
│  │  ├─ event-server.ts
│  │  └─ api-client.ts
│  ├─ agent/
│  │  ├─ agent-adapter.ts
│  │  ├─ mock-agent-adapter.ts
│  │  └─ codex-cli-adapter.ts
│  ├─ queue/
│  │  └─ task-queue.ts
│  ├─ security/
│  │  └─ command-policy.ts
│  └─ utils/
│     └─ text.ts
└─ tests/
   ├─ event-filter.test.ts
   ├─ command-policy.test.ts
   └─ mock-agent.test.ts
```

---

## 4. 环境变量

创建 `.env.example`：

```dotenv
# NapCatQQ OneBot v11 HTTP 地址，仅限本机
ONEBOT_HTTP_URL=http://127.0.0.1:3000

# Bridge 用于接收 NapCatQQ 反向 WebSocket 的地址
BRIDGE_WS_HOST=127.0.0.1
BRIDGE_WS_PORT=3001
BRIDGE_WS_PATH=/onebot/v11

# NapCatQQ 与 Bridge 之间的访问令牌
ONEBOT_ACCESS_TOKEN=change_me

# 只允许这个 QQ 号控制 Codex
ALLOWED_QQ_USER_ID=123456789

# Codex 命令。启动时必须检测是否可用
CODEX_COMMAND=codex

# Codex 默认工作目录。必须是明确允许访问的项目目录
CODEX_WORKDIR=F:\ANTI\qq-codex-workspace

# 日志等级
LOG_LEVEL=info

# 单次任务最长执行秒数
TASK_TIMEOUT_SECONDS=600

# 单次 QQ 回复最大字符数，超出后自动分段
QQ_MESSAGE_CHUNK_SIZE=1500

# MVP 默认禁用自动执行高风险指令
ALLOW_HIGH_RISK_COMMANDS=false
```

创建 `.gitignore`：

```gitignore
node_modules/
dist/
.env
logs/*.log
data/*.json
!data/.gitkeep
```

---

## 5. OneBot v11 事件处理

### 5.1 只处理白名单私聊

桥接层收到 OneBot v11 事件后，只处理符合以下条件的消息：

```ts
post_type === "message"
message_type === "private"
user_id === Number(process.env.ALLOWED_QQ_USER_ID)
```

其余消息全部忽略，并写入简短日志。不要回复陌生人，不要在群里冒泡。

### 5.2 防止重复执行

为每条消息维护去重键：

```text
message_id + user_id
```

近期处理过的消息写入内存缓存；必要时同步到 `data/state.json`。重启后至少保留最近 100 条已处理消息，避免重连时重复执行。

### 5.3 支持的 MVP 指令

普通文本默认交给 Codex：

```text
帮我检查 F:\ANTI\demo 项目的报错
```

保留以下控制命令：

```text
/help
/status
/ping
/cancel
/workdir
/workdir F:\ANTI\demo
/push 测试主动推送
```

行为要求：

- `/help`：返回命令说明；
- `/status`：返回 Bridge、NapCatQQ、Codex CLI、当前队列状态；
- `/ping`：返回 `pong`；
- `/cancel`：终止当前 Codex 子进程；
- `/workdir`：查看当前工作目录；
- `/workdir <路径>`：切换工作目录，但路径必须通过安全校验；
- `/push <内容>`：验证主动推送链路。

---

## 6. OneBot v11 发送能力

在 `src/onebot/api-client.ts` 中实现：

```ts
sendPrivateText(userId: number, text: string): Promise<void>
sendPrivateFile(userId: number, filePath: string, displayName?: string): Promise<void>
```

要求：

1. 文本过长时自动分段发送；
2. 每段发送间隔适当延迟，避免短时间内刷屏；
3. 文件必须存在于本地；
4. 文件发送前打印日志；
5. 文件发送失败时，返回清楚的错误消息；
6. 所有请求必须携带访问令牌；
7. 禁止向非白名单 QQ 号发送消息。

如当前 NapCatQQ 版本的文件发送动作名称或参数与预期不同，必须根据本机 NapCatQQ 的 OneBot v11 实现调整，并在 README 中记录实际采用的动作。

---

## 7. AgentAdapter 抽象层

创建接口：

```ts
export interface AgentRunOptions {
  prompt: string;
  workdir: string;
  timeoutMs: number;
  onProgress?: (text: string) => void;
}

export interface AgentRunResult {
  ok: boolean;
  output: string;
  error?: string;
  exitCode?: number | null;
}

export interface AgentAdapter {
  checkAvailable(): Promise<{ ok: boolean; detail: string }>;
  run(options: AgentRunOptions): Promise<AgentRunResult>;
  cancel(): Promise<boolean>;
}
```

### 7.1 MockAgentAdapter

先实现 Mock：

- 收到任务后等待 1 秒；
- 返回一段模拟回复；
- 支持取消；
- 用于先验证 QQ 收发链路。

### 7.2 CodexCliAdapter

再实现 Codex：

1. 启动时运行：

```bash
codex --help
```

2. 根据本机实际版本确认非交互运行命令；
3. 使用 `child_process.spawn`，不要拼接 shell 字符串；
4. `cwd` 必须设置为安全工作目录；
5. 捕获 stdout、stderr；
6. 超时后自动终止；
7. `/cancel` 可以终止当前子进程；
8. 返回最终可读文本；
9. 如输出包含结构化 JSON，可优先解析；解析失败则回退到纯文本；
10. 不要把未经处理的超长日志全部刷回 QQ。

---

## 8. 队列与并发

第一阶段只允许一个 Codex 任务运行：

```text
并发数 = 1
```

收到新任务时：

- 若当前空闲：立即执行；
- 若已有任务：排入队列；
- 回复用户当前排队位置；
- `/cancel`：终止当前任务，不删除后续队列；
- 每个任务完成后自动执行下一项；
- 每个任务记录：
  - id
  - 来源 QQ 号
  - 原始消息
  - 创建时间
  - 开始时间
  - 完成时间
  - 状态
  - 工作目录
  - 简短结果摘要

将任务状态持久化到：

```text
data/tasks.json
```

---

## 9. 安全策略

### 9.1 工作目录白名单

默认只允许 Codex 在以下根目录中工作：

```text
F:\ANTI
```

允许通过环境变量配置：

```dotenv
ALLOWED_WORKSPACE_ROOT=F:\ANTI
```

切换工作目录时：

1. 使用 `path.resolve()`；
2. 检查目标目录是否存在；
3. 检查目标目录是否位于允许根目录内；
4. 禁止切换到系统盘根目录、用户目录、浏览器资料目录、SSH 目录等敏感位置。

### 9.2 高风险任务确认

Bridge 在将消息交给 Codex 前，先检测高风险关键词。至少包括：

```text
删除
清空
格式化
卸载
重置
覆盖
rm -rf
del /f
rmdir
Remove-Item
git reset --hard
git clean -fd
drop database
truncate table
```

如果命中：

- 不自动执行；
- 回复用户风险提示；
- 要求用户再次发送：

```text
/confirm <任务ID>
```

未经确认不得执行。

### 9.3 禁止事项

默认禁止：

- 修改系统设置；
- 删除工作目录之外的文件；
- 操作浏览器 Cookie；
- 读取聊天软件数据目录；
- 读取密码管理器；
- 读取 SSH 私钥；
- 上传本地文件到第三方；
- 执行下载后立即运行的不明脚本；
- 关闭杀毒软件或防火墙；
- 将 Bridge 暴露到公网。

---

## 10. 主动推送能力

MVP 必须提供一个本地脚本：

```bash
npm run push -- "小饼干已完成任务"
```

内部调用：

```ts
sendPrivateText(ALLOWED_QQ_USER_ID, message)
```

这样后续任何本地脚本、计划任务或 Codex 流程都能主动向 QQ 发消息。

第二阶段再加入：

- 定时提醒；
- 随机唤醒；
- 心跳检测；
- 每日总结；
- 文件生成完成后自动推送；
- 截图推送；
- Timeline；
- 长期记忆。

---

## 11. 日志要求

日志写入：

```text
logs/bridge.log
```

记录：

- Bridge 启动；
- NapCatQQ WebSocket 连接与断开；
- 收到消息的时间、消息 ID、用户 ID；
- 消息是否被忽略；
- 任务入队、开始、结束、取消；
- Codex CLI 是否可用；
- 文本发送成功或失败；
- 文件发送成功或失败；
- 错误堆栈。

不要记录：

- `.env` 内容；
- 访问令牌；
- 密码；
- Cookie；
- 无关文件正文；
- 完整敏感信息。

---

## 12. 开发顺序

### 阶段 A：环境检测

实现：

```bash
npm run check
```

检查：

- Node.js 版本是否大于等于 22；
- `codex` 命令是否存在；
- `codex --help` 是否能运行；
- `.env` 是否完整；
- 工作目录是否存在；
- OneBot HTTP 地址是否可访问；
- WebSocket 监听端口是否可用。

输出清楚的人类可读报告。

### 阶段 B：Mock 打通 QQ 收发

暂时使用：

```dotenv
AGENT_MODE=mock
```

验收：

1. QQ 小号已在 NapCatQQ 登录；
2. 用户向 QQ 小号私聊 `/ping`；
3. Bridge 回复 `pong`；
4. 用户发送普通文本；
5. MockAgent 返回模拟结果；
6. `npm run push -- "主动推送测试"` 能在 QQ 收到消息。

### 阶段 C：接入 Codex CLI

切换：

```dotenv
AGENT_MODE=codex
```

验收：

1. QQ 发送一个只读任务；
2. Codex 在指定工作目录中执行；
3. 结果回传 QQ；
4. 超时可以停止；
5. `/cancel` 可以停止；
6. 错误不会导致 Bridge 崩溃。

### 阶段 D：文件推送

验收：

1. 本地生成一个测试文本文件；
2. 通过 Bridge 推送到 QQ；
3. QQ 端可以下载或打开；
4. 文件发送失败时，有清晰错误提示。

### 阶段 E：最小安全加固

验收：

1. 陌生 QQ 消息不会触发任务；
2. 群聊消息不会触发任务；
3. 重复消息不会执行两次；
4. 工作目录无法切换到白名单之外；
5. 高风险关键词触发二次确认；
6. 日志中不出现访问令牌。

---

## 13. package.json 建议脚本

```json
{
  "scripts": {
    "dev": "tsx watch src/index.ts",
    "start": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "check": "tsx scripts/check-env.ts",
    "push": "tsx scripts/push-message.ts",
    "test": "vitest run"
  }
}
```

依赖建议：

```bash
npm install dotenv ws axios zod pino pino-pretty
npm install -D typescript tsx vitest @types/node @types/ws
```

若能够减少依赖，请优先保持简单。

---

## 14. README 必须写清楚的内容

最终 README 至少包括：

1. 项目用途；
2. 风险提示：NapCatQQ 属于非官方 QQ 自动化方案，只建议小号使用；
3. Windows 安装步骤；
4. NapCatQQ 中 OneBot v11 HTTP 与反向 WebSocket 的配置方法；
5. `.env` 配置说明；
6. 启动顺序；
7. `/help` 命令列表；
8. 如何主动推送；
9. 如何发送文件；
10. 如何查看日志；
11. 常见故障：
   - QQ 小号掉线；
   - NapCatQQ 未连接；
   - Token 不一致；
   - WebSocket 地址填错；
   - Codex CLI 不存在；
   - Codex 登录失效；
   - 工作目录无权限；
   - 文件发送动作不兼容当前 NapCatQQ 版本。

---

## 15. 最终交付内容

完成后请汇报：

```text
1. 创建了哪些文件
2. 当前使用的 NapCatQQ / OneBot v11 连接方式
3. Codex CLI 的实际调用命令
4. 如何启动
5. 如何测试
6. 已通过哪些验收项
7. 仍未完成哪些功能
8. 有哪些安全风险
9. 下一步建议做什么
```

不要只说“已经完成”。请给出可复现的命令和测试结果。

---

## 16. 第二阶段候选功能

MVP 稳定后，再逐项加入：

- 定时任务；
- Windows 开机自启；
- NapCatQQ 断线重连；
- Codex 任务完成后自动推送文件；
- 截图推送；
- Timeline；
- 日记；
- 随机 check-in；
- 任务状态页面；
- SQLite；
- 更细的权限系统；
- 允许用户在 QQ 中选择项目目录；
- 将 Cyberboss 的时间线与主动催促机制移植过来。

优先顺序：

```text
稳定收发 > 安全限制 > 文件推送 > 断线重连 > 主动提醒 > 人格和长期记忆
```

---

## 17. 第一条开工指令

阅读本文档后，先不要直接写完整项目。请先完成以下动作：

1. 检查当前系统中的 Node.js、npm、Codex CLI；
2. 运行 `codex --help`，确认当前 CLI 的非交互调用方式；
3. 询问用户：
   - 项目要保存在哪个目录；
   - NapCatQQ 是否已经安装；
   - 用于测试的 QQ 小号是否已准备好；
   - 允许 Codex 操作的工作区根目录；
4. 输出你的实施计划；
5. 等用户确认后，再创建项目骨架。
