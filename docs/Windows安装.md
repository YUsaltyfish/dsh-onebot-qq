# Windows 10/11 从零到跑通

> 目标：一台**干净的 Windows 10/11 x64**，装上 Node、DSH、NapCat、本插件，让 QQ 群里 @ 机器人能收到回复。
> 全程只用 Windows 自带工具 + PowerShell；不需要 WSL、不需要 bash、不需要管理员权限（安装 Node 时除外）。
> 每一步都有「怎么确认成功」，卡住时看 [排错](排错.md) 的 Windows 部分。
> 本文是 Windows 专用全流程；通用安装 / 升级 / 卸载 / 回滚见 [安装与卸载](安装与卸载.md)。

## 零、版本与前置

| 组件 | 要求 | 确认命令 |
|---|---|---|
| Windows | 10 / 11 x64 | `winver` |
| Node.js | **>= 22 LTS** | `node --version` → `v22.x` |
| DSH | **>= 0.2.1-rc.2 < 0.3.0** | `dsh --version` |
| NapCatQQ | 近期版本（QQNT 客户端 + OneBot v11） | NapCat WebUI 能打开、QQ 已登录 |
| QQ 账号 | 建议小号 | — |

> 术语：**DSH** 是跑机器人的宿主（`dsh web` 起 Web 服务）；**NapCat** 是连 QQ 的协议端；
> **本插件** 是装在 DSH profile 里的 `dsh-onebot-qq`。

## 一、安装 Node.js 22

1. 打开 <https://nodejs.org/> 下载 **LTS（22.x）** 的 Windows Installer（`.msi`，x64），一路下一步。
2. **重开一个 PowerShell**（让 PATH 生效），确认：
   ```powershell
   node --version    # v22.x.x
   npm --version     # 10.x+
   ```
3. 如果提示 `node 不是内部或外部命令`：重开终端；还不行就检查安装时是否勾选了 "Add to PATH"。

## 二、安装 DSH 并启动 Web

```powershell
npm install -g @deepseek-ai/dsh
dsh --version
dsh web          # 首次启动会初始化 web profile（%USERPROFILE%\.dsh\profiles\web）
```

浏览器打开 <http://127.0.0.1:3080>，能进 GUI 就成功。**先让 dsh-web 保持运行**（装插件后要重启它；可以用两个终端，或装完 Ctrl+C 再启动）。

> 3080 被占用用 `dsh web --port 3090`；想换 DSH 数据位置，先设 `DSH_HOME`（如 `D:\dsh-home`）再启动。

## 三、安装并配置 NapCat（QQ 协议端）

1. 安装 **NapCatQQ**（QQNT + NapCat 的 Windows 安装器，按其文档安装；需要先装/使用它自带的 QQNT）。
2. 启动 NapCat，打开其 **WebUI**（默认 <http://127.0.0.1:6099>），用手机 QQ **扫码登录**小号。
3. 在 WebUI 的 **OneBot v11** 配置里开启两个服务（都在 `127.0.0.1`，不要暴露公网）：
   - **WebSocket 服务（正向）**：端口 `3001`
   - **HTTP 服务 / HTTP API**：端口 `3000`
   - 若设置了 token：记下来，后面填进实例配置。
4. 点「保存」并**重启 NapCat**，确认 QQ 仍在线。

> NapCat 的 OneBot 配置文件通常在 NapCat 安装目录的 `config\onebot11_<QQ号>.json`；
> 不同版本界面略有差异，以 NapCat 官方文档为准。
> **验证**：PowerShell 里执行 `curl.exe http://127.0.0.1:3000` 应能连上（返回 JSON/404 都算 TCP 通）。

## 四、安装本插件

