# Changelog

所有值得用户知道的变更记在这里。格式参考 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，版本号遵循语义化版本。

## 未发布 — 2026-10-23

群记忆正确性与控制台修复（不新增功能、不改对外配置键）：

### 修复

- **写侧改用未截断原文**：积累器合并/备份不再拿读侧 24KB 截断文本当基准；超过 `maxBytes` 的尾部不再每轮丢失，旧版误写进正文的「…已截断」提示会在下次合并时清掉。
- **水位口径**：`digestedAt` 改为「本轮实际喂给模型的最新消息 ts」，不再用 `Date.now()`（模型调用期间新到的消息不再被误标已消化）。
- **采样可见**：每群超出 `accumulateMsgPerGroup` / `accumulateMaxChars` 的条数计入 `sampledOut`（日志 + 结果行），不再静默丢弃。
- **digest 解析 0 条不推水位**：模型把要点写成段落/表格时记 failed、下轮重试，不再当「无新增」跳过。
- **单轮群数上限可配 + 轮转**：新增 `accumulateMaxGroupsPerRound`（默认 12），配合游标轮转，大号段群不再永久饿死。
- **合并质量**：同 QQ 重复画像归一、`；**昵称(QQ)**` run-on 拍平、`这轮/本轮` 临时内容丢弃、每节按条数 + 字节预算裁剪（优先保「群里的人」），文件稳定在读取上限内。
- **`.revisions` 统一保留**：积累器与控制台 `-manual` 备份共用命名/`accumulateRetainRevisions`；死群多余版本每轮收掉。
- **控制台保存**：保存上限跟随 `maxBytes`；带 `ifMtime` 的乐观并发校验（防止旧编辑器覆盖新积累）；写盘 0600；`dir` 限制在数据目录内；唤醒词里的非群号数字键不再让「群记忆」页整页崩掉；保存后状态自动跟随。
- **生命周期**：定时器接入 `bot.onDispose()`（新增 bot 能力，向后兼容），插件重载不再叠出第二个 60s 定时器。
- **文档/注释**：配置参考补 `accumulateMaxGroupsPerRound`、采样/水位口径；开发指南补 `bot.onDispose`；修正「后台会话禁止调用任何工具」等过时注释。
- **撤回失败不再回显 NapCat 原始报错**：适配器把 `NTEvent / EventRet / decode failed` 原文只写日志、对外返回人话；`gate-wake` 的撤回失败回执也只发人话。修复 2026-10-23 15:37 把整段内部报错发进群的问题。
- **`/history` 上限 200 → 500**：`plugins/commands/index.js` 的 `HISTORY_MAX` 放宽（默认仍 50）；500 条约 23KB / 7.6K token，拉取仍在适配器 8s 超时内。
- **修复点赞通知制造空对话**：NapCat 的点赞通知（`profile_like`）没有 `user_id`/`group_id`，归一后 chatKey 变成 `private:undefined`，又被「私聊永远算被叫」放行 → 出现两个空模型回合、并建出 `private:undefined` 的 DSH 会话。现在：无身份 notice 直接丢弃（format）、notice 一律不进模型（gate-wake）、非法 chatKey 在 runTurn 第二道防线丢弃。
- **表情包新增「收表情（会写索引）」开关，默认关**：关着时库只读（不采集/不打标/不清理/不记使用，`index.json` 一个字节都不写），机器人仍能挑现有图发；控制台「表情包」页顶部显示库数量/标签数，并说明当前是只读还是可写。默认关是为了防「运行中改索引被内存副本覆盖」（2026-10-20 标签丢失的根因）。
- **拆条支持 2~N 条**：`pacing.reply.style.splitMaxParts`（默认 3，控制台「主动接话 → 高级」），按自然句末拆、绝不拦腰砍句；只对模型经 `send_message` 写的正文生效，命令回执/答应声不拆；>120 字的长文仍走长文卡片。
- **表情包实际发出率**：`send_message` 新增 `sticker` 参数（发正文时顺手带一张，省一步工具调用）；提示词改成「顺手带一张 + 给出现成参数」；若本轮掷骰命中但还没发，`send_message` 的返回里会再轻推一次（最多 2 次）。
- **生图参考图对模型可见**：`before-turn` 每轮列一行 `[参考图库:…]`（不做关键词门槛），`generate_image` 的 `image` 可直接写图库里的文件名；**不做代码侧模糊匹配** —— 选哪张由模型判断，名字不在库里就报错并附清单，让模型自己重挑（选错在冷却之前，不花钱）。绝对路径仍只走白名单。
- **生图新增「额外请求字段（JSON）」**：`pluginConfig.imagegen.extraBody`（多行文本，默认空），控制台「生图」页可改。不同平台字段不同，由用户自己补：文生图并进 JSON 请求体、图生图逐项追加为 multipart 字段、`openai-chat` 协议并进 `/chat/completions` 顶层。典型用法：sensenova／商汤默认给图加水印，填 `{"watermark": false}` 关掉。留空 = 与旧版行为完全一致；非法 JSON 直接报错、不发请求。

### 测试

- 新增 `test/audit-group-memory-fixes.test.js`（6 条）与 4 条控制台用例；全量 `node --test` 209/209。

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
