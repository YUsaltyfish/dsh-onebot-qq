/**
 * group-memory — 群记忆子插件（id: 'group-memory'，order: 90）
 *
 * 设计：**没有数据库** —— 每个群一篇人可读的 Markdown（`<群号>.md`），文件本身就是全部状态。
 *
 * 两部分职责：
 *   A. **读取侧**（每次回话前）：① before-turn 给一行"指针"；② 工具 read_memory 按群读那一篇；③ 按 mtime+size 缓存。
 *   B. **积累侧**（后台定时）：按配置的间隔，取各群最近的聊天留档 → 交给模型合并/更新这一篇 Markdown。
 *      实现拆在同目录 `accumulate.js`（同一子插件、同一组配置），由本文件 setup 时接线。
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
import { createAccumulator } from './accumulate.js'

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

    // ── 自动积累（本插件自带定时器，不需要外部 cron）──────────────────
    accumulateEnabled: {
      type: 'bool', default: true, group: '群记忆', label: '自动积累群记忆',
      hint: '开：按下面的间隔，把各群最近的聊天交给模型，自动更新记忆文件；关：完全不跑（仍可手动「立刻积累一轮」）。',
    },
    accumulateIntervalHours: {
      type: 'int', default: 8, min: 1, max: 24, step: 1, group: '群记忆', label: '积累间隔', unit: '小时',
      hint: '多久跑一轮。每轮会为「有新消息的群」各调用一次模型；群多时可以把间隔调长。',
    },
    accumulateLookbackHours: {
      type: 'int', default: 8, min: 1, max: 72, step: 1, group: '群记忆', label: '回看最近多少小时', unit: '小时',
      hint: '每轮只取最近这段时间的聊天留档来更新记忆（更早的内容已经在记忆文件里了）。',
    },
    accumulateMsgPerGroup: {
      type: 'int', default: 200, min: 20, max: 1000, step: 20, group: '群记忆', label: '每群最多取多少条',
      hint: '从最近的消息往前取；条数越多越准，token 也越多。',
    },
    accumulateMaxChars: {
      type: 'int', default: 8000, min: 1000, max: 30000, step: 500, group: '群记忆', label: '每群正文上限', unit: '字',
      hint: '喂给模型的聊天正文最多多少字符（超出从最早的消息开始丢）。',
    },
    accumulateMinNewMsgs: {
      type: 'int', default: 20, min: 0, max: 500, step: 5, group: '群记忆', label: '少于多少条就跳过',
      hint: '某个群最近消息太少时跳过、不调模型（省 token）。0 = 只要有一条就积累。',
    },
    accumulateRetainRevisions: {
      type: 'int', default: 20, min: 0, max: 200, step: 5, group: '群记忆', label: '保留多少历史版本',
      hint: '每次改写前把旧版备份到 .revisions/，只保留最近 N 份（0 = 不备份）。',
    },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    // 目录以实例配置为准（内核已解析成绝对路径）；缺省退回 <dataDir>/qq-memory
    const dataDirOf = () => String(bot.core?.dataDir || '.')
    const dirOf = () => String(cfg.dir || '').trim() || path.join(dataDirOf(), 'qq-memory')
    const maxBytesOf = () => Math.max(1000, Number(cfg.maxBytes) || 24000)
    const cache = new Map() // 文件路径 -> { stamp, text }：文件没改就不重复读盘
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

    function groupIdOf(ev) {
      if (!ev || !ev.isGroup) return null
      const gid = String(ev.groupId ?? '')
      if (/^\d{4,12}$/.test(gid)) return gid
      const m = /^group:(\d{4,12})$/.exec(String(ev.chatKey || ''))
      return m ? m[1] : null
    }

    /** 超过上限按**整行**截断：先按字节砍到上限，再退到最后一个换行（免得切碎多字节字符）。 */
    function clip(text) {
      const maxBytes = maxBytesOf()
      if (Buffer.byteLength(text, 'utf8') <= maxBytes) return text
      const cut = Buffer.from(text, 'utf8').subarray(0, maxBytes).toString('utf8')
      const nl = cut.lastIndexOf('\n')
      return cut.slice(0, nl > 0 ? nl : cut.length).replace(/\r$/, '') + '\n…（本群记忆过长已截断，请精简文件）'
    }

    const fileOf = (gid) => path.join(dirOf(), `${gid}.md`)

    /**
     * 读一个群的记忆（只读）。返回 `{ text, stamp }`，没有文件返回 null。
     * `stamp = mtimeMs:size`：文件没改就不重复读盘；改了（积累器原子写回）就自然换新版。
     */
    function readMemory(gid) {
      const file = fileOf(gid) // gid 已过 4–12 位纯数字校验 → 不会有路径穿越
      let st
      try { st = fs.statSync(file) } catch { return null } // 没文件 = 没记忆
      const stamp = `${st.mtimeMs}:${st.size}`
      const hit = cache.get(file)
      let text
      if (hit && hit.stamp === stamp) {
        text = hit.text
      } else {
        try { text = stripBom(fs.readFileSync(file, 'utf8')) } catch { return null }
        // 剥掉条目尾部的记账注释（`<!-- n=3 ... -->`）：机器人不该看到记账信息，也省 token
        text = text.replace(/[ \t]*<!--[^>]*-->[ \t]*$/gm, '')
        cache.set(file, { stamp, text })
      }
      return { text: clip(text).trim(), stamp }
    }

    // ── 入口 ①：before-turn 只推一行指针（首次 / 有更新；未变化 0 字符） ──────────
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev.wake) return // 没唤醒的消息不进模型，提示串也没用
      if (ev.wake.kind === 'welcome') return // 入群欢迎轮不该被"读群记忆"的指针分心
      const gid = groupIdOf(ev)
      if (!gid) return
      const mem = readMemory(gid)
      if (!mem) return // 没记忆文件 = 什么都不加（积累器还没跑过）
      const prev = getSeen(ev.chatKey)
      if (!prev) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push('[本群记忆: 调工具 read_memory 可看本群的说话风格与群友画像；'
          + '第一次在本群回话前建议先读一次。**认人只看 QQ 号**（群友常换昵称，同一人换了名字仍是同一人）]')
        log.debug(`[群记忆] ${gid} 本会话首次 → 只给指针（${mem.text.length} 字不再贴正文）`)
      } else if (prev !== mem.stamp) {
        setSeen(ev.chatKey, mem.stamp)
        ev.hint.push('[本群记忆已更新，需要时调 read_memory 重读]')
        log.debug(`[群记忆] ${gid} 内容有更新 → 只给指针`)
      } else {
        log.debug(`[群记忆] ${gid} 未变化，本轮不提示`) // 0 字符
      }
    })

    // ── 入口 ②：工具 read_memory（只读本群那一篇；群里没有文件权限，这是唯一的"翻记忆"路） ──
    bot.registerTool('read_memory', {
      description:
        '读本群的长期记忆：这个群怎么把机器人叫起来、该怎么回话（语气/长度/称呼/忌讳），以及群里每个人的特点。\n'
        + '这份记忆与人设解耦：里面提到机器人自己一律用「我」，不写人设。'
        + '**认人只看 QQ 号**：条目形如 `- **昵称(QQ)**：…`，群里的人常换昵称，同一个 QQ 换了名字仍是同一个人'
        + '（按 QQ 对上他，别当成新面孔）。第一次在本群回话前建议先读一次；同一会话读一次就够，'
        + '之后收到「本群记忆已更新」提示时再重读。只对群会话有效，读不到本群以外的任何文件。',
      // DSH `defineTool` 的 parameters 是**扁平**的「属性名 → 值 schema」映射；required 写在属性上。
      parameters: {
        target: { type: 'string', required: true, description: '会话目标，形如 group:123456（通常填本轮会话，见开头 [QQ会话 …]）' },
      },
      execute(args) {
        const target = String(args?.target || '')
        const m = /^group:(\d{4,12})$/.exec(target) // 4–12 位纯数字：顺手挡路径穿越，也挡住唤醒词表里的 "*"
        if (!m) throw new Error('read_memory 只对群会话有效（target 形如 group:123456）')
        if (cfg.enabled === false) throw new Error('群记忆读取已关闭')
        const gid = m[1]
        // 只读本群：拿本轮会话当边界。别的群号不可能是本轮 → 拒绝，别让这条路变成读别的群
        const turn = bot.currentTurn()
        if (turn && turn.chatKey && turn.chatKey !== target) {
          throw new Error(`只能读本群记忆（本轮会话是 ${turn.chatKey}，不是 ${target}）`)
        }
        const mem = readMemory(gid)
        if (!mem) return { ok: true, target, memory: '', hint: '本群还没有记忆文件（积累器还没跑过）' }
        log.info(`[群记忆] 自读 ${gid} → ${mem.text.length} 字`)
        return { ok: true, target, group_id: gid, chars: mem.text.length, memory: mem.text }
      },
    })

    // ── 积累侧：实现拆在同目录 accumulate.js（同一子插件、同一组配置），这里只负责接线 ──
    const accumulator = createAccumulator({
      bot,
      cfg,
      log,
      dataDirOf,
      memoryDirOf: dirOf,
      readMemoryOf: readMemory,
      invalidateMemoryOf: (gid) => cache.delete(fileOf(gid)),
    })
    bot.shared.memoryAccumulate = accumulator.manual
    bot.shared.memoryAccumulateStatus = accumulator.status
    bot.shared.memoryAccumulateSync = accumulator.sync
    accumulator.start()
  },
}
