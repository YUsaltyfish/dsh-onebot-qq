# dsh-onebot-qq

DSH插件式的QQ机器人，经 OneBot v11 协议收发消息 —— 协议端可换：任意 OneBot v11 实现都行（本机线上在用的是 [SnowLuma](https://github.com/SnowLuma/SnowLuma)，另有 [OneBot](https://onebot.napneko.icu/) 等实现）。
微内核 + 可插拔子插件，**Linux / Windows通用**，装完在控制台填几项就能用。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-7c3aed)

> **先读**：[`docs/README.md`](docs/README.md)（功能手册总览：按「我要做什么」找文档 + 全部功能索引）。
> 日常用：[`docs/使用说明书.md`](docs/使用说明书.md)（安装 → 连接 → 各功能怎么用 → 人设怎么写）。
> 想自己装：本文「安装」；只想让 DSH 帮你装：把 [`docs/安装与卸载.md`](docs/安装与卸载.md)（Windows 用 [`docs/Windows安装.md`](docs/Windows安装.md)）整份甩给它。

## 特性

| 能力 | 说明 |
|---|---|
| **DSH 原生插件** | `dsh.bundle.patch` 随包声明、一行挂载；纯 in-process，无独立进程 / systemd |
| **高可塑性** | 想要什么功能自己向DSH许愿 |
| **微内核 + 自带 13 个子插件** | 门禁唤醒 / 命令 / 文件 / 人设句池 / 入群欢迎 / 生图 / 链接解析 / 表情包 / 简易群记忆 + 4 个可选（防刷屏 / 私聊好友门禁 / 看视频 / 看视频链接）；目录自动发现，坏一个不影响其他 |
| **唯一出站口** | 文本只走 `deliver()`、媒体只走 `sendMedia()`；自动抽 `[AT:]` → 六项脱敏 → 插件装饰 → 发送 + 留档 |
| **QQ 控制台** | 16 个页签、配置热改（原子写 + 备份 + 回滚）；子插件↔页面 1:1；低频配置集中「其他」页，全部带悬停解释 |
| **开箱人设** | 内置「蓝色大肥鱼」+ `_模板.md`，首次启动自动投递；唤醒词与人设词合并生效，控制台可增删 |
| **QQ 侧能力** | 收发图片、生图/图生图（`openai-images` / `openai-chat`）、群头像、表情包自动收集、入群欢迎、群记忆注入、可选链接解析 |
| **跨平台** | 路径 / 临时目录 / CQ 文件引用 / 原子写 / 人设软链降级全在 `platform/` 收口 |
| **高扩展性** | 同“可塑性” |

## 前置要求

