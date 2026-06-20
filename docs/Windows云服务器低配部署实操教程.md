# Windows 云服务器低配部署实操教程

> 项目：QQ Codex Bridge 云端常驻版  
> 目标环境：Windows x64、4 核 4 GB、约 40 GB 系统盘  
> 文档状态：实操记录，随部署过程逐步更新  
> 适用对象：已有部分软件和历史文件的非全新服务器

## 一、安全与记录边界

- 教程可以记录软件版本、安装路径、磁盘占用、端口和验证结果。
- 不记录或截图密码、代理订阅地址、代理节点、Token、Cookie、验证码、私钥、QQ 登录二维码和 Codex 登录凭证。
- OneBot Token、WebUI 密码和代理订阅只能由使用者在云服务器本地填写。
- 检查配置时只验证字段存在、格式和连通性，不输出凭证正文。

## 二、已知服务器状态

- Windows 系统盘：总容量约 39.8 GB。
- 当前可用空间：约 13.6 GB（关闭休眠后增加约 3.3 GB）。
- 系统：Windows Server 2022 Datacenter，版本 10.0.20348，x64。
- 物理内存：4 GB，已由系统命令确认。
- Microsoft Edge WebView2 Runtime：未安装。
- `D:` 显示为 0 字节，不是可用数据盘；当前只能使用 `C:`。
- Node.js：v24.14.0，已安装。
- npm：11.9.0，已安装。
- Git：2.54.0.windows.1，已安装。
- Codex CLI：`0.141.0`，已安装。
- winget：未安装。
- 旧 NapCat 根目录：`C:\Users\Administrator\Desktop\NapCat`。
- 旧 NapCat 副本：`NapCat_Caleb_01` 与 `NapCat_Caleb_02`，各约 1.49 GB。
- 服务器不是全新环境，后续采用“检测后复用”，不重复安装已有组件。

## 三、目标安装结构

仅保留必要组件：

1. Windows 与远程桌面。
2. 合法使用的 Clash/Mihomo Windows 客户端。
3. 桌面 QQ 与一个 NapCat 实例。
4. Node.js、Git、Codex CLI。
5. QQ Codex Bridge、WebUI、聊天与记忆存储。

不安装 Codex 桌面端、Office、Docker、WSL、VS Code 或其他非必要开发环境。

## 四、低配运行约束

- 同时只运行一个 Codex 任务。
- 聊天数据库默认上限 256 MB，达到 80% 时提醒。
- 记忆摘要默认上限 64 MB。
- 日志上限 100 MB并循环覆盖。
- 附件总量默认上限 1 GB，处理后按策略清理。
- 临时文档上限 512 MB，任务结束后删除。
- 代理使用规则模式；初期不启用 TUN，避免影响远程桌面和本机 OneBot 通信。
- 代理监听仅限本机，`127.0.0.1`、`localhost` 和局域网地址必须直连。

## 五、部署阶段

### 阶段 1：盘点已有环境

检查 Windows、内存、磁盘，以及 Node.js、npm、Git、Codex CLI 和包管理工具是否已安装。只记录版本与是否可用。

状态：已完成。Node.js、npm 和 Git 直接复用；后续仅补装 Codex CLI。

### 阶段 2：安装并验证代理客户端

选用 Clash Verge Rev 官方 Windows x64 版本。截至 2026-06-20，官方最新稳定版为 v2.5.1：

- 官方发布页：<https://github.com/clash-verge-rev/clash-verge-rev/releases/latest>
- 当前服务器缺少 WebView2，因此采用官方内置 WebView2 的 x64 安装包：`Clash.Verge_2.5.1_x64_fixed_webview2-setup.exe`。
- 直接下载地址：<https://github.com/clash-verge-rev/clash-verge-rev/releases/download/v2.5.1/Clash.Verge_2.5.1_x64_fixed_webview2-setup.exe>

使用者在本地界面自行导入订阅，不向教程、聊天或截图暴露订阅内容。验证规则模式、系统代理和本机地址直连。

实操记录：首次误装了 `Clash Verge Rev 2.5.0-rc`。安装界面只显示“Clash Verge”，不能仅凭界面名称判断是否为 Rev；通过 Windows 卸载注册表核验，Publisher 为 `Clash Verge Rev`，但版本属于候选版而非稳定版。由于尚未导入订阅，决定卸载候选版并改装 v2.5.1 稳定版。