Windows 常用写法是命令行装本地目录；GitHub / tgz / 插件管理器等其它装法见
[安装与卸载 §三](安装与卸载.md#三安装本插件三选一)。

```powershell
# 本地目录（link: 方式，改代码立即生效）
dsh plugin --profile web add link:C:\path\to\dsh-onebot-qq
```

> 路径含空格时用引号：`dsh plugin --profile web add "C:\my bots\dsh-onebot-qq"`。
> 📁 命令里的相对路径（`node bin\dsh-onebot-qq.mjs`、`examples\`、`node --test`）以**包目录**为基准：
> 源码仓库跑 = 仓库根（如 `C:\src\dsh-onebot-qq`）；tgz 装进 profile = `%USERPROFILE%\.dsh\profiles\web\node_modules\dsh-onebot-qq`。
> （tgz 的 `files` 不含 `test/`，所以**离线测试只能在源码仓库根跑**。）

**重启 dsh-web**（Ctrl+C 后重新 `dsh web`），日志出现 `dsh-onebot-qq` 输出即挂载成功；还没填 QQ 号会进入「待配置模式」，按 §六 填即可：

```
[onebot-qq:kernel] 内核就绪（契约 v1，插件 13/13，工具 10，命令 7）
```

## 五、创建数据目录（含默认人设）

### 方式 A：PowerShell 脚本（推荐，Windows 专属）

```powershell
# 在包目录里执行（默认数据目录 %USERPROFILE%\.dsh\dsh-onebot-qq）
powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1

# 或自定义数据目录（建议短路径，避免长路径问题）
powershell -ExecutionPolicy Bypass -File .\examples\windows\setup.ps1 -DataDir 'C:\dsh-data\qq-bot'
```

> ⚠️ 脚本只复制文件、**不激活人设**；要 init 的完整效果（自动投递默认人设）用跨平台 CLI
> `node bin\dsh-onebot-qq.mjs init [--data-dir ...]`，与全手动建目录的做法一并见
> [安装与卸载 §四](安装与卸载.md#四首次配置推荐控制台新手向导)
> （不跑也行：插件首次启动会自动投递内置默认人设「蓝色大肥鱼」）。

### 自定义数据目录要同时告诉插件

`--data-dir` / `-DataDir` 只写那个目录下的 config.json，插件默认仍读 `%USERPROFILE%\.dsh\dsh-onebot-qq`。
推荐**设环境变量再启动 dsh**（在启动 dsh 的同一个终端里）：

```powershell
$env:DSH_QQ_DATA_DIR = 'C:\dsh-data\qq-bot'
dsh web
```

> 另一种做法是改 profile patch（`%USERPROFILE%\.dsh\profiles\web\cordis.patch.yml` 里给 `dsh-onebot-qq`
> 行加 `config.dataDir`，整块替换、字段写全），见 [安装与卸载 §四](安装与卸载.md#四首次配置推荐控制台新手向导)。

## 六、首次启动与新手向导（推荐）

> **不用先手改 JSON**：缺 `adminQq` 时插件进入「**待配置模式**」（控制台可用、不连 NapCat），日志会提示缺什么；
> 控制台填完保存后**自动连接**（无需重启）。`qq-chat` preset、「QQ 聊天」工作区、默认人设都由插件自动装好。

1. **启动**：
   ```powershell
   dsh web
   ```
   日志会看到（此时**没有**「NapCat WS 已连接」是预期）：
   ```
   [onebot-qq:kernel] 实例配置未完成（缺 adminQq）…控制台可继续配置
   [onebot-qq:kernel] 内核就绪（契约 v1，插件 13/13，工具 10，命令 7）
   ```
2. **打开控制台填写**：浏览器打开 <http://127.0.0.1:3080> → **设置 → QQ 控制台**：
   - **总览 → 新手向导**：逐项 ✅/❌（配置文件 / 主人 QQ / NapCat 连接 / 人设 / 生图），每项一句「怎么做」；
   - **NapCat 连接**页：`wsUrl` / `httpUrl` / token（**「测试 NapCat 连接」/「重新连接」按钮在「运维」页**，先保存再测）；
   - **生图**页：协议 / API 地址 / 模型 / API Key（可选，不配不影响聊天）；人设已自动投递，换人设见 [使用说明书 §6](使用说明书.md#6-人设怎么写)。
3. **填写顺序**：主人 QQ → NapCat 地址/token（离开输入框即保存）→ 到「运维」点「测试 NapCat 连接」→ 插件自动连接，向导里 NapCat 项变 ✅ 就能发消息。

### 手动填写配置（备选）

用记事本/VS Code 打开 `%USERPROFILE%\.dsh\dsh-onebot-qq\config.json`（或你的 `--data-dir` 下），字段说明见
[安装与卸载 §四](安装与卸载.md#四首次配置推荐控制台新手向导)。**Windows 路径写法**（JSON 里 `\` 是转义符）：

- 用**正斜杠**（`"C:/dsh-data/qq-bot"`）或双反斜杠（`"C:\\dsh-data\\qq-bot"`），避免转义错误；
- 相对路径（如 `"workspace"`）相对**数据目录**解析，跨机器迁移最省事；
- 必填 `adminQq` / `napcat.wsUrl` / `napcat.httpUrl`；NapCat 开了鉴权就填 `wsToken` / `httpToken`；
- 生图凭据建议用环境变量（见 §九），不要写进 JSON；**手改配置后要重启一次 dsh-web**（控制台改是热生效）。

自检：`node bin\dsh-onebot-qq.mjs doctor`（无 QQ/NapCat 时加 `--no-net`）；❌ 项修完再启动，⚠️（如 symlink 不可用、NapCat 未启动）属正常提示。

## 七、启动与验证

1. NapCat 在线、QQ 已登录；控制台「测试 NapCat 连接」返回 ok，或日志出现 `[onebot-qq:napcat] NapCat WS 已连接`；
2. 私聊「ping」→ 有回复；群里 @ 机器人「ping」→ 有回复；
3. `/status`（仅主人）→ 有回执；发一张本地图（`a.png` 放进 `<dataDir>\workspace\` 后说「发一下 a.png」）→ QQ 收到图；
4. 重启 `dsh web` 后再发一条 → 仍是同一个 DSH 会话；异常走控制台「运维 → 🩺 一键诊断」，报告在 `<dataDir>\reports\`。

> 验收四步的完整口径（服务/连接证据/真实请求/能力抽检）见 [安装与卸载 §五](安装与卸载.md#五启动与验收)。

## 八、人设切换（copy 降级）

Windows 普通用户默认**不能创建文件软链**，`persona use` 会自动改用**复制模式**（功能完全正常）：

```powershell
node bin\dsh-onebot-qq.mjs persona list
node bin\dsh-onebot-qq.mjs persona use 蓝色大肥鱼
```

- `init` 已自动投递过「蓝色大肥鱼」；想换成自带模板或自己的：`persona use 蓝色大肥鱼` / `persona use <你的名字>`；
- 结果里 `mode` 会是 `copy`；`workspace\` 下会出现 `AGENTS.local.md` / `lines.txt` / `wake.txt` 等**真实文件**；
- 之后换人设 = 再跑一次 `persona use <名字>`（覆盖复制）；
- 想用软链：Windows 设置 → 隐私和安全性 → 开发者选项 → 打开「开发者模式」；
- `config.json` 的 `pluginConfig.persona-voice.activePersona` 会被同步写入（保证配置优先级不盖过文件）。

## 九、图片 / 生图 / 表情包

1. **发本地图**（`send_image`）：图片必须在 `file-transfer.imageWhitelist` 内（默认数据目录 + 系统临时目录），放进 `<dataDir>\workspace\a.png` 即可。
2. **生图**（`generate_image`）：控制台「生图」页填 **协议 / API 地址 / 模型 / API Key**，到「运维」点「检查生图配置」；
   或设环境变量（推荐，**环境变量优先于输入框**）：
   ```powershell
   # 在启动 dsh 的同一个终端里设置；也可写进系统环境变量
   $env:QQ_IMAGEGEN_PROTOCOL = 'openai-images'   # 或 openai-chat（中转站用 chat/completions 出图时）
   $env:QQ_IMAGEGEN_BASE_URL = 'https://example.invalid/v1'
   $env:QQ_IMAGEGEN_API_KEY  = 'YOUR_API_KEY'
   $env:QQ_IMAGEGEN_MODEL    = 'gpt-image-2'
   dsh web
   ```
   协议怎么选、冷却与失败不重试等规则见 [使用说明书 §5.4](使用说明书.md#54-生图--图生图)。
3. **表情包**：群里发过的表情自动入库（`<dataDir>\qq-stickers`）；用法与开关见 [使用说明书 §5.6](使用说明书.md#56-表情包)。
4. **入群欢迎**：图片放 `<dataDir>\qq-welcome-images`；群开关与欢迎语见 [使用说明书 §5.7](使用说明书.md#57-入群欢迎)。

### CQ 文件引用真机验证清单（重要）

Windows 上「本地文件 → QQ 图片」依赖 NapCat 对 OneBot `file=` 参数的支持，**不同版本行为可能不同**。
在真机上验证一次，选定后写进部署环境（默认 `fwd`）：

| # | `DSH_QQ_MEDIA_REF` | 发送路径形式 | 预期 |
|---|---|---|---|
| 1 | `fwd`（默认） | `C:/dsh-data/qq-bot/workspace/a.png` | 能收到图 |
| 2 | `fwd` | 含空格：`C:/my data/a b.png` | 能收到图 |
| 3 | `fwd` | 含中文：`C:/dsh-data/图片/猫.png` | 能收到图 |
| 4 | `fwd` | 含逗号：`C:/dsh-data/a,b.png` | 能收到图（CQ 转义 `,`） |
| 5 | `fileUri` | `file:///C:/dsh-data/qq-bot/workspace/a.png` | 能收到图 |
| 6 | `fileUri` | 含空格/中文路径 | 能收到图 |
| 7 | `fwd` | 网络盘/UNC：`\\server\share\a.png` | 视 NapCat 权限（通常不行，建议放本地盘） |

切换方式（PowerShell，启动 dsh 前设置）：

```powershell
$env:DSH_QQ_MEDIA_REF = 'fileUri'   # 或 'fwd'（默认）
dsh web
```

> 失败时先看 `[onebot-qq:file-transfer]` / `[onebot-qq:imagegen]` 日志与 NapCat 日志；
> 确认 NapCat 与 DSH 在**同一台机器**、同一用户可读这些文件。

## 十、没有 QQ 时的离线验证（fake）

没装好 NapCat 也能验证内核与工具链路：

```powershell
# ⚠️ 必须在「源码仓库根」执行（tgz 装进 profile 的包里不含 test/）：
node --test
node --test test\e2e.test.js   # 只跑假 NapCat 端到端（本机动态端口，无需网络）
```

- `node --test` 会跑全部测试，包括：装配、出站脱敏、五阶段、配置迁移、CLI、假 NapCat 的
  入站→模型(mock)→工具→出站 全链路；
- 也可以把 `config.json` 的 bundle 配置 `autoConnect: false`，只验证「配置能加载、工具能注册」；
- `node bin\dsh-onebot-qq.mjs doctor --no-net` 检查环境与配置。

## 十点五、两条需真机验证的事项

1. **逗号转义分两种**：正文/图片说明里的 `,` 保持原样（不再转义，避免聊天里出现 `&#44;`）；
   只有 CQ 参数（如 `file=` 的本地路径）里的 `,` 才转成 `&#44;`。正常 NapCat 会还原；
   若路径含逗号时发图失败，记录 NapCat 版本并反馈（可先试 `DSH_QQ_MEDIA_REF=fileUri`）。
2. **可选 `:3971` 兼容网关的图片白名单**：`/send-image` 默认只认平台临时目录；
   要发站点图片目录，必须在实例配置 `compat.imageRoots` 里显式列出这些目录（绝对路径），
   否则会返回「禁止发送白名单目录外的图片」。

## 十一、已知限制（Windows）

| 限制 | 影响 | 处理 |
|---|---|---|
| 普通用户无 symlink 权限 | 人设投递走 copy 模式 | 功能正常；想用软链开「开发者模式」 |
| `chmod 600` 基本无效 | 配置权限靠 ACL | 用 `icacls` 收紧（见 [安装与卸载 §九](安装与卸载.md#九权限与凭据)） |
| 长路径 >260 字符 | 可能 `ENAMETOOLONG` | 数据目录放短路径（`C:\dsh-data\qq-bot`） |
| 杀毒/索引器占用文件 | 原子写 rename 偶发失败 | 内核自动重试 3 次；仍失败看日志 |
| NapCat 文件引用形式不统一 | 发图可能失败 | 按上面 7 组清单实测，切 `DSH_QQ_MEDIA_REF` |
| 没有 systemd/cron | 自检/定时任务不可用 | 用 Windows 任务计划程序；或挂 ops provider（[运维接口](运维接口.md)） |
| DSH 重启 = 机器人重启 | 进程内形态的固有特性 | 会话映射可恢复；重启前确认没有进行中的回合 |

## 十二、Windows 专属排查

> 通用排障（日志在哪、连不上 NapCat、图片发不出等）见 [排错](排错.md)；下表只收 Windows 专属问题。

| 现象 | 处理 |
|---|---|
| `dsh : 无法将“dsh”项识别为...` | `npm install -g` 的 bin 目录不在 PATH；重开终端或 `npm bin -g` 找到路径加 PATH |
| `dsh web` 打不开 3080 | 端口冲突/防火墙；`dsh web --port 3090` |
| PowerShell 执行脚本被拦 | `-ExecutionPolicy Bypass`（见 setup.ps1 用法）；或改用 `node bin\dsh-onebot-qq.mjs init` |
| 配置里反斜杠报 JSON 错误 | 用正斜杠 `C:/...` 或双反斜杠 `C:\\...` |
| 中文乱码 | 配置/句池文件保存为 **UTF-8（无 BOM）**；内核会剥 BOM，但其他工具可能不认 |
| 连不上 NapCat | NapCat 与 DSH 是否同一台机器/同一用户；`curl.exe http://127.0.0.1:3000`；token |
| 发图失败 | 见上面 CQ 引用清单 + 白名单；路径尽量短、纯 ASCII 先排除路径因素 |
| 控制台打不开 | 用 `http://127.0.0.1:3080`（不要用主机名/公网 IP；loopback 限制） |
| 想一次性收集排障信息 | 控制台 →「运维」→ 🩺 一键诊断；报告落在 `<dataDir>\reports\`，可直接贴给 DSH 修复 |

## 十三、完成清单

- [ ] `node --version` >= 22；`dsh --version` 在 0.2.x
- [ ] NapCat 在线、QQ 已登录；WS 3001 / HTTP 3000 开启
- [ ] 插件装进 `web` profile，重启后日志有「内核就绪」
- [ ] `config.json` 填好 `adminQq` + NapCat 地址/ token；`doctor` 无 ❌
- [ ] 日志有「NapCat WS 已连接」
- [ ] 私聊 + 群 @ 文本往返成功
- [ ] 发图成功（必要时切换 `DSH_QQ_MEDIA_REF` 并记录）
- [ ] 人设切换成功（copy 或 symlink）
- [ ] 重启 dsh-web 后会话连续
- [ ] `node --test` 在 Windows 全绿（或 CI windows-latest 绿）