| 组件 | 要求 |
|---|---|
| Node.js | `>= 22` |
| DSH | `>= 0.2.1-rc.2 < 0.3.0`（`engines.dsh` 声明） |
| 协议端（任选其一） | 任意 **OneBot v11** 实现（如 **SnowLuma** v2.x：token 必填、不自己启动 QQ；**OneBot**：token 可空）；都需开启**正向 WebSocket**（常见默认 3001）与 **HTTP API**（常见默认 3000），见 [安装与卸载 §二](docs/安装与卸载.md#二准备协议端onebot-v11) |
| QQ 号 | 协议端登录用（建议小号）；机器人靠它收发消息 |

## 安装

### ① 装插件（三选一）

```bash
# GitHub（推荐）
dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq

# 本地 tgz（npm pack 产物）
dsh plugin --profile web add /abs/path/dsh-onebot-qq-0.1.1.tgz

# 本地目录（改代码立刻生效）
dsh plugin --profile web add link:/abs/path/dsh-onebot-qq
```

也可以在 DSH 桌面端的「设置 → 插件」里填 GitHub 仓库地址安装。

> 装完还要「建数据目录 → 启动 → 控制台新手向导连协议端」才算跑通：完整步骤、升级、卸载、回滚见 [`docs/安装与卸载.md`](docs/安装与卸载.md)；Windows 见 [`docs/Windows安装.md`](docs/Windows安装.md)。

> **可选**：想让 QQ 线连**全局工具**（`ops_*` / agent-team / MCP 资源）也挡住，再装配套的独立插件 `dsh-onebot-qq-opsgate`：
> `dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq-opsgate`（必须装在 `dsh-onebot-qq` 之后）。
> 不装也能正常用，只是 QQ 会话的工具面更大，token消耗略微增加，可能导致群聊天时调用不该用的工具而产生风险。详见 [`docs/安装与卸载.md`](docs/安装与卸载.md)。

> **可选**：「看视频 / 看视频链接 / 链接解析」需要**自己准备一个本地解析侧车**（独立小服务）；不装也完全不影响聊天，详见下节 [解析侧车](#可选解析侧车链接解析--看视频--看视频链接)。

## 快速开始（4 步）

1. 协议端登录 QQ，开启 WebSocket（默认 `ws://127.0.0.1:3001`）与 HTTP（默认 `http://127.0.0.1:3000`），记下 token（多数实现可空，**SnowLuma 必填**）。
2. DSH 设置 →「QQ 控制台」→「OneBot 连接」页（任意 OneBot v11 协议端都填这里）填地址/token → 点「测试 OneBot 连接」。
3. 「群聊」页顶部填**主人 QQ**（必填）→ 保存后自动连接。
4. 在 QQ 里 @ 机器人（或私聊）→ 有回复即可用。

> 首次启动缺 `adminQq` 会进入「待配置模式」：控制台和工具可用、不连协议端，填完自动连接。

## 控制台与人设

- **控制台**集成在 DSH 内置设置页，可配置程度高：16 个页签、热改即生效。
- **人设**可以直接让 AI 照随包的 `personas/_模板.md` 写一份；优秀程度看用心程度，推荐让模型多用示范对话。

## 可选：解析侧车（链接解析 / 看视频 / 看视频链接）

> 这三个功能**本仓库不附带**，要你自己跑一个本地小服务。不装也完全不影响聊天与其余功能。

### 「侧车」是什么

主插件只负责**在 QQ 里收发消息、拼提示词、调模型**。而「下载 B 站/抖音视频、用 ffmpeg 抽帧转码」这类活儿需要额外装 Python/ffmpeg、可能还要登录 cookie，体积大、坑多，不适合塞进插件包 ——
所以把它拆成**一个独立的小 HTTP 服务**跑在同一台机器上，插件通过 HTTP 调它干活。这种「主程序旁边挂一个专职小服务」的做法叫 **sidecar（侧车）**：像摩托车的跨斗，自己不跑，但能载货。

### 哪些功能依赖它

| 功能 | 子插件 | 默认 | 调用的接口 | 没有侧车时 |
|---|---|---|---|---|
| **链接解析**（B站/抖音链接 → 直接把视频、图集发到群里） | `link-parser` | **关** | `POST /parse` | 链接按普通消息交给模型（模型只看到链接文字） |
| **看视频**（群里发的视频 → 抽几帧给模型看） | `video-read` | **开** | `POST /read` | 群里如实回一句「看视频的服务没起来」 |
| **看视频链接**（B 站/抖音链接的视频 → 抽帧给模型看） | `video-link-read` | **开** | `POST /read` | 同上 |

> ⚠️ 后两个**默认是开的**：没装侧车时，群里一出现视频/视频链接，机器人就会说「看视频的服务没起来，这视频我看不了」。
> 不想看到这句 → 控制台「文件与图片」页把这两个开关关掉；想用 → 按下面搭个侧车。

### 自己搭侧车，最少要实现什么

一个监听本机端口的 HTTP 服务（默认 `3972`）即可，语言随意（Python / Node / Go），只要实现两个 JSON 接口：

**① `POST /parse`** —— 链接解析（`link-parser` 用）

```jsonc
// 请求
{ "url": "https://b23.tv/xxxx", "session": "会话标识（可忽略）", "limit": 9 }
// 响应
{
  "media":   [ { "path": "/tmp/xxx.mp4", "kind": "video", "size": 1234567 },
               { "path": "/tmp/y1.jpg",  "kind": "image", "size": 88000  } ],
  "skipped": [ { "reason": "too_big", "cover": "/tmp/cover.jpg" } ]   // 可选：跳过的原因 + 兜底封面
}
```
> `kind` 取 `video` / `image`；`path` 必须是**本机真实文件**（插件直接读它发到 QQ）。视频没合流成功时，用 `skipped[].cover` 先发封面。

**② `POST /read`** —— 看视频（`video-read` / `video-link-read` 用）

```jsonc
// 请求
{ "url": "/tmp/in.mp4 或 https://b23.tv/xxxx", "platform": "bilibili",
  "frames": 8, "maxSide": 1024, "maxSeconds": 600 }
// 成功
{ "ok": true, "durationSec": 95, "title": "视频标题", "platform": "bilibili",
  "frames": [ { "path": "/tmp/f1.jpg", "sec": 0 }, { "path": "/tmp/f2.jpg", "sec": 12 } ] }
// 失败（机器人有对应的中文回执）
{ "ok": false, "code": "too_long", "error": "时长超过 600s" }
```
> `code` 只认这几个词，其余都按「没看成」处理：
> `too_long`（太长）/ `too_big`（太大）/ `busy`（正忙）/ `nomatch`（链接打不开）/ `download_failed`（下载失败，常见于平台要求登录）。

### 侧车本身需要装什么

- **ffmpeg** —— 抽帧、B 站 DASH 音视频合流，**视频功能必需**（不装就只能发封面/图文）；
- **下载器** —— `yt-dlp` 或各平台自己的接口；抖音通常需要配 cookie，否则会 `download_failed`；
- **运行环境** —— Python 3 或 Node，随你顺手。

### 怎么开启与配置

| 位置 | 要做什么 |
|---|---|
| 控制台 →「链接解析」页 | 打开「链接解析」；「侧车地址」填 `http://127.0.0.1:3972`（默认值） |
| 控制台 →「文件与图片」页 | 「让模型看视频内容」/「点开 B 站 / 抖音链接看视频」两个开关 + 各自的「侧车地址」 |
| 配置键（手改 `config.json` 时） | `pluginConfig.link-parser.parserUrl`、`pluginConfig.video-read.sidecarUrl`、`pluginConfig.video-link-read.sidecarUrl` |

- 地址**留空 = 不解析/不看**（等于关掉该功能）；
- 侧车换个端口/换台机器也能用（跨机器就把 `127.0.0.1` 换成那台机器的内网 IP，注意别把侧车暴露到公网）；
- 侧车自己也要卡体积/时长（插件侧还有一道 `maxBytes` 上限，默认 100MB）。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/README.md`](docs/README.md) | **功能手册总览（先看这个）**：按任务找文档 + 全部功能索引 |
| [`docs/使用说明书.md`](docs/使用说明书.md) | 功能怎么用：控制台、生图、表情、群记忆、人设与句池 |
| [`docs/安装与卸载.md`](docs/安装与卸载.md) | 安装 / 首次配置 / 升级 / 卸载 / 回滚 |
| [`docs/开发指南.md`](docs/开发指南.md) | 架构与子插件 SDK（贡献者 / 二次开发必读） |

其余文档（Windows、配置参考、排错、运维接口）统一从 [功能手册总览](docs/README.md) 进。

## 隐私

- 包内**不含**任何真实 QQ 号、群号、token、API Key 或服务器路径；示例都是占位值。
- 运行数据（配置、人设、表情库、群记忆、日志）都在你自己的数据目录，不进仓库、不进 npm 包。

## License

[MIT](LICENSE)

---

> ⚠️ 请注意：本项目的主要贡献来自于蓝色大肥鱼——本人由于能力限制，仅通过不断“压力”大肥鱼来进行代码编写和部分细节调整。因此也诚邀同好者共同测试和维护。

> [!WARNING]
> 本插件和文档由 AI 生成，内容仅供参考，请仔细甄别。
