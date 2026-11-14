/**
 * group-memory — 群记忆子插件（id: 'group-memory'，order: 90）
 *
 * 设计：**没有数据库** —— 每个群一篇人可读的 Markdown（`<群号>.md`），文件本身就是全部状态。
 *
 * 两部分职责：
 *   A. **读取侧**（每次回话前）：① before-turn 给一行"指针"；② 工具 read_memory 按群读那一篇；③ 按 mtime+size 缓存。
 *   B. **积累侧**（每日定时）：逐会话整理本机器人参与的互动 → 由模型提交新增/修改/移除。
 *      实现拆在同目录 `daily.js`（同一子插件、同一组配置），由本文件 setup 时接线。
 *
 * 三条纪律（踩出来的结论，别改）：
 *  ① **只给指针，绝不贴正文**。历史上曾把记忆正文拼进 prompt → 它拼在**用户消息**里，模型会误当成
 *     "群友说的话"（出错概率高）；每次更新还往历史里再塞一份，白烧上下文。正文只在模型**自己调工具**时进上下文。
 *  ② **写盘只有一处**：`writeMemory()`（备份到 `.revisions/` → 原子写）。读取侧永远不写。
 *  ③ **认人只看 QQ 号**：条目形如 `- **昵称(QQ)**：…`，群友常换昵称、号码不变；同一人换了名字仍是同一人。
 *     指针与工具描述里都把这条写给模型。
 *
 * 平台边界：默认目录是相对 dataDir 的短路径（内核 resolve 成绝对）；读文件剥 UTF-8 BOM（Windows 编辑器常见）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { stripBom } from '../../platform/atomic.js'
import { createDailyAccumulator, visibleMemoryText } from './daily.js'

export default {
  id: 'group-memory',
  title: '群记忆',
  order: 90,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '群记忆', label: '群记忆（指针注入）', hint: '开：把本群历史要点作为提示注入上下文，帮它记住群里的事；关：不读记忆。' },
    dir: {
      type: 'str', default: 'qq-memory', group: '群记忆', label: '记忆目录',
      hint: '相对路径由内核按数据目录解析；每群一篇 <群号>.md',
    },
    maxBytes: {
      type: 'int', default: 24000, min: 1000, max: 200000, step: 1000, group: '群记忆', label: '单篇读取上限（字节）',
      hint: '超了按**整行**截断（不切碎多字节字符），末尾注明"过长已截断"',
    },
    mutedChats: {
      type: 'str', default: '', group: '群记忆', label: '关闭记忆的会话（每行一条）',
      hint: '列在这的会话**不再读记忆、也不再积累**（自动/手动积累都跳过）；已有记忆文件仍可在控制台查看/编辑/删除。\n'
        + '格式：群写 group:群号，私聊写 private:QQ号；逗号或换行分隔，留空 = 全部开启。\n'
        + '控制台「群记忆」页每个会话右边的 🔔/🔕 改的就是这项。',
    },

    // ── 自动积累（本插件自带定时器，不需要外部 cron）──────────────────
    accumulateEnabled: {
      type: 'bool', default: true, group: '群记忆', label: '自动处理记忆',
      hint: '每天按下面的时间整理本机器人参与的互动；关后仍可手动立即处理待办。',
    },
    accumulateModelProvider: {
      type: 'str', default: '', group: '群记忆', label: '记忆分析模型提供商',
      hint: '后台记忆分析专用的 DSH provider 标识，与模型 ID 成对填写；两项留空沿用默认模型，不改变 QQ 聊天模型。',
    },
    accumulateModel: {
      type: 'str', default: '', group: '群记忆', label: '记忆分析模型 ID',
      hint: '填写 DSH 模型目录中的内部 ID，不是显示名。指定模型不可用时保留待办并报错，不自动换模型。',
    },
    accumulateDailyTime: {
      type: 'str', default: '04:00', group: '群记忆', label: '每日执行时间',
      hint: '24 小时制 HH:mm；按下方时区执行。停机错过后恢复补跑一次。',
    },
    accumulateTimezone: {
      type: 'str', default: 'Asia/Shanghai', group: '群记忆', label: '执行时区',
      hint: 'IANA 时区，例如 Asia/Shanghai；无效时间或时区会停止调度并显示错误。',
    },
    accumulateRecentDays: {
      type: 'int', default: 14, min: 1, max: 90, group: '群记忆', label: '近期经历保留天数',
      hint: '仅近期经历自动到期；稳定记忆与未完成约定不按此时间自动删除。',
    },
    accumulateRetainRevisions: {
      type: 'int', default: 20, min: 0, max: 200, step: 5, group: '群记忆', label: '保留多少历史版本',
      hint: '每次改写前把旧版备份到 .revisions/，只保留最近 N 份（0 = 不备份；控制台手改的 -manual 备份也按这个数清理）。',
    },
    accumulateMaxGroupsPerRound: {
      type: 'int', default: 12, min: 1, max: 200, step: 1, group: '群记忆', label: '单轮最多处理多少个群',
      hint: '群与私聊合计的单轮会话预算，其余下轮轮转处理；调大将延长单轮处理时间。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    // 目录以实例配置为准（内核已解析成绝对路径）；缺省退回 <dataDir>/qq-memory
    const dataDirOf = () => String(bot.core?.dataDir || '.')
    const dirOf = () => String(cfg.dir || '').trim() || path.join(dataDirOf(), 'qq-memory')
    const maxBytesOf = () => Math.max(1000, Number(cfg.maxBytes) || 24000)
    const rawCache = new Map() // 文件路径 -> { stamp, text }：原文（不截断）；读写两侧共用，只读一次盘
    const fallbackSeen = new Map() // 当 bot.state 不可用时的兜底

    function getSeen(chatKey) {
      const st = bot.state?.get?.(chatKey)
      if (st) return st._scratch?.['group-memory:seen']
      return fallbackSeen.get(chatKey)
    }
    function setSeen(chatKey, stamp) {
      const st = bot.state?.get?.(chatKey)
      if (st) {
        st._scratch = st._scratch || Object.create(null)
        st._scratch['group-memory:seen'] = stamp
      } else {
        fallbackSeen.set(chatKey, stamp)
      }
    }

    /** 当前会话线 key：群 = `group:<群号>`；私聊 = `private:<QQ号>`。认不出返回 null。 */
    function lineKeyOf(ev) {
      if (!ev) return null
      const key = String(ev.chatKey || '')
      if (/^(?:group|private):\d{4,12}$/.test(key)) return key
      if (ev.isGroup) {
        const gid = String(ev.groupId ?? '')
        if (/^\d{4,12}$/.test(gid)) return `group:${gid}`
      }
      return null
    }
    const lineIdOf = (key) => {
      const k = String(key)
      if (k.startsWith('private:')) return k.slice('private:'.length)
      if (k.startsWith('group:')) return k.slice('group:'.length)
      return k
    }
    const isPrivateLine = (key) => String(key).startsWith('private:')

    /**
     * 控制台「关闭记忆的会话」：逗号/空白分隔，形如 group:123456 / private:10001。
     * 每次现读 bot.cfg（热改立即生效）；非法项直接忽略，不让一处脏数据把整页/积累打挂。
     */
    function mutedKeys() {
      const out = new Set()
      for (const raw of String(bot.cfg?.mutedChats || '').split(/[\s,，]+/)) {
        const s = raw.trim()
        if (/^(?:group|private):\d{4,12}$/.test(s)) out.add(s)
      }
      return out
    }
    const isMuted = (chatKey) => mutedKeys().has(String(chatKey || ''))

    /** 超过上限按**整行**截断：先按字节砍到上限，再退到最后一个换行（免得切碎多字节字符）。 */
    function clip(text) {
      const maxBytes = maxBytesOf()
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
      const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
      const nl = cut.lastIndexOf('\n')
      return cut.slice(0, nl > 0 ? nl : cut.length).replace(/\r$/, '') + '\n…（记忆过长已截断，请精简文件）'
    }

    /** 记忆文件：群 `<dir>/<群号>.md`；私聊 `<dir>/private/<QQ号>.md`（分目录，避免群号/QQ号撞名）。 */
    const fileOf = (key) => (isPrivateLine(key)
      ? path.join(dirOf(), 'private', `${lineIdOf(key)}.md`)
      : path.join(dirOf(), `${lineIdOf(key)}.md`))

    /**
     * 读原文（只剥 BOM，**不按 maxBytes 截断**）。记账信息（条目 ID、时间、元数据页脚）
     * 在这层保留，给写盘和人工对账用；只有 readMemory() 给模型时才隐藏。
     * `stamp = mtimeMs:size`：文件没改就不重复读盘；改了（每日整理/控制台写回）就自然换新版。
     *
     * ⚠️ 写盘必须用原文：拿截断后的文本当基准，超过 maxBytes 的尾部会被丢掉。
     */
    function loadRaw(key) {
      const file = fileOf(key) // key 已过 group:/private: + 4–12 位纯数字校验 → 不会有路径穿越
      let st
      try { st = fs.statSync(file) } catch { return null } // 没文件 = 没记忆
      const stamp = `${st.mtimeMs}:${st.size}`
      const hit = rawCache.get(file)
      if (hit && hit.stamp === stamp) return hit
      let text
      try { text = stripBom(fs.readFileSync(file, 'utf8')) } catch { return null }
      // 原文保留条目 ID / 来源等元数据，积累器据此安全更新；只在聊天读取时剥除。
      const rec = { stamp, text, bytes: Buffer.byteLength(text, 'utf8') }
      rawCache.set(file, rec)
      return rec
    }

    /** 给积累器/备份用：不截断。 */
    function readRaw(key) {
      const r = loadRaw(key)
      return r ? { text: r.text, stamp: r.stamp, bytes: r.bytes } : null
    }

    /** 给模型用：按 maxBytes 截断（只影响进上下文的文本，不影响写盘基准）。 */
    function readMemory(key) {
      const r = loadRaw(key)
      if (!r) return null
      // 记账信息（条目 ID、更新/到期时间、文末元数据）只服务写盘与人工编辑，不喂给模型。
      const visible = visibleMemoryText(r.text)
      const text = clip(visible).trim()
      return { text, stamp: r.stamp, clipped: text.length < visible.trim().length, bytes: r.bytes }
    }

    // ── 入口 ①：before-turn 只推一行指针（首次 / 有更新；未变化 0 字符） ──────────
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev.wake) return // 没唤醒的消息不进模型，提示串也没用
      if (ev.wake.kind === 'welcome') return // 入群欢迎轮不该被"读记忆"的指针分心
      const key = lineKeyOf(ev)
      if (!key) return
      if (isMuted(ev.chatKey)) {
        log.debug(`[群记忆] ${key} 会话记忆已关闭 → 不注入指针`)
        return
      }
      const mem = readMemory(key)
      if (!mem) return // 没记忆文件 = 什么都不加（积累器还没跑过）
      const prev = getSeen(ev.chatKey)
      const priv = isPrivateLine(key)
      if (!prev) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push(priv
          ? '[本私聊记忆: 调工具 read_memory 可看对方的偏好、称呼与回话约定；'
            + '第一次在这里回话前建议先读一次。**认人只看 QQ 号**]'
          : '[本群记忆: 调工具 read_memory 可看本群的共同经历、相处约定与待办；'
            + '第一次在本群回话前建议先读一次。**认人只看 QQ 号**（群友常换昵称，同一人换了名字仍是同一人）]')
        log.debug(`[群记忆] ${key} 本会话首次 → 只给指针（${mem.text.length} 字不再贴正文）`)
      } else if (prev !== mem.stamp) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push(priv ? '[本私聊记忆已更新，需要时调 read_memory 重读]' : '[本群记忆已更新，需要时调 read_memory 重读]')
        log.debug(`[群记忆] ${key} 内容有更新 → 只给指针`)
      } else {
        log.debug(`[群记忆] ${key} 未变化，本轮不提示`) // 0 字符
      }
    })

    // ── 入口 ②：工具 read_memory（只读本群那一篇；群里没有文件权限，这是唯一的"翻记忆"路） ──
    bot.registerTool('read_memory', {
      description:
        '读本会话（本群或本私聊）的记忆：共同经历、明确偏好与边界、相处约定和未完成事项。仅在相关时自然使用；旧记忆不覆盖当前明确纠正，记忆缺失不代表从未发生。\n'
        + '这份记忆与人设解耦：里面提到机器人自己一律用「我」，不写人设。'
        + '**认人只看 QQ 号**：条目形如 `- **昵称(QQ)**：…`，人常换昵称，同一个 QQ 换了名字仍是同一个人'
        + '（按 QQ 对上他，别当成新面孔）。第一次在本会话回话前建议先读一次；同一会话读一次就够，'
        + '之后收到「记忆已更新」提示时再重读。只能读本轮会话那一篇，读不到别的群/私聊。',
      // DSH `defineTool` 的 parameters 是**扁平**的「属性名 → 值 schema」映射；required 写在属性上。
      parameters: {
        target: { type: 'string', required: true, description: '会话目标，形如 group:123456 或 private:10001（通常填本轮会话，见开头 [QQ会话 …]）' },
      },
      execute(args) {
        const target = String(args?.target || '')
        const m = /^(group|private):(\d{4,12})$/.exec(target) // 4–12 位纯数字：顺手挡路径穿越，也挡住唤醒词表里的 "*"
        if (!m) throw new Error('read_memory 的 target 形如 group:123456 或 private:10001')
        if (cfg.enabled === false) throw new Error('记忆读取已关闭')
        if (isMuted(target)) throw new Error('这个会话的记忆已关闭（控制台「群记忆」页把它的开关打开即可）')
        // 只读本轮会话：别的群/私聊不可能是本轮 → 拒绝，别让这条路变成读别处的记忆
        const turn = bot.currentTurn()
        if (turn && turn.chatKey && turn.chatKey !== target) {
          throw new Error(`只能读本会话记忆（本轮会话是 ${turn.chatKey}，不是 ${target}）`)
        }
        const mem = readMemory(target)
        if (!mem) return { ok: true, target, memory: '', hint: '这个会话还没有记忆文件（积累器还没跑过）' }
        log.info(`[群记忆] 自读 ${target} → ${mem.text.length} 字${mem.clipped ? '（已按上限截断）' : ''}`)
        return {
          ok: true, target, chars: mem.text.length, memory: mem.text,
          ...(m[1] === 'group' ? { group_id: m[2] } : { private_id: m[2] }),
          ...(mem.clipped ? { clipped: true, hint: `记忆原文 ${mem.bytes} 字节，超过读取上限，已按整行截断；需要完整内容请让人在控制台调大 maxBytes 或精简文件` } : {}),
        }
      },
    })

    // ── 入口 ③：工具 memory_append（只给积累后台任务用；结构化提交，替代 `<<<GROUP>>>` 文本解析）──
    // 内核的工具守卫只允许「群记忆积累后台会话」调用它；普通 QQ 会话调会被拒。
    bot.registerTool('memory_append', {
      description:
        '记忆整理后台任务专用，普通聊天不可调用。通过 operations JSON 数组提交本会话的新增、修改、移除；无变更为 []。'
        + '只可提交当前任务允许的会话，成功后不要重复提交。',
      parameters: {
        target: { type: 'string', required: true, description: '会话目标：群写 group:群号，私聊写 private:QQ号（prompt 里【群 …】/【私聊 …】的号码，原样抄）' },
        operations: { type: 'string', description: 'JSON 操作数组，op 为 add/update/remove；条目包含 id、section(stable/recent/promises)、text、sourceIds；无变更传 []。严格遵守当前后台任务提示。' },
        batchId: { type: 'string', description: '必填：原样复制当前任务的 batchId，仅可提交该批次。' },
      },
      execute(args, exec) {
        const submit = bot.shared.memoryAccumulateSubmit
        if (typeof submit !== 'function') throw new Error('群记忆积累器未启用，无法提交')
        return submit(args, exec)
      },
    })

    // ── 积累侧：实现在同目录 daily.js（同一子插件、同一组配置），这里只负责接线 ──
    const accumulator = createDailyAccumulator({
      bot,
      cfg,
      log,
      dataDirOf,
      memoryDirOf: dirOf,
      readMemoryOf: readRaw,
      invalidateMemoryOf: (key) => rawCache.delete(fileOf(key)),
      maxBytesOf,
      // 积累器内部 key：群 = 群号，私聊 = private:<QQ号>；会话开关直接用 chatKey 判断
      mutedOf: (key) => isMuted(String(key).startsWith('private:') ? key : `group:${key}`),
    })
    bot.shared.memoryAccumulate = accumulator.manual
    bot.shared.memoryAccumulateStatus = accumulator.status
    bot.shared.memoryAccumulateSync = accumulator.sync
    bot.shared.memoryAccumulateSubmit = accumulator.submit
    bot.shared.memoryAccumulateStop = accumulator.stop
    accumulator.start()
    // fiber 卸载时清掉 60s 定时器，避免插件重载叠出第二个实例（onDispose 老内核可缺席）。
    try { bot.onDispose?.(() => { try { accumulator.stop() } catch { /* ignore */ } }) } catch { /* ignore */ }
  },
}
