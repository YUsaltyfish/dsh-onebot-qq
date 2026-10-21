# dsh-onebot-qq

DSH插件式的QQ机器人，经 [NapCat](https://napcat.napneko.icu/) 的 OneBot v11 协议收发消息。
微内核 + 可插拔子插件，**Linux / Windows通用**，装完在控制台填几项就能用。

![license](https://img.shields.io/badge/license-MIT-blue) ![node](https://img.shields.io/badge/node-%3E%3D22-green) ![dsh](https://img.shields.io/badge/dsh-%3E%3D0.2.1--rc.2-7c3aed)

> **先读**：[`docs/使用说明书.md`](docs/使用说明书.md)（使用说明书：安装 → 连接 → 各功能怎么用 → 人设怎么写）。
> 想自己装：本文「安装」；只想让 DSH 帮你装：把 [`docs/安装前准备.md`](docs/安装前准备.md) 甩给它。

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
| NapCat | QQNT 客户端 + OneBot v11；需开启**正向 WebSocket** 与 **HTTP API** |
| QQ 号 | NapCat 登录用（建议小号）；机器人靠它收发消息 |

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

> **可选**：想让 QQ 线连**全局工具**（`ops_*` / agent-team / MCP 资源）也挡住，再装配套的独立插件 `dsh-onebot-qq-opsgate`：
> `dsh plugin --profile web add github:YUsaltyfish/dsh-onebot-qq-opsgate`（必须装在 `dsh-onebot-qq` 之后）。
> 不装也能正常用，只是 QQ 会话的工具面更大，token消耗略微增加，可能导致群聊天时调用不该用的工具而产生风险。详见 [`docs/安装与卸载.md`](docs/安装与卸载.md)。

> **可选**：「看视频 / 看视频链接」需要另跑一个本地解析侧车（ffmpeg 抽帧，独立服务）；不装也完全不影响聊天，只是视频/链接按普通消息处理。

## 快速开始（4 步）

1. NapCat 登录 QQ，开启 WebSocket（默认 `ws://127.0.0.1:3001`）与 HTTP（默认 `http://127.0.0.1:3000`），记下 token（可空）。
2. DSH 设置 →「QQ 控制台」→「NapCat 连接」填地址/token → 点「测试 NapCat 连接」。
3. 「群聊」页顶部填**主人 QQ**（必填）→ 保存后自动连接。
4. 在 QQ 里 @ 机器人（或私聊）→ 有回复即可用。

> 首次启动缺 `adminQq` 会进入「待配置模式」：控制台和工具可用、不连 NapCat，填完自动连接。

## 控制台与人设

- **控制台**集成在 DSH 内置设置页，可配置程度高：16 个页签、热改即生效。
- **人设**可以直接让 AI 照随包的 `personas/_模板.md` 写一份；优秀程度看用心程度，推荐让模型多用示范对话。

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/使用说明书.md`](docs/使用说明书.md) | **使用说明书（先看这个）** |
| [`docs/安装前准备.md`](docs/安装前准备.md) | 装之前：还要另外准备什么（只有 2 项）+ 验收 |
| [`docs/安装与卸载.md`](docs/安装与卸载.md) | 安装 / 升级 / 卸载 / 首次配置 |
| [`docs/配置参考.md`](docs/配置参考.md) | 实例配置 v2 全部键、路径规则、凭据、控制台热改 |
| [`docs/Windows安装.md`](docs/Windows安装.md) | Windows 从零到跑通 + 真机验证清单 |
| [`docs/排错.md`](docs/排错.md) | 连不上 NapCat、工具不出现、图片发不出 |
| [`docs/插件开发.md`](docs/插件开发.md) | 子插件契约、`bot` 能力表、五阶段、红线 |
| [`docs/架构说明.md`](docs/架构说明.md) | 实现契约（贡献者必读） |
| [`docs/运维接口.md`](docs/运维接口.md) | 可选运维外设接口（自检/清理等不进包） |

## 隐私

- 包内**不含**任何真实 QQ 号、群号、token、API Key 或服务器路径；示例都是占位值。
- 运行数据（配置、人设、表情库、群记忆、日志）都在你自己的数据目录，不进仓库、不进 npm 包。

## License

[MIT](LICENSE)

---

> ⚠️ 请注意：本项目的主要贡献来自于蓝色大肥鱼——本人由于能力限制，仅通过不断“压力”大肥鱼来进行代码编写和部分细节调整。因此也诚邀同好者共同测试和维护。

> [!WARNING]
> 本插件和文档由 AI 生成，内容仅供参考，请仔细甄别。
