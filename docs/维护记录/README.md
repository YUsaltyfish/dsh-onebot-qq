# QQ 机器人维护记录

> 用途：记录**本机（服务器）对 `dsh-onebot-qq` 插件做的热修与行为调整**，供外部主机/上游仓库迭代、同步、上传 GitHub 时对照。
> 这里的条目按**日期**归档，一天一个文件；配套的 `patches/` 目录放可直接 `git apply` 的补丁。

---

## 一、这是什么、和 GitHub 的关系

| 项 | 说明 |
|---|---|
| 插件仓库 | `dsh-onebot-qq`（GitHub：`YUsaltyfish/dsh-onebot-qq`） |
| 本机仓库副本 | 服务器上的本地 clone，**没有配置 remote**（不直接 push） |
| 本机运行形态 | DSH profile `web` 的依赖，安装源为 `github:YUsaltyfish/dsh-onebot-qq` |
| 本机实际加载的代码 | `<DSH_HOME>/profiles/web/node_modules/dsh-onebot-qq/`（即仓库文件被复制/链接过来的那份） |
| opsgate | 独立包 `dsh-onebot-qq-opsgate`，本机以**本地 tgz**（`file:`）安装，源码不在本机 |

**关键流程**：服务器上只做"热修 + 记录"。因为 `pnpm` 重装/升级会用 GitHub 上的版本覆盖 `node_modules`，所以：

1. 本机改代码 → 立即生效需重启 dsh-web；
2. 把改动记录到本目录 + 生成 patch；
3. 外部主机按 patch 更新 GitHub 仓库、提交、发布（升版本/打 tgz）；
4. 本机再按标准安装流程升级（此时热修被正式版本取代）。

> ⚠️ **不要只改 `node_modules` 而不记录**：下次 `pnpm install` 会把热修悄悄冲掉，而且没人知道线上跑的和仓库里不一样。

---

## 二、目录与命名

```
QQ机器人维护记录/
├── README.md                       ← 本文件（规范 + 索引）
├── YYYY-MM-DD.md                   ← 每天一个维护记录
└── patches/
    └── YYYY-MM-DD-<主题>.patch     ← 当天代码改动的 git patch（git apply 可直接用）
```

约定：

- 一天一个文件，文件名就是日期；同一天多次维护追加到同一文件（按"变更 1/2/3"编号）。
- 记录里写**仓库相对路径**（如 `kernel/pacing.js`），不写服务器绝对路径，方便公开到 GitHub。
- **不写**真实 QQ 号、群号、token、API key、服务器 IP、内网地址；用「实例配置里的主人 QQ」「某个群」指代。
- 每条变更都要能回答：**为什么改、改了哪些文件、怎么验证、怎么回滚、外部主机要做什么**。

---

## 三、单日记录模板

```markdown
# YYYY-MM-DD 维护记录

## 概览
| 序号 | 主题 | 类型 | 涉及文件 | 状态 |

## 变更 N：<一句话主题>
### 背景 / 现象
### 根因
### 代码变更（逐文件 + 关键 diff）
### 配置/接口变化
### 验证
### 已知限制 / 待办
```

---

## 四、索引

| 日期 | 主题 | 涉及文件 | 状态 | 记录 |
|---|---|---|---|---|
| 2026-10-22 | QQ 登录状态真实检测 + 主动接话「冷场找话」开关（**已提交，待重启验证**）；群记忆自动积累（**已复原，仅留设计留档**） | `kernel/napcat-adapter.js`、`index.js`、`admin/endpoints.js`、`client.js`、`kernel/pacing.js`、`kernel/config-store.js`、`admin/schema.js`、`docs/配置参考.md` | 登录/冷场：`3df2991`；积累：`18b6db8` 已由 `b4fab27` 复原 | [2026-10-22.md](2026-10-22.md) |

> 更早的变更（插件重命名、历史会话归位、opsgate 工具门等）已在仓库 git 历史或对应上游提交里，不再重复记录。

---

## 五、每次同步到 GitHub 的检查清单

1. `cd <插件仓库> && git status` —— 确认改动文件与记录一致；
2. `git apply --check <patch>` 或直接 `git add` 对应文件；
3. 提交信息按 `feat(...)` / `fix(...)` 写，正文列动机与影响面（见当天记录末尾的"建议 commit message"）；
4. `node --test`（仓库根目录）全绿；
5. 更新 `CHANGELOG.md` 与版本号（本次是否发版由上游决定）；
6. 推送后，本机按正式版本重装，并删除对应的临时热修记录（或标注"已入库"）。