核验已安装版本：

```powershell
$paths=@(
 "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*",
 "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall\*",
 "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall\*"
)
Get-ItemProperty $paths -ErrorAction SilentlyContinue |
Where-Object {$_.DisplayName -like "*Clash Verge*"} |
Select-Object DisplayName,DisplayVersion,Publisher,InstallLocation
```

实操结果：已卸载 `2.5.0-rc`，并成功安装 `Clash Verge Rev 2.5.1`。Windows 卸载注册表显示 Publisher 为 `Clash Verge Rev`，版本核验通过。

系统代理验证结果：

- `ProxyEnable = 1`，系统代理已经开启。
- `ProxyServer = 127.0.0.1:7897`，仅监听本机，没有向公网开放代理端口。
- GitHub 经显式代理访问返回 HTTP 200，连通正常。
- OpenAI API `/v1/models` 在未携带凭证时返回 HTTP 401，符合预期并证明接口可达。
- Clash Verge Rev 安装目录实际占用约 168.3 MB。
- Clash 核心进程 `verge-mihomo` 在 `127.0.0.1:7897` 持续监听，实测工作集约 60.4 MB。
- 清空两个旧 NapCat 实例后，`C:` 最终剩余约 13.31 GB；这是当前真实可用空间，不再预期额外释放约 3 GB。

状态：稳定版安装、系统代理、外部连通性、后台常驻与资源占用验证全部完成。

### 阶段 3：清理旧 NapCat 并重新安装

停止旧 QQ 与 NapCat，确认无相关进程后清理两个旧副本；下载最新官方 OneKey 包并只安装一个实例。记录下载体积、安装后占用、启动文件和验证结果。

QQ 需要使用者自行安装，NapCat 包不代替 QQ。为保证教程可复现，截至 2026-06-20 固定使用以下兼容组合：

