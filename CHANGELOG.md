# Changelog

所有值得用户知道的变更记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## 0.1.1 — 2026-10-21

新增 4 个可选子插件（来自社区 PR #1），并修掉 review 发现的问题。

### 新增

- `anti-repeat`：同一个人同一句话刷屏冷却（超过次数甩一句 + 整线冷却，零 token）。
- `private-friend-gate`：私聊只回好友（好友列表缓存；拉取失败时 fail-open，不误伤）。
- `video-read` / `video-link-read`：群视频 / B 站·抖音链接抽帧给模型看（需要本地解析侧车；没装或没起时自动降级）。
- 控制台对应开关（「唤醒」页防刷屏、「文件与图片」页看视频、「其他」页私聊门禁）。

### 修复（review）

- 移除 `video-read` 的排障 trace（不再写临时日志），并给被引消息加负缓存。
- `video-link-read` 移除 `blockParserAfterRead`：`link-parser` 在 intercept 阶段已经处理，before-turn 拦不住，原选项语义相反。
- `video-link-read` 补上缺失的 `onlyWhenAddressed` 配置。
- `bot.napcat` 契约补充 `friendList / msgById / getFile`；README / 说明书 / 架构文档同步为 13 个子插件。

## 0.1.0 — 2026-10-20

首个公开发布版本：把内部迭代收敛成一个**可安装、开箱即用**的 DSH 插件。

### 新增

- **DSH 原生插件包**：`dsh.bundle.patch` 随包声明，一行挂载；in-process 运行，无需独立进程 / systemd。
- **微内核 + 9 个子插件**：`gate-wake` / `commands` / `file-transfer` / `persona-voice` / `group-welcome` / `imagegen` / `link-parser` / `stickers` / `group-memory`，目录自动发现、按 order 排序、坏一个不拖垮整体。
- **五阶段入站管线**：`pre-gate` → `passive-tap` → `intercept` → `wake` → `before-turn`。
- **唯一出站口**：文本走 `deliver()`、媒体走 `sendMedia()`；自动抽 `[AT:]`、六项脱敏、插件装饰、发送 + 留档。
- **QQ 控制台**：16 个页签，配置热改（原子写 + 备份 + 失败回滚）；**子插件 ↔ 页面 1:1**（生图凭据归 `imagegen`、人设句池归「句池」、门禁与唤醒归「唤醒」），低频配置统一在「其他」页。
- **开箱人设**：内置「蓝色大肥鱼」人设 + `_模板.md`，首次启动自动投递；唤醒词与人设词合并生效。
- **QQ 侧能力**：收/发图片、生图与图生图（`openai-images` / `openai-chat` 两种协议）、群头像、表情包自动收集与发表情、入群欢迎、链接解析（可选侧车）、群记忆注入。
- **跨平台**：Linux / Windows / macOS；Windows 路径、临时目录、CQ 文件引用、原子写、软链不可用时的人设 copy 降级都在 `platform/` 收口。
- **CLI**：`node bin/dsh-onebot-qq.mjs init | doctor | import-legacy | persona`。
- **测试与守卫**：`node --test`（含假 NapCat 端到端）、打包清单守卫、私有信息扫描。

### 说明

- 数据目录默认 `$DSH_HOME/dsh-onebot-qq`；从旧名 `dsh-qq-bot` 升级时**自动沿用旧目录**，无需迁移。
- 配置里不携带任何真实 QQ 号 / 群号 / 密钥 / 服务器路径；所有示例均为占位值。
