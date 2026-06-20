# QQ Codex Bridge — Codex 部署执行协议

> 本文件的主要读者是 Codex 或其他能够操作 Windows 的编程代理。用户只需把本文件与项目目录一起交给代理，并说“请按照部署协议安装”。

## 0. 强制起始动作

读完本文件后，不得立即安装。第一条回复必须主动询问：

> 请选择部署方式：  
> 1. 本地桥接——Bridge、QQ、NapCat 和 Codex 都运行在自己的 Windows 电脑上；  
> 2. 云服务器桥接——它们运行在 Windows 云服务器上，本机关闭后仍可通过 QQ 使用。  
> 请回复 1 或 2。

用户选择后，只执行对应分支。不要同时混合两套流程。

## 1. 代理行为契约

### 必须做到

1. 先检查、后安装；已经满足的环境直接复用，不重复下载或降级。
2. 每次只推进一个可验证阶段，验证通过后再进入下一阶段。
3. 尽量由代理完成下载、解压、创建目录、运行命令、生成空白配置、启动服务和检查状态。
4. 只有扫码登录 QQ、登录 Codex、填写 Token/密码、处理 UAC 和云控制台安全组等必须由用户完成的动作，才请用户介入。
5. 下载软件只使用项目文档列出的官方站点或官方 GitHub Release。
6. 修改文件前保留用户已有内容；不得删除、覆盖既有 Bridge、QQ、NapCat、记忆库或聊天数据，除非用户明确授权。
7. 完成后验证 `/测试`、`/状态`、`/查询额度` 和一次真实的只读 Codex 回复。

### 凭证与隐私硬边界

1. 不得要求用户在聊天中发送密码、Token、Cookie、验证码、私钥、代理订阅、Codex 登录网址或回调参数。
2. 不得读取、打印、复制、记录或总结 `ONEBOT_ACCESS_TOKEN` 的值。允许检查该字段是否存在、是否为空、两端鉴权是否成功。
3. 可以读取 `ALLOWED_QQ_USER_ID` 以验证格式和白名单，但不得公开传播。
4. 创建 `.env` 后，应主动用记事本打开，让用户只在本机填写；明确提示用户 `Ctrl+S` 保存并关闭，不要把文件或截图发给代理。
5. 日志、截图和教程不得出现 QQ 号、服务器公网 IP、WebUI 密码、Token、二维码、Codex 登录网址或带认证参数的地址。
6. 需要截图时必须使用完全不透明的同色块覆盖秘密；模糊、马赛克或在模糊上叠字都不可靠。
7. 发现凭证疑似暴露时，停止部署，引导用户立即撤销或更换后再继续。

## 2. 通用验收标准

以下条件全部满足才可宣布部署完成：

- Node.js 版本不低于 22；Git 与 Codex CLI 可用。
- 使用专用 QQ 小号登录 NapCat，不影响主号客户端。
- NapCat HTTP Server 为 `127.0.0.1:3000`。
- Bridge 反向 WebSocket 为 `127.0.0.1:3001/onebot/v11`。
- 两处 OneBot Token 相同，但代理从未读取或显示其内容。
- Bridge WebUI 可在运行机器的 `http://127.0.0.1:3080` 打开。
- 白名单主号发送 `/测试` 收到 `pong`。
- `/状态` 显示 Bridge 运行、NapCat 已连接、Codex 可用。
- `/查询额度` 返回 5 小时与周额度及北京时间重置时间。
- 真实只读任务能得到 Codex 回复。

---

# 分支 A：本地桥接

## A1. 自动检查环境

代理应自行检查：

- Windows 10/11 x64；CPU、内存和系统盘空间。
- QQ、Node.js、npm、Git、Codex CLI 是否安装及版本。
- 端口 `3000`、`3001`、`3080` 是否被其他程序占用。
- 当前目录是否为完整项目，是否存在 `.env.example`、`package.json`、`src`、`webui`。

建议最低配置为 2 核、8 GB 内存和 5 GB 可用磁盘。若不满足，先说明风险，不要假装环境合格。

## A2. 自动补齐依赖

缺少依赖时，优先使用 Windows Package Manager 或官方安装程序：

- Node.js：<https://nodejs.org/>
- Git for Windows：<https://git-scm.com/download/win>
- Codex CLI：<https://developers.openai.com/codex/cli/>
- Windows QQ：<https://im.qq.com/pcqq/index.shtml>
- NapCatQQ：<https://github.com/NapNeko/NapCatQQ>

代理应完成可静默完成的安装和版本检查；需要管理员确认时，仅请用户批准系统 UAC。安装完成后重新打开终端或刷新 PATH，再验证版本。

Codex CLI 可通过官方 npm 包安装：