- QQ Windows x64：`9.9.26-44343`。这是 NapCat v4.18.7 发布说明明确给出的推荐版本，构建号高于其要求的最低 40768。
- QQ 官方腾讯 CDN：[QQ 9.9.26-44343 x64](https://dldir1.qq.com/qqfile/qq/QQNT/40d6045a/QQ9.9.26.44343_x64.exe)
- NapCat：`v4.18.7`。
- NapCat 官方发布页：[NapCat v4.18.7](https://github.com/NapNeko/NapCatQQ/releases/tag/v4.18.7)
- NapCat 官方 OneKey 包：[NapCat.Shell.Windows.OneKey.zip](https://github.com/NapNeko/NapCatQQ/releases/download/v4.18.7/NapCat.Shell.Windows.OneKey.zip)

只选择 Windows x64 正式版；不使用第三方软件下载站、网盘重打包或来源不明的镜像。若服务器已经安装 QQ，应先检查版本，符合最低构建要求再复用；不符合时卸载旧版后安装上述固定版本。

本次云服务器实测已安装 `QQ 9.9.27.45758`。构建号 45758 高于 NapCat 要求的最低 40768，因此直接复用，不卸载、不降级，也不重复安装教程中的固定版本。


OneKey 官方压缩包约 1 MB。直接在桌面解压后应包含 `NapCatInstaller.exe`、`bootmain`、`7z.exe` 与 `7z.dll`：


安装前应从托盘退出 QQ，并确认没有残留 `QQ.exe` 进程；随后右键 `NapCatInstaller.exe`，选择“以管理员身份运行”。QQ 未完全退出可能导致文件移动或覆盖时出现 `Access denied`。

云服务器实装时，第一个 GitHub 镜像返回错误码 12029；OneKey 自动切换到第二镜像后获得 HTTP 200，并成功下载约 28 MB 的 `NapCat.Shell.zip`。这种单个镜像失败后自动回退成功不需要人工重试：


安装器最终创建独立目录 `NapCat.44498.Shell`，内部运行环境为 QQ 9.9.26-44498；它与系统已安装的 QQ 9.9.27.45758 分开存在。解压得到 130 个文件夹、676 个文件，NapCat 文件约 94.4 MB，启动文件复制完成并显示“安装完成”：


实操结果：使用者确认旧实例短期内不再使用，已删除 `NapCat_Caleb_01` 与 `NapCat_Caleb_02`。旧配置不迁移，后续按教程从零配置单实例。

状态：旧实例与回收站均已清理。使用者具备重新安装能力，NapCat 单实例重装暂缓，等云端 Codex 与 Bridge 环境准备好后再执行。

### 阶段 4：配置 NapCat OneBot 11

配置本机 HTTP Server 与反向 WebSocket Client。两处使用相同 Token，由使用者自行填写。验证 QQ 登录、WebUI、HTTP API 和反向 WebSocket。

运行 `NapCat.44498.Shell\napcat.bat`，使用专用 QQ 小号登录。随后在云服务器本机进入 NapCat WebUI；截图或录制教程时，必须用不透明同色块完整遮住 QQ 号码、WebUI 登录密钥、Token、二维码和带凭证的地址参数。

本次实测已成功登录 NapCat v4.18.7，独立运行环境的 QQ 版本为 9.9.26-44498。进入 WebUI 后尚未创建任何网络配置：


4 GB 云服务器在浏览器仍开启时内存占用约 81%。完成配置后应关闭多余浏览器窗口，Bridge 与 Codex 任务也应尽量单任务运行。

在“网络配置”中点击“新建”，首先选择“HTTP 服务器”：


填写凭证前的安全配置页面如下。教程不保留填写 Token 后的原始截图：


HTTP Server 保存后，再次点击“新建”并选择“WebSocket 客户端”。注意不要误选成 WebSocket 服务器：


最终应出现两张已启用的配置卡：HTTP Server 监听 `127.0.0.1:3000`；WebSocket Client 连接 `ws://127.0.0.1:3001/onebot/v11`。两处使用同一 Token，但教程和截图均不记录其内容：


Bridge 尚未启动时，WebSocket Client 出现拒绝连接或周期性重连属于正常现象。

状态：NapCat、WebUI 与 OneBot 网络配置均已完成，等待配置并启动 Bridge。

在 Bridge 根目录运行 `tools\02-open-config.bat`，只在云服务器本机填写与 NapCat 两处一致的 `ONEBOT_ACCESS_TOKEN`，以及允许控制机器人的主号 `ALLOWED_QQ_USER_ID`；保存后清空剪贴板，不展示或发送 `.env`。随后运行 `tools\03-check-environment.bat`。

本次检查结果全部通过：Node.js v24.14.0、`.env` 存在、字段完整、格式有效、工作区存在、Bridge 可监听 `127.0.0.1:3001`，OneBot HTTP 鉴权返回 HTTP 200：


运行 `tools\04-start-bridge.bat` 后，Bridge 成功识别 Codex CLI，监听 `127.0.0.1:3001`，并在 `127.0.0.1:3080` 启动 WebUI。若 NapCat 的 WebSocket Client 曾在 Bridge 启动前停止重试，可将 `bridge-ws` 关闭两秒再开启，强制重新加载；Bridge 出现 `NapCat reverse WebSocket connected` 即表示反向 WebSocket 鉴权和连接成功：


随后由白名单主号私聊机器人发送 `/测试`，机器人正常回复 `pong`，证明 QQ 收发、NapCat OneBot、反向 WebSocket 与 Bridge 指令路由均已贯通。

继续发送 `/状态`，实测返回：Bridge 运行中、NapCat 已连接、Codex 可用（只读模式）、任务空闲、本地记忆库可用（0 条）、记忆调用已启用、工作区为受限 `workspace`。这一步不包含任何凭证内容。

发送 `/查询额度` 可直接读取 Codex 当前限额，机器人会分别返回 5 小时额度和周额度的剩余比例、已用比例及北京时间重置时间；兼容 `/usage`、`/额度`。这不是让模型自行估算，也不会启动一次对话任务。WebUI“状态”页会显示同一份数据的进度条和重置时间；额度接口暂时不可用时，只影响额度卡片，不影响 Bridge、QQ 与 Codex 任务。

最后发送“请只回复 `CLOUD_BRIDGE_OK`，不要使用工具。”，机器人成功返回 `CLOUD_BRIDGE_OK`。这证明云服务器上的 Codex CLI 已被 Bridge 真实调用，完整路径 `QQ → NapCat → Bridge → Codex CLI → Bridge → NapCat → QQ` 验证通过。

### 阶段 5：复用或补装 Bridge 环境

已有 Node.js、Git 或 Codex CLI 时直接复用；缺失时才安装。Bridge 使用 Codex CLI 的非交互模式，不安装 Codex 桌面端。

实操结果：通过官方 npm 包 `@openai/codex` 安装 Codex CLI，安装过程新增 2 个包，耗时约 25 秒；版本核验为 `codex-cli 0.141.0`。npm 的小版本升级提示暂不处理。

登录时在服务器 PowerShell 中运行：

```powershell
$env:HTTP_PROXY="http://127.0.0.1:7897"
$env:HTTPS_PROXY="http://127.0.0.1:7897"
codex.cmd login
```

浏览器出现 `Signed in to Codex`，同时终端显示 `Successfully logged in`，即表示登录完成：


登录命令输出的认证网址属于秘密凭证，不得发送、截图传播或写入教程。若必须制作说明图，应裁掉敏感区域，或使用与背景同色、完全不透明的色块整体覆盖；模糊、马赛克和仅叠加文字都不属于可靠脱敏。本次实操采用如下同色遮盖示例：


曾经暴露过认证网址或回调 Token 时，应立即运行 `codex.cmd logout`，在 ChatGPT 安全设置中退出所有设备，再重新登录。截图遮盖只保护图片，不能撤销已经暴露的凭证。

重新登录后执行：

```powershell
codex.cmd -a never exec --ephemeral --sandbox read-only --skip-git-repo-check "请只回复 CLOUD_CODEX_OK"
```

实测 Codex CLI v0.141.0 使用 `gpt-5.5`，`approval` 为 `never`，`sandbox` 为 `read-only`，最终正确返回 `CLOUD_CODEX_OK`，本次显示使用 11,179 tokens。终端输出中的 `session id` 不是登录凭证，但属于可关联会话的标识，公开截图时仍应遮盖。


状态：Codex CLI 安装、重新登录与只读非交互测试均已完成。

### 阶段 6：部署 Bridge 与低空间配置

部署 WebUI、对话、人设、云端记忆、存储上限和自动清理。GitHub 为可选出口，默认关闭。

已生成带额度查询功能的 Windows 云端低配完整运行包：`release/QQ-Codex-Bridge-Cloud-Windows-2026-06-20-r4.zip`，压缩后约 227.4 KB。已部署 r3 可使用 `release/QQ-Codex-Bridge-Cloud-Windows-r3-to-r4-update.zip`，约 107.5 KB；更新包只包含编译产物与说明，不包含或覆盖 `.env`、`bridge-data`、`workspace`、`memory-repo`、聊天记录及用户设置。服务器执行 `npm install --omit=dev` 后，当前版本的生产依赖约占 4.86 MB。

运行包具备以下云端默认值：

- 只包含编译产物、WebUI、空白工作区与本地记忆库模板，不包含 `.env`、聊天记录、账号、Token、日志或个人设置。
- WebUI 仅监听 `127.0.0.1:3080`，不向公网开放。
- 可选公网访问使用通用开关，不把家庭、办公室或移动网络的公网 IP 写入 Bridge。实际来源规则由用户在云安全组自行添加。
- 聊天记录初始上限为 256 MB，达到 80% 时提醒。
- 记忆默认只写入云服务器本地 Git 仓库；`MEMORY_REMOTE_URL` 留空时不会访问 GitHub。
- Bridge 启动脚本为 Codex 子进程设置 `127.0.0.1:7897` 代理。
- 运行时不安装 TypeScript、Vitest 等开发依赖。
- `/查询额度` 直接调用 Codex app-server 的 `account/rateLimits/read`，QQ 与 WebUI 共用同一份 5 小时/周额度快照；不读取认证文件，也不提交模型任务。

代码修改后已通过 20 个测试文件、共 84 项测试；生产依赖审计结果为 0 个已知漏洞。完整包与更新包复检确认不存在真实 `.env`、日志、`.git` 历史或 `node_modules`；更新包同时确认不含根目录用户数据 `bridge-data`、`workspace` 与 `memory-repo`。

完整 r4 包 SHA-256：`D8FFBB3C26E47EBE446DF63D1C4AAF9541D401818979A4A96561B40649D25BB5`。

r3 → r4 更新包 SHA-256：`AF7AAB52C06D1959136E91C5842FC4C1630E0A204DF7BCA53E5EF14BB11A1817`。

状态：云端 r3 已完成实际部署和 QQ/Codex 联调；具备实时额度查询的 r4 与无用户数据更新包已生成，等待覆盖部署后验收 `/查询额度` 和 WebUI 额度卡片。

### 阶段 7：验收与开机恢复

验证 QQ 聊天、云端 Codex 回复、文件收发、记忆、WebUI、额度查询、磁盘与内存告警。云服务器通常长期运行，本次不把开机自动恢复列为必做项。

当前实测状态：Bridge 运行中、NapCat 已连接、Codex 可用（只读模式）、任务空闲、本地记忆库可用（0 条）、记忆调用已启用、工作区为受限 `workspace`。公网 WebUI 密码登录成功，低配资源快照完成；核心 QQ/Codex 云端部署验收完成。尚待按实际需求执行文件与记忆测试。

修正状态脚本的 PowerShell 分组格式后，最终资源快照显示：系统盘剩余约 11.5 GB；4 GB 内存空闲约 0.73 GB、使用率 81.8%；7897 由 `verge-mihomo` 监听，3000 由 QQ/NapCat 监听，3001 与 3080 均由 Bridge 的 Node.js 进程监听。Bridge Node.js 工作集约 58.9 MB，资源占用符合低配目标：


如需从其他电脑或移动设备通过公网访问 WebUI，必须先在云服务器本机设置远程密码，再将 `.env` 中的 `WEBUI_HOST` 改为 `0.0.0.0`、`WEBUI_ALLOW_PUBLIC_ACCESS` 改为 `true`。程序只解除公网来源拦截，不记录允许的公网 IP；用户可在云控制台为 TCP 3080 添加任意数量的单 IP 或 CIDR 允许规则：

本机设置页显示“密码已更新”且远程可信会话为 0，即表示密码已加盐保存，尚无远程设备登录：


r2 → r3 更新包可直接解压并与原有 `QQCodexBridge` 合并；更新后根目录仍为单层，`.env`、`bridge-data`、`memory-repo` 与 `workspace` 均保留：



部分云控制台可直接选择“当前登录 IP”，自动填入当前管理设备所在网络的公网出口地址。不要误选“全部 IPv4 地址”：


同一路由器下的多台设备通常共享一个公网出口 IPv4，只需一条规则；家庭、办公室和移动网络若出口不同则分别添加。移动网络 IP 可能频繁变化，规则维护方式由使用者自行决定。`3000`、`3001` 与 `7897` 始终不得开放公网；长期公网访问建议另行配置 HTTPS。

修改 `.env` 并重启 Bridge 后，用 `Get-NetTCPConnection -LocalPort 3080 -State Listen` 检查；`LocalAddress` 显示 `0.0.0.0` 才表示公网监听配置已生效：


随后从云安全组允许的外部网络访问 `http://服务器公网IPv4:3080`，远程密码登录成功。至此，r3 公网访问开关、密码认证、Windows 防火墙与云安全组来源规则均验证通过；教程不记录服务器公网 IP、密码或会话 Cookie。

## 六、当前下一步

全新安装时，把 `QQ-Codex-Bridge-Cloud-Windows-2026-06-20-r4.zip` 放到云服务器桌面，并直接在桌面选择“全部解压”。压缩包内部已经固定为 `QQCodexBridge`，不需要改名或移动。打开后应看到如下结构：


随后双击 `QQCodexBridge\tools\01-install-runtime.bat`。此时不要创建或填写 `.env`，NapCat 单实例配置完成后再进行凭证配置。运行脚本全部使用 ASCII 文件名与内部文本，以避免 Windows Server 未启用 UTF-8 系统区域设置时发生闪退。

云服务器实测安装生产依赖 16 个、耗时约 4 秒，审计结果为 0 个已知漏洞；本地记忆 Git 仓库成功创建初始提交。最终核验 Node.js v24.14.0、Codex CLI 0.141.0，并显示 `INSTALL_OK`。Git 显示的 LF/CRLF 转换警告不影响运行。

已经运行 r3 时无需重新安装：先关闭 Bridge 运行窗口，将 `QQ-Codex-Bridge-Cloud-Windows-r3-to-r4-update.zip` 直接解压到桌面的 `QQCodexBridge` 并确认替换同名文件，再双击 `tools\04-start-bridge.bat`。随后在 QQ 发送 `/查询额度`，并在 WebUI“状态”页刷新；两处都能看到 5 小时、周额度和北京时间重置时间即为 r4 验收通过。


---

© 2026 沈菀 (Akusative) | AGPL-3.0
