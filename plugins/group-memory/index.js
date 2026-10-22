/**
 * group-memory — 群记忆子插件（id: 'group-memory'，order: 90）
 *
 * 设计：**没有数据库** —— 每个群一篇人可读的 Markdown（`<群号>.md`），文件本身就是全部状态。
 *
 * 两部分职责：
 *   A. **读取侧**（每次回话前）：① before-turn 给一行"指针"；② 工具 read_memory 按群读那一篇；③ 按 mtime+size 缓存。
 *   B. **积累侧**（后台定时）：按配置的间隔，取各群最近的聊天留档 → 交给模型合并/更新这一篇 Markdown。
 *      积累跑在一个**独立的一次性后台会话**里（不占 QQ 线、不允许调工具），写完原子落盘并留历史版本。
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
import { stripBom, readJsonFile, writeJsonFileSync, atomicWriteFileSync } from '../../platform/atomic.js'
import { ensureDir } from '../../platform/paths.js'

/** 历史版本子目录（与旧版布局一致）。 */
const REVISIONS = '.revisions'

/** 单次级联上限：一轮最多处理多少个群（防止首次开启时一口气跑几十个模型调用）。 */
const MAX_GROUPS_PER_ROUND = 12

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

    // ══════════════════════════════════════════════════════════════════
    //  积累侧：定时器 + 手动触发；写盘唯一入口 writeMemory()
    // ══════════════════════════════════════════════════════════════════
    const num = (v, d, min, max) => {
      const n = Number(v)
      const base = Number.isFinite(n) ? n : d
      return Math.max(min, Math.min(max, base))
    }
    const accumulateOn = () => cfg.accumulateEnabled !== false
    const intervalMs = () => num(cfg.accumulateIntervalHours, 8, 1, 24) * 3600 * 1000
    const lookbackMs = () => num(cfg.accumulateLookbackHours, 8, 1, 72) * 3600 * 1000
    const msgPerGroup = () => Math.round(num(cfg.accumulateMsgPerGroup, 200, 20, 1000))
    const maxCharsOf = () => Math.round(num(cfg.accumulateMaxChars, 8000, 1000, 30000))
    const minNewMsgs = () => Math.round(num(cfg.accumulateMinNewMsgs, 20, 0, 500))
    const retainRevisions = () => Math.round(num(cfg.accumulateRetainRevisions, 20, 0, 200))
    const archiveDirOf = () => String(bot.core?.archive?.dir || '').trim() || path.join(dataDirOf(), 'logs', 'qq_chat')
    const stateFileOf = () => path.join(dataDirOf(), 'state', 'group-memory.json')

    // 积累状态（落盘：重启后不立刻重跑；也给控制台显示"上次/下次"）
    let state = {}
    try { state = readJsonFile(stateFileOf()) || {} } catch { state = {} }
    let lastRunAt = Number(state.lastRunAt) || 0
    let lastResult = state.lastResult && typeof state.lastResult === 'object' ? state.lastResult : null
    let running = null // Promise | null：单飞锁
    let lastError = ''
    const bootAt = Date.now() // 首次启动缓冲：没有 lastRunAt 时也先等 5 分钟再跑，避免重启即抢模型

    const saveState = () => {
      try { writeJsonFileSync(stateFileOf(), { lastRunAt, lastResult, lastError }) } catch (e) { log.warn(`[群记忆] 状态写入失败: ${e.message}`) }
    }

    /** 群号清单：聊天留档里出现过的群 ∪ 已有记忆文件的群。 */
    function listGroupIds() {
      const ids = new Set()
      let names = []
      try { names = fs.readdirSync(archiveDirOf()) } catch { names = [] }
      for (const n of names) {
        const m = /^group_(\d{4,12})\.jsonl(?:\.\d+)?$/.exec(n)
        if (m) ids.add(m[1])
      }
      try {
        for (const n of fs.readdirSync(dirOf())) {
          const m = /^(\d{4,12})\.md$/.exec(n)
          if (m) ids.add(m[1])
        }
      } catch { /* 目录还没建 */ }
      return [...ids].sort()
    }

    /** 读某群最近的聊天留档（jsonl，含轮转文件），返回按时间升序的 `{ ts, who, text, out }`。 */
    function readRecentMessages(gid) {
      const dir = archiveDirOf()
      let names = []
      try {
        names = fs.readdirSync(dir)
          .filter((n) => new RegExp(`^group_${gid}\\.jsonl(?:\\.(\\d+))?$`).test(n))
          .map((n) => ({ n, mtime: (() => { try { return fs.statSync(path.join(dir, n)).mtimeMs } catch { return 0 } })() }))
          .sort((a, b) => a.mtime - b.mtime) // 旧 → 新
          .map((x) => x.n)
      } catch { return [] }
      const since = Date.now() - lookbackMs()
      const out = []
      for (const n of names) {
        let text = ''
        try { text = fs.readFileSync(path.join(dir, n), 'utf8') } catch { continue }
        for (const line of text.split('\n')) {
          const s = line.trim()
          if (!s) continue
          let row
          try { row = JSON.parse(s) } catch { continue }
          const ts = Number(row?.ts) || 0
          if (ts && ts < since) continue
          const msg = String(row?.text ?? '').replace(/\s+/g, ' ').trim()
          if (!msg) continue
          if (/^\[CQ:[^\]]+\]$/.test(msg)) continue // 纯图片/表情占位不喂给模型
          const outbound = row?.dir === 'out'
          const nick = String(row?.sender?.nickname || row?.sender?.card || '').trim()
          const qq = String(row?.sender?.qq ?? '').trim()
          out.push({ ts, out: outbound, who: outbound ? '机器人' : (nick && qq ? `${nick}(${qq})` : (nick || qq || '未知')), text: msg })
        }
      }
      out.sort((a, b) => a.ts - b.ts)
      return out.slice(-msgPerGroup())
    }

    /** 把一批消息压成正文（超字符上限从最早的开始丢）。 */
    function transcriptOf(rows) {
      const lines = rows.map((r) => `${r.out ? '→' : ''}[${r.who}] ${r.text}`)
      let total = 0
      const kept = []
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        total += lines[i].length + 1
        if (total > maxCharsOf()) break
        kept.push(lines[i])
      }
      kept.reverse()
      return kept.join('\n')
    }

    /** 组装积累提示词：给旧记忆 + 最近聊天，要求输出**完整**的更新后 Markdown。 */
    function buildPrompt({ gid, oldText, transcript }) {
      return [
        '你是 QQ 群聊机器人背后的「群记忆维护员」。任务：根据最近的群聊，更新这个群的长期记忆文件。',
        '',
        '【当前记忆文件】（可能为空；格式是 Markdown，标题层级与条目的写法要保持）',
        oldText && oldText.trim() ? oldText.trim() : '（空，这是第一次积累）',
        '',
        '【最近聊天】（`→` 开头的是机器人自己说的话；`昵称(QQ号)` 是发言人）',
        transcript || '（无）',
        '',
        '【输出要求】',
        '1. 只输出**更新后的完整记忆文件正文**（Markdown），不要解释、不要寒暄、不要用 ``` 代码块包裹。',
        '2. 保持原有结构和写法：记录「这个群怎么把机器人叫起来 / 该怎么回话（语气、长度、称呼、忌讳）」和「群里的人」。',
        '3. 群友条目写成 `- **昵称(QQ)**：特点`；**认人只看 QQ 号**，昵称变了要合并到同一个 QQ，不要新增重复条目。',
        '4. 把最近聊天里的**稳定信息**合并进去（性格、口头禅、常聊话题、群规矩、对机器人的要求）；',
        '   一次的闲聊、临时话题、没有信息量的刷屏不要写。不要编造聊天里没有的内容。',
        '5. 过时或明显不对的旧条目要修正或删掉；宁缺毋滥，总长度控制在 20000 字以内。',
        '6. 记忆里提到机器人自己一律用「我」，不要写人设。',
        '',
        '现在直接输出更新后的完整 Markdown：',
      ].join('\n')
    }

    /** 剥掉模型可能加的代码块围栏 / 开场白，返回纯 Markdown。 */
    function cleanOutput(raw) {
      let t = String(raw || '').trim()
      const fence = /^```(?:markdown|md)?\s*\r?\n([\s\S]*?)\r?\n```\s*$/i.exec(t)
      if (fence) t = fence[1].trim()
      return t.replace(/^```(?:markdown|md)?\s*\r?\n/i, '').replace(/\r?\n```\s*$/, '').trim()
    }

    /** 写记忆的唯一入口：备份旧版到 .revisions/ → 原子写。返回是否写入。 */
    function writeMemory(gid, text) {
      const body = String(text || '').trim()
      if (!body) return false
      const file = fileOf(gid)
      ensureDir(dirOf())
      const old = readMemory(gid)
      if (old && old.text.trim() === body) return false // 内容没变：不写、不留冗余版本
      const keep = retainRevisions()
      if (old && keep > 0) {
        try {
          const revDir = path.join(dirOf(), REVISIONS)
          ensureDir(revDir)
          const iso = new Date().toISOString().replace(/[-:T.]/g, '')
          const stamp = `${iso.slice(0, 8)}-${iso.slice(8, 14)}`
          // 同一秒内多次积累：加序号避免覆盖（旧版本绝不互相顶掉）
          let revFile = path.join(revDir, `${gid}-${stamp}.md`)
          for (let i = 1; fs.existsSync(revFile) && i < 100; i += 1) {
            revFile = path.join(revDir, `${gid}-${stamp}-${i}.md`)
          }
          atomicWriteFileSync(revFile, old.text + '\n')
          // 只保留最近 N 份：按 mtime 排序，删最旧的（文件名同秒时的序号不影响判定）
          const entries = fs.readdirSync(revDir)
            .filter((n) => new RegExp(`^${gid}-\\d{8}-\\d{6}(?:-\\d+)?\\.md$`).test(n))
            .map((n) => ({ n, at: (() => { try { return fs.statSync(path.join(revDir, n)).mtimeMs } catch { return 0 } })() }))
            .sort((a, b) => a.at - b.at || a.n.localeCompare(b.n))
          for (const e of entries.slice(0, Math.max(0, entries.length - keep))) {
            try { fs.unlinkSync(path.join(revDir, e.n)) } catch { /* ignore */ }
          }
        } catch (e) { log.warn(`[群记忆] 历史版本备份失败 (${gid}): ${e.message}`) }
      }
      atomicWriteFileSync(file, body.endsWith('\n') ? body : `${body}\n`, { mode: 0o600 })
      cache.delete(file) // 让读取侧下次重新读盘
      return true
    }

    /** 单个群积累一次。返回 `{gid, status:'updated'|'skipped'|'failed', detail}`。 */
    async function accumulateGroup(gid) {
      const rows = readRecentMessages(gid)
      if (rows.length < minNewMsgs()) {
        return { gid, status: 'skipped', detail: `最近消息 ${rows.length} 条 < 门槛 ${minNewMsgs()}` }
      }
      const runner = bot.dsh?.runIsolatedTask
      if (typeof runner !== 'function') {
        return { gid, status: 'failed', detail: '内核不支持后台任务（runIsolatedTask），无法积累' }
      }
      const old = readMemory(gid)
      const prompt = buildPrompt({ gid, oldText: old?.text || '', transcript: transcriptOf(rows) })
      const res = await runner({
        name: `群记忆积累(${gid})`,
        prompt,
        cwd: dataDirOf(),
        timeoutMs: 10 * 60 * 1000,
      })
      const body = cleanOutput(res?.text)
      if (!body) return { gid, status: 'failed', detail: '模型输出为空' }
      if (body.length < 30) return { gid, status: 'failed', detail: `模型输出过短（${body.length} 字），疑似无效` }
      if (!/#/.test(body)) return { gid, status: 'failed', detail: '模型输出不像 Markdown（缺标题行）' }
      const wrote = writeMemory(gid, body)
      return { gid, status: wrote ? 'updated' : 'skipped', detail: wrote ? `${body.length} 字` : '内容未变化' }
    }

    /** 跑一轮：按群串行，单群失败不影响其它群。 */
    async function runRound({ trigger = 'schedule' } = {}) {
      const started = Date.now()
      const ids = listGroupIds().slice(0, MAX_GROUPS_PER_ROUND)
      const result = { ok: true, trigger, groups: ids.length, updated: [], skipped: [], failed: [] }
      for (const gid of ids) {
        if (!accumulateOn() && trigger === 'schedule') break // 跑的过程中被关掉：立即停
        try {
          const r = await accumulateGroup(gid)
          if (r.status === 'updated') result.updated.push(gid)
          else if (r.status === 'skipped') result.skipped.push(gid)
          else result.failed.push({ gid, detail: r.detail })
        } catch (e) {
          log.warn(`[群记忆] 积累失败 (${gid}): ${e.message}`)
          result.failed.push({ gid, detail: String(e.message || e) })
        }
      }
      result.ms = Date.now() - started
      result.message = `更新 ${result.updated.length} / 跳过 ${result.skipped.length} / 失败 ${result.failed.length}`
      lastResult = { ...result, at: Date.now() }
      return result
    }

    /** 统一触发入口（定时器 + 控制台「立刻积累」都走这里）：单飞，返回同一个 Promise。 */
    function trigger({ trigger: kind = 'manual' } = {}) {
      if (running) return { started: false, busy: true, promise: running, message: lastResult?.message || '上一轮还在跑' }
      const p = (async () => {
        try {
          const r = await runRound({ trigger: kind })
          lastRunAt = Date.now()
          lastError = ''
          saveState()
          log.info(`[群记忆] 第 ${kind === 'manual' ? '手动' : '定时'} 轮积累完成：${r.message}`)
          return r
        } catch (e) {
          lastError = String(e.message || e)
          saveState()
          log.warn(`[群记忆] 积累轮次异常：${lastError}`)
          throw e
        } finally {
          running = null
        }
      })()
      running = p
      p.catch(() => {}) // 防未处理 rejection（调用方按需 await）
      return { started: true, busy: false, promise: p, message: '已在后台开始积累（过一会儿刷新看结果）' }
    }

    // 给控制台/内核用的能力（kernel.shared 上）
    bot.shared.memoryAccumulate = async (payload = {}) => {
      if (payload?.confirm !== true) {
        return { ok: false, error: '需要 confirm:true（会调用模型）' }
      }
      const r = trigger({ trigger: 'manual' })
      return {
        ok: true,
        started: r.started,
        busy: r.busy,
        message: r.message,
        status: statusOf(),
      }
    }
    bot.shared.memoryAccumulateStatus = () => statusOf()
    /** 同 memoryAccumulate，但**等这一轮跑完**再返回（CLI/测试用；控制台用上面的异步版）。 */
    bot.shared.memoryAccumulateSync = async (payload = {}) => {
      if (payload?.confirm !== true) return { ok: false, error: '需要 confirm:true（会调用模型）' }
      const r = trigger({ trigger: 'manual' })
      const result = await r.promise
      return { ok: true, ...result }
    }

    function nextDueAt() {
      if (!accumulateOn()) return 0
      return lastRunAt ? lastRunAt + intervalMs() : bootAt + 5 * 60 * 1000
    }
    function statusOf() {
      return {
        enabled: accumulateOn(),
        intervalHours: Math.round(intervalMs() / 3600000),
        lookbackHours: Math.round(lookbackMs() / 3600000),
        msgPerGroup: msgPerGroup(),
        minNewMsgs: minNewMsgs(),
        retainRevisions: retainRevisions(),
        running: Boolean(running),
        lastRunAt: lastRunAt || 0,
        nextDueAt: nextDueAt(),
        lastResult: lastResult || null,
        lastError: lastError || '',
      }
    }
    // 尽量显式登记（内核可能有清理钩子；没有也不影响，定时器已 unref）
    bot.shared.memoryAccumulateStatus = () => statusOf()

    // 定时器：每 60s 看一次是否到期。首次启动给 90s 缓冲，避免插件刚起就抢模型资源。
    const timer = setInterval(() => {
      try {
        if (!accumulateOn()) return
        if (running) return
        const due = nextDueAt()
        if (due && Date.now() < due) return
        trigger({ trigger: 'schedule' })
      } catch (e) { log.warn(`[群记忆] 定时检查异常: ${e.message}`) }
    }, 60 * 1000)
    timer.unref?.()
    log.info(`[群记忆] 自动积累：${accumulateOn() ? `开（每 ${Math.round(intervalMs() / 3600000)} 小时）` : '关'}`
      + `｜记忆目录 ${dirOf()}`)
  },
}