```powershell
npm.cmd install -g @openai/codex
codex.cmd --version
codex.cmd login
```

登录页面和终端认证网址属于秘密。登录必须由用户本人完成；成功后只验证 `Successfully logged in` 或运行一个不读取文件的只读测试。

## A3. 部署项目

若用户提供的是最终 ZIP：

1. 代理自行选择无个人数据的安装目录，例如 `%USERPROFILE%\QQCodexBridge`。
2. 解压项目，不把它放进下载缓存或临时目录长期运行。
3. 执行 `npm.cmd install`、`npm.cmd run build` 和 `npm.cmd test -- --run`。
4. 任何测试失败都先查明原因，不跳过验证。

## A4. 安装并配置 NapCat

1. 使用官方 NapCat Windows OneKey 包，复用兼容的官方 QQ；不要把用户当前主号强行变成机器人账号。
2. 由用户在 NapCat 启动窗口扫码或确认登录专用小号。
3. 用户进入 NapCat WebUI 后创建：
   - HTTP Server：Host `127.0.0.1`，Port `3000`，消息格式 `Array`；
   - WebSocket Client：URL `ws://127.0.0.1:3001/onebot/v11`，消息格式 `Array`；
   - 两处 Token 由用户自行生成并粘贴，必须一致；普通 `ws://` 不需要 SSL 证书验证。
4. 可以启用 HTTP CORS，但不要把 HTTP 或 WebSocket 端口开放公网。

若 Bridge 尚未启动，WebSocket Client 显示 `ECONNREFUSED 127.0.0.1:3001` 属于预期现象；Bridge 启动后它应自动重连。

## A5. 创建私密配置

```powershell
Copy-Item .env.example .env
notepad .env
```

让用户自行填写 `ONEBOT_ACCESS_TOKEN` 和 `ALLOWED_QQ_USER_ID`，保存并关闭。代理不得读取 Token 内容。随后运行项目环境检查；只向用户报告 PASS/FAIL 和非秘密字段格式。

## A6. 启动与验收

1. 启动 Bridge 并保持窗口运行。
2. 若 NapCat 未重连，将 WebSocket Client 关闭两秒后重新开启。
3. 依次验证 `/测试`、`/状态`、`/查询额度` 和一次真实只读任务。
4. 打开 `http://127.0.0.1:3080`，检查聊天、人设、记忆、状态和设置页。
5. 需要局域网访问时再配置 `WEBUI_HOST=0.0.0.0`，Windows 防火墙仅允许可信局域网；不要开放 `3000`、`3001`。

完成后向用户给出安装目录、启动方式、停止方式、WebUI 地址和备份目录，不显示秘密。

---

# 分支 B：Windows 云服务器桥接

## B1. 先盘点，不重装

通过远程桌面进入 Windows Server 后，代理指导用户检查：

- Windows Server 2022 x64；至少 4 vCPU、4 GB 内存、40 GB 系统盘。
- C 盘剩余空间；建议开始时至少剩余约 10 GB。
- Node.js、npm、Git、Codex CLI、QQ、WebView2、代理软件是否已存在。
- `3000`、`3001`、`3080`、代理端口是否监听。

4 GB 内存是实测低配下限。安装和配置完成后应关闭浏览器、安装器和无关常驻程序。

## B2. 网络与代理（仅在需要时）

若服务器不能直接访问 GitHub 或 OpenAI，可安装用户有权使用的代理客户端。Clash Verge Rev 官方发布页：

<https://github.com/clash-verge-rev/clash-verge-rev/releases>

代理订阅必须由用户本人在服务器本地导入，禁止发送给代理。启用系统代理后，用当前本地代理端口测试：

```powershell
$proxy="http://127.0.0.1:7897"
curl.exe -L -sS -o NUL -w "GitHub HTTP %{http_code}`n" --proxy $proxy https://github.com
curl.exe -sS -o NUL -w "OpenAI API HTTP %{http_code}`n" --proxy $proxy https://api.openai.com/v1/models
```

GitHub 返回 200，OpenAI API 在未提供密钥时返回 401，说明链路可达。不要为了得到 200 而填写或暴露 API Key。

## B3. 安装 Codex CLI 并登录

复用现有 Node.js 和 Git；缺失时才从官方来源安装。通过 npm 安装 Codex CLI，并在当前终端设置代理后登录：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"
$env:HTTPS_PROXY="http://127.0.0.1:7897"
npm.cmd install -g @openai/codex
codex.cmd --version
codex.cmd login
```

浏览器出现 `Signed in to Codex` 且终端显示 `Successfully logged in` 即可。认证网址、回调参数和浏览器地址栏不得截图或发送。登录后执行只读烟雾测试：

```powershell
codex.cmd -a never exec --ephemeral --sandbox read-only --skip-git-repo-check "请只回复 CLOUD_CODEX_OK"
```

## B4. 安装 QQ 与 NapCat

1. 从 QQ 官方站安装当前 Windows x64 正式版，不使用来源不明的精简包。
2. 从 NapCatQQ 官方 Release 下载 Windows OneKey 包，在桌面解压后运行安装器。
3. 某个下载镜像失败但 OneKey 自动切换并最终显示安装成功时，不需要重装。
4. 使用专用 QQ 小号登录 NapCat。
5. 在 NapCat WebUI 创建与本地分支相同的 HTTP Server 和 WebSocket Client；两处 Token 由用户自行填写。

## B5. 部署云端运行包

若最终 ZIP 内包含 `packages/QQ-Codex-Bridge-Cloud-Windows-2026-06-20-r4.zip`：

1. 把它放到云服务器桌面并“全部解压”。
2. 解压后直接得到 `QQCodexBridge`，不改名、不增加额外目录层级。
3. 依次运行：
   - `tools\01-install-runtime.bat`
   - `tools\02-open-config.bat`
   - `tools\03-check-environment.bat`
   - `tools\04-start-bridge.bat`
   - `tools\05-open-webui.bat`
4. `02` 打开 `.env` 后，只让用户填写秘密；`03` 只报告 PASS/FAIL。
5. Bridge 启动后，NapCat 日志出现反向 WebSocket 已连接，再执行通用验收。

## B6. 可选公网 WebUI

默认只允许服务器本机访问。若用户明确需要从家庭、办公室或移动网络进入 WebUI：

1. 先在云服务器本机 WebUI 设置远程访问密码。
2. 修改 `.env`：

```dotenv
WEBUI_ENABLED=true
WEBUI_HOST=0.0.0.0
WEBUI_ALLOW_PUBLIC_ACCESS=true
WEBUI_PORT=3080
```

3. 重启 Bridge，确认 `Get-NetTCPConnection -LocalPort 3080 -State Listen` 显示 `0.0.0.0`。
4. Windows 防火墙只放行 TCP 3080：

```powershell
New-NetFirewallRule -DisplayName "QQ Codex Bridge WebUI 3080" -Direction Inbound -Protocol TCP -LocalPort 3080 -Action Allow
```

5. 用户在云控制台安全组自行添加允许来源。可以添加多条家庭、办公室或移动网络的单 IP/CIDR；不要选择全部 IPv4，除非用户明确理解风险。
6. `3000`、`3001` 和代理端口永远不开放公网。
7. 外部访问地址为 `http://服务器公网IPv4:3080`。长期公网使用应配置 HTTPS；不要在日志或教程里记录真实地址和密码。

## B7. 云端最终验收

完成通用验收后，额外检查：

- Bridge Node.js 进程、QQ、NapCat 和代理的内存占用；4 GB 机器保持合理余量。
- C 盘剩余空间和聊天记录上限。
- WebUI 远程密码登录、会话撤销和状态页。
- 关闭用户自己的电脑后，云端 QQ 仍能完成 `/测试`、`/状态`、`/查询额度` 和真实任务。

不要求用户上传记忆到 GitHub。`MEMORY_REMOTE_URL` 留空时，记忆只保存在云服务器本地；只有用户明确选择远端同步后才配置私有仓库。

---

## 3. 失败处理规则

- 不猜测端口、路径、版本或 API；先读取现有配置和可见日志。
- 一次只修复一个失败点，并重新执行对应检查。
- `ECONNREFUSED 127.0.0.1:3001`：先确认 Bridge 是否启动、是否监听 3001，再重载 NapCat WebSocket Client。
- OneBot HTTP 非 200：检查 HTTP Server 是否启用、端口是否为 3000、两处 Token 是否一致；不得显示 Token。
- Codex 不可用：检查登录状态、CLI 版本和代理链路，不读取认证文件。
- WebUI 外网打不开：依次检查监听地址、Windows 防火墙、云安全组和本地代理；不要直接把端口开放给 `0.0.0.0/0` 作为排障捷径。
- 内存不足：关闭浏览器和安装程序，减少并发任务；不要通过删除用户数据换取空间。

## 4. 最终交付话术要求

完成后，用普通用户能看懂的简体中文说明：

1. 已完成哪些组件；
2. 如何启动和停止；
3. QQ 与 WebUI 如何访问；
4. 哪些数据只保存在本机/云服务器；
5. 仍需用户自行保管的秘密；
6. 测试结果与尚未完成的项目。

禁止在最终回复中粘贴 `.env`、Token、密码、Cookie、登录网址、服务器公网 IP 或任何敏感原文。

