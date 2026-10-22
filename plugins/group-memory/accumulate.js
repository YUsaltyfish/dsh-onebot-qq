/**
 * accumulate.js — 群记忆的「写入侧」：定时/手动积累（group-memory 插件的内部模块）。
 *
 * 为什么拆成独立文件而不是独立子插件：积累与读取共享同一份数据契约
 * （同一记忆目录、同一 `<群号>.md` 格式、同一 `.revisions/` 约定），拆成插件反而要跨插件同步目录。
 * 对外仍然只有一个子插件 `group-memory`：一组配置、一个控制台页面、两个开关
 * （`enabled` 管读取注入、`accumulateEnabled` 管自动积累）。
 *
 * 做什么：每隔 `accumulateIntervalHours` 小时（或控制台「立刻积累一轮」）：
 *   ① 从聊天留档 `logs/qq_chat/group_<群号>.jsonl*` 取各群最近消息；
 *   ② 默认 `accumulateMode='digest'`：把本轮**所有有新消息的群合在一次提示**里，调**一次**模型，
 *      让它按 `<<<GROUP:群号>>> … <<<END:群号>>>` 分块只输出「新增要点」，本地按 QQ/文本去重后
 *      合并进记忆文件（输出小、快、不会截断）；`rewrite` = 模型重写各群完整记忆再整篇替换；
 *      `per-group` = 逐群各调一次（仅排障）。群太多超过 `accumulateBatchMaxChars` 才自动拆批。
 *      模型跑在**独立的一次性后台会话**里（内核 runIsolatedTask，该会话被禁止调用任何工具）。
 *   ③ 原子写回 `qq-memory/<群号>.md`，旧版备份到 `.revisions/`（保留 N 份）。
 *   ④ 车轮清理：每轮结束删「已消化 且 早于 accumulateKeepDays 天」的原始聊天留档
 *      （行级裁剪、原子写；未消化的记录不删）。
 *
 * 代价与保护：单飞锁、单群失败隔离、一轮群数上限、首启 5 分钟缓冲、少于门槛跳过、
 *             批量漏群时最多兜底 3 个群（避免又退回“每群一次”）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFileSync, atomicWriteFileSync } from '../../platform/atomic.js'
import { ensureDir } from '../../platform/paths.js'

/** 单轮最多处理多少个群（防止首次开启时一口气跑几十个模型调用）。 */
const MAX_GROUPS_PER_ROUND = 12
/** 历史版本子目录（与旧版布局一致）。 */
const REVISIONS = '.revisions'
/** 批量输出漏群时，最多再逐群兜底几次（防止又变成“每群一次调用”）。 */
const MAX_BATCH_FALLBACK = 3

/**
 * 建一个积累器实例（插件 setup 时调一次）。
 * @param {object} deps
 * @param {object} deps.bot            插件 bot 能力对象（用 core.dataDir / core.archive.dir / dsh.runIsolatedTask / shared）
 * @param {object} deps.cfg            插件生效配置（group-memory 的 configSchema 合并结果）
 * @param {object} deps.log            `{info,warn,debug}`
 * @param {() => string} deps.dataDirOf
 * @param {() => string} deps.memoryDirOf          记忆目录（与读取侧同一份）
 * @param {(gid:string) => ({text:string}|null)} deps.readMemoryOf  读旧版（prompt + 备份用）
 * @param {(gid:string) => void} deps.invalidateMemoryOf           写完后让读取侧缓存失效
 * @returns {{status:Function, trigger:Function, manual:Function, sync:Function, stop:Function}}
 */
export function createAccumulator({ bot, cfg = {}, log = console, dataDirOf, memoryDirOf, readMemoryOf, invalidateMemoryOf }) {
  const num = (v, d, min, max) => {
    const n = Number(v)
    const base = Number.isFinite(n) ? n : d
    return Math.max(min, Math.min(max, base))
  }
  const accumulateOn = () => cfg.accumulateEnabled !== false
  const intervalMs = () => num(cfg.accumulateIntervalHours, 8, 1, 24) * 3600 * 1000
  const lookbackMs = () => num(cfg.accumulateLookbackHours, 72, 1, 240) * 3600 * 1000
  const msgPerGroup = () => Math.round(num(cfg.accumulateMsgPerGroup, 200, 20, 1000))
  const maxCharsOf = () => Math.round(num(cfg.accumulateMaxChars, 8000, 1000, 30000))
  const minNewMsgs = () => Math.round(num(cfg.accumulateMinNewMsgs, 20, 0, 500))
  const retainRevisions = () => Math.round(num(cfg.accumulateRetainRevisions, 20, 0, 200))
  const accumulateMode = () => {
    const m = String(cfg.accumulateMode || 'digest')
    return ['digest', 'rewrite', 'per-group'].includes(m) ? m : 'digest'
  }
  const batchMaxCharsOf = () => Math.round(num(cfg.accumulateBatchMaxChars, 200000, 20000, 600000))
  const keepDaysOf = () => Math.round(num(cfg.accumulateKeepDays, 3, 0, 30))
  const keepRowsOf = () => Math.round(num(cfg.accumulateKeepRows, 0, 0, 100000))
  const sectionMaxItemsOf = () => Math.round(num(cfg.accumulateSectionMaxItems, 80, 10, 500))
  /** 某群的记忆文件路径（与读取侧同一目录、同一命名）。 */
  const fileOf = (gid) => path.join(memoryDirOf(), `${gid}.md`)
  const archiveDirOf = () => String(bot.core?.archive?.dir || '').trim() || path.join(dataDirOf(), 'logs', 'qq_chat')
  const stateFileOf = () => path.join(dataDirOf(), 'state', 'group-memory.json')

  // 积累状态（落盘：重启后不立刻重跑；也给控制台显示"上次/下次"）
  let state = {}
  try { state = readJsonFile(stateFileOf()) || {} } catch { state = {} }
  if (!state.groups || typeof state.groups !== 'object') state.groups = {}
  let lastRunAt = Number(state.lastRunAt) || 0
  let lastResult = state.lastResult && typeof state.lastResult === 'object' ? state.lastResult : null
  let running = null // Promise | null：单飞锁
  let lastError = ''
  let callsInRound = 0 // 本轮实际调了几次模型（写进 lastResult，控制台能看）
  let activeBatch = null // 本轮 digest 批次的「提交入口」（memory_append 工具用）：只在模型回合内有效，结束立刻清空
  const bootAt = Date.now() // 首次启动缓冲：没有 lastRunAt 时也先等 5 分钟再跑，避免重启即抢模型

  const saveState = () => {
    try { writeJsonFileSync(stateFileOf(), { lastRunAt, lastResult, lastError, groups: state.groups }) } catch (e) { log.warn(`[群记忆] 状态写入失败: ${e.message}`) }
  }

  /** 每群「消化水位」：这个时刻之前的原始记录已处理过（可被车轮清理删）。 */
  const digestedAtOf = (gid) => Number(state.groups?.[gid]?.digestedAt) || 0
  function markDigested(gid, ts = Date.now()) {
    state.groups[gid] = { ...(state.groups[gid] || {}), digestedAt: ts, at: Date.now() }
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
      for (const n of fs.readdirSync(memoryDirOf())) {
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
    // 只取「上次消化之后」的新消息；从没消化过就取最近 lookback 窗口
    const since = digestedAtOf(gid) || (Date.now() - lookbackMs())
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

  /**
   * 增量提示词：一轮处理多个群。
   * `submitTool=true`（批量 digest）时让模型**逐群调用 memory_append 工具**提交新增要点（结构化，没有文本格式解析）；
   * `false`（单群兜底/排障）仍用 `<<<GROUP>>>` 文本块，本地容错解析。
   */
  function buildDigestPrompt(items, { submitTool = false } = {}) {
    const parts = [
      `你是 QQ 群聊机器人背后的「群记忆维护员」。下面是 ${items.length} 个群最近几天的聊天记录。`,
      '任务：只提炼「值得长期记住的新信息」，不要复述旧记忆、不要重写全文。',
      '',
    ]
    if (submitTool) {
      parts.push(
        '【提交方式（必须用工具，不要用正文输出结果）】',
        '对下面每个群各调用一次 `memory_append` 工具：',
        '  · group_id：群号（原样抄【群 号码】里的数字）',
        '  · points：本群「新增要点」，Markdown 列表行（`- **昵称(QQ)**：…` / `- 风格：…` / `- 其它：…`）',
        '没有值得记的新信息的群也要调用一次，points 写「（无新增）」。所有群都提交完再结束回合，不要漏群。',
        '',
      )
    } else {
      parts.push(
        '【输出格式（必须严格遵守）】每个群输出一块，**开头一行、结尾一行都不能省**（漏结尾这整块会被丢弃）：',
        '<<<GROUP:群号>>>',
        '- **昵称(QQ)**：这个人的稳定特点 / 新变化（只写有信息量的）',
        '- 风格：这个群怎么叫机器人 / 回话要注意什么（语气、长度、称呼、忌讳）',
        '- 其它：群规矩、长期话题、对机器人的要求',
        '<<<END:群号>>>',
        '群号原样抄用下面给出的数字；每个群（包括最后一个）都要写 `<<<END:群号>>>`；不要漏群、不要解释、不要用 ``` 代码块包裹；没有值得记的新信息就写「（无新增）」。',
        '',
      )
    }
    for (const it of items) {
      parts.push(`【群 ${it.gid}】`)
      parts.push(it.oldText && it.oldText.trim()
        ? `【已有记忆（仅供参考，不用重复输出）】\n${it.oldText.trim()}`
        : '（这个群还没有记忆文件）')
      parts.push('')
      parts.push('【最近聊天】（`→` 开头是机器人自己说的；`昵称(QQ号)` 是发言人）')
      parts.push(it.transcript || '（无）')
      parts.push('')
    }
    parts.push('【写作要求】')
    parts.push('1. 只写有长期价值的信息：稳定性格、口头禅、群规矩、对机器人的要求、身份/昵称变化（同一个 QQ 换了昵称要合并）。')
    parts.push('2. 一次性的闲聊、临时话题、刷屏、没有信息量的内容不要写；不要编造聊天里没有的内容。')
    parts.push('3. 群友条目写成 `- **昵称(QQ)**：特点`；其它条目以 `- 风格：…` 或 `- 其它：…` 开头。')
    parts.push('4. 宁缺毋滥，每个群最多 20 条要点。')
    parts.push('')
    parts.push(submitTool ? '现在开始按群调用工具提交：' : '现在按格式直接输出：')
    return parts.join('\n')
  }

  function beijingStamp() {
    const d = new Date(Date.now() + 8 * 3600 * 1000)
    const p = (n) => String(n).padStart(2, '0')
    return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
  }

  const STYLE_HEAD = /风格|唤醒|回话/
  const PEOPLE_HEAD = /人/
  const OTHER_HEAD = /其它|其他/

  /** 记忆文件拆成 { preamble, sections:[{title, lines}] }（`## ` 分节）。 */
  function splitMemory(text) {
    const lines = String(text || '').split('\n')
    const preamble = []
    const sections = []
    let cur = null
    for (const line of lines) {
      const m = /^##\s+(.+?)\s*$/.exec(line)
      if (m) { cur = { title: m[1], lines: [] }; sections.push(cur); continue }
      if (cur) cur.lines.push(line)
      else preamble.push(line)
    }
    return { preamble, sections }
  }

  function normText(s) {
    return String(s || '').replace(/[\s*`~～。，、；;：:!！?？()（）\[\]【】「」]/g, '').toLowerCase()
  }

  function personQq(line) {
    const m = /\((\d{4,12})\)/.exec(line) || /(\d{4,12})/.exec(line)
    return m ? m[1] : ''
  }

  /**
   * 增量要点合并进记忆文件：按 QQ/文本去重，追加进对应小节，每节条数封顶（超出最早丢）。
   * 返回 `{added, updated, dropped}`（全 0 = 这轮没有值得写的新信息）。
   */
  function mergeDigest(gid, digestText) {
    const stat = { added: 0, updated: 0, dropped: 0 }
    const bullets = String(digestText || '')
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => /^[-*]\s+/.test(l))
      .map((l) => l.replace(/^[-*]\s+/, '').trim())
      .filter((l) => l && !/^（?无新增）?$/.test(l))
    if (!bullets.length) return stat

    const old = readMemoryOf(gid)?.text || ''
    const parsed = splitMemory(old)
    const sections = parsed.sections
    const ensureSection = (title, re) => {
      let s = sections.find((x) => re.test(x.title))
      if (!s) { s = { title, lines: [] }; sections.push(s) }
      return s
    }
    const styleSec = ensureSection('唤醒与对话风格', STYLE_HEAD)
    const peopleSec = ensureSection('群里的人', PEOPLE_HEAD)
    const otherSec = ensureSection('其它', OTHER_HEAD)

    for (const raw of bullets) {
      const isPerson = /^\*\*/.test(raw) && Boolean(personQq(raw))
      if (isPerson) {
        const qq = personQq(raw)
        const idx = peopleSec.lines.findIndex((l) => personQq(l) === qq)
        if (idx < 0) { peopleSec.lines.push(`- ${raw}`); stat.added += 1; continue }
        const oldLine = peopleSec.lines[idx]
        const nOld = normText(oldLine)
        const nNew = normText(raw)
        if (!nNew || nOld.includes(nNew)) continue
        if (nNew.includes(nOld) || raw.length > oldLine.length + 20) {
          peopleSec.lines[idx] = `- ${raw}`
          stat.updated += 1
          continue
        }
        const merged = `${oldLine.replace(/\s+$/, '')}；${raw}`
        if (merged.length <= 400) { peopleSec.lines[idx] = merged; stat.updated += 1 }
        continue
      }
      const isStyle = /^(风格|对话风格)[：:]/.test(raw)
      const text = raw.replace(/^(风格|对话风格)[：:]\s*/, '').replace(/^其它[：:]\s*/, '')
      const nNew = normText(text)
      if (!nNew) continue
      const target = isStyle ? styleSec : otherSec
      const exists = target.lines.some((l) => {
        const n = normText(l.replace(/^[-*]\s+/, ''))
        return n && (n.includes(nNew) || nNew.includes(n))
      })
      if (exists) continue
      target.lines.push(`- ${text}`)
      stat.added += 1
    }

    // 每节条数上限：超出从最早的开始丢
    const cap = sectionMaxItemsOf()
    for (const s of sections) {
      const items = s.lines.filter((l) => /^[-*]\s+/.test(l.trim()))
      if (items.length <= cap) continue
      const keep = new Set(items.slice(items.length - cap))
      const next = []
      for (const l of s.lines) {
        if (/^[-*]\s+/.test(l.trim()) && !keep.has(l)) { stat.dropped += 1; continue }
        next.push(l)
      }
      s.lines = next
    }

    // 重建文本：保留前言 + 更新「最后更新」+ 三节都在
    let preamble = parsed.preamble.join('\n').replace(/\s+$/, '')
    if (!preamble.trim()) preamble = `# 群 ${gid} · 对话记忆\n\n> 本文件由 group-memory 自动积累，也可以直接手改。`
    const stamp = beijingStamp()
    if (/^>\s*最后更新[：:]/m.test(preamble)) {
      preamble = preamble.replace(/^>\s*最后更新[：:].*$/m, `> 最后更新：${stamp}（北京时间）`)
    } else {
      preamble = preamble.replace(/^(#[^\n]*\n)/, `$1\n> 最后更新：${stamp}（北京时间）`)
    }
    const parts = [preamble.trim()]
    for (const s of sections) {
      const bodyLines = s.lines.map((l) => l.replace(/\s+$/, '')).filter(Boolean)
      parts.push(`## ${s.title}\n${bodyLines.length ? bodyLines.join('\n') : ''}`.replace(/\n$/, ''))
    }
    const text = `${parts.join('\n\n')}\n`
    if (text.trim() === String(old || '').trim()) return stat
    writeMemory(gid, text) // 备份旧版 → 原子写 → 让读取侧缓存失效
    return stat
  }

  /**
   * 车轮清理：只删「已消化 且 超过保留窗口」的原始聊天记录（行级裁剪，原子写）。
   * 未消化的记录一律保留；返回 { files, removed }。
   */
  function pruneArchive() {
    const keepDays = keepDaysOf()
    const keepRows = keepRowsOf()
    const out = { files: 0, removed: 0 }
    if (!keepDays && !keepRows) return out
    const cutoff = keepDays > 0 ? Date.now() - keepDays * 86400000 : 0
    const dir = archiveDirOf()
    let names = []
    try { names = fs.readdirSync(dir) } catch { return out }
    const groups = new Set(listGroupIds())
    for (const n of names) {
      const m = /^group_(\d{4,12})\.jsonl(?:\.\d+)?$/.exec(n)
      if (!m || !groups.has(m[1])) continue
      const gid = m[1]
      const digestedAt = digestedAtOf(gid)
      const file = path.join(dir, n)
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      const rows = []
      let removed = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let ts = 0
        try { ts = Number(JSON.parse(line)?.ts) || 0 } catch { ts = 0 }
        const expired = cutoff > 0 && ts > 0 && ts < cutoff
        const digested = digestedAt > 0 && ts <= digestedAt
        if (expired && digested) { removed += 1; continue }
        rows.push({ line, ts })
      }
      if (keepRows > 0 && rows.length > keepRows) {
        const overflow = rows.length - keepRows
        let dropped = 0
        const kept = []
        for (const r of rows) {
          if (dropped < overflow && digestedAt > 0 && r.ts <= digestedAt) { dropped += 1; removed += 1; continue }
          kept.push(r)
        }
        rows.length = 0
        rows.push(...kept)
      }
      if (removed > 0) {
        out.files += 1
        out.removed += removed
        const content = rows.map((r) => r.line).join('\n')
        if (!content && /\.jsonl\.\d+$/.test(n)) {
          try { fs.unlinkSync(file) } catch { /* ignore */ }
        } else {
          atomicWriteFileSync(file, content ? `${content}\n` : '')
        }
      }
    }
    return out
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

  /** 批量提示词：一次让模型处理多个群，按 `<<<GROUP:群号>>> … <<<END:群号>>>` 分块输出。 */
  function buildBatchPrompt(items) {
    const parts = [
      `你是 QQ 群聊机器人背后的「群记忆维护员」。下面有 ${items.length} 个群，请根据各群最近的聊天，分别更新它们的长期记忆文件。`,
      '',
      '【输出格式（必须严格遵守）】每个群输出一段，用下面两行把该群的完整 Markdown 包起来：',
      '<<<GROUP:群号>>>',
      '（该群更新后的完整记忆文件正文）',
      '<<<END:群号>>>',
      '群号原样抄用下面给出的数字；不要漏群、不要输出任何解释/寒暄，也不要用 ``` 代码块包裹。',
      '',
    ]
    for (const it of items) {
      parts.push(`【群 ${it.gid}】`)
      parts.push('【当前记忆文件】（可能为空；保持原有结构与写法）')
      parts.push(it.oldText && it.oldText.trim() ? it.oldText.trim() : '（空，这是第一次积累）')
      parts.push('')
      parts.push('【最近聊天】（`→` 开头是机器人自己说的；`昵称(QQ号)` 是发言人）')
      parts.push(it.transcript || '（无）')
      parts.push('')
    }
    parts.push('【写作要求】')
    parts.push('1. 每个群都输出「更新后的完整记忆文件正文」，只输出正文，不要解释。')
    parts.push('2. 保持原有结构：记录「这个群怎么把机器人叫起来 / 该怎么回话（语气、长度、称呼、忌讳）」和「群里的人」。')
    parts.push('3. 群友条目写成 `- **昵称(QQ)**：特点`；认人只看 QQ 号，昵称变了要合并到同一个 QQ，不要新增重复条目。')
    parts.push('4. 把最近聊天里的稳定信息合并进去；一次闲聊、临时话题、刷屏不要写；不要编造聊天里没有的内容。')
    parts.push('5. 过时或明显不对的旧条目要修正或删掉；宁缺毋滥，每个群控制在 20000 字以内。')
    parts.push('6. 记忆里提到机器人自己一律用「我」，不要写人设。')
    parts.push('')
    parts.push('现在按格式直接输出：')
    return parts.join('\n')
  }

  /**
   * 解析批量输出。返回 Map<群号, 正文>。
   *
   * 容错优先（2026-10-22 实测踩坑）：模型常把 `<<<GROUP:群号>>>` 当分隔标题、**漏掉成对的
   * `<<<END:群号>>>`**（一次 8 个群全漏）——严格正则要求成对 → 整批 0 解析、8 个群全部失败。
   * 所以这里把 GROUP 标记当块起点，块体延续到下一个 GROUP 标记或结尾；END 标记可有可无、一律剥掉。
   * 只有一个群且完全没标记时，整段当该群结果（兼容旧行为）。
   */
  function parseBatchOutput(raw, gids) {
    const out = new Map()
    const text = cleanOutput(raw)
    if (!text) return out
    const wanted = new Set(gids)
    const heads = []
    const re = /<<<GROUP:\s*(\d{4,12})\s*>>>/gi
    let m
    while ((m = re.exec(text))) heads.push({ gid: m[1], headStart: m.index, bodyStart: m.index + m[0].length })
    if (!heads.length) {
      if (gids.length === 1) out.set(gids[0], text)
      return out
    }
    for (let i = 0; i < heads.length; i += 1) {
      const h = heads[i]
      if (!wanted.has(h.gid) || out.has(h.gid)) continue
      const bodyEnd = i + 1 < heads.length ? heads[i + 1].headStart : text.length
      const body = text.slice(h.bodyStart, bodyEnd)
        .replace(/<<<END:\s*\d{4,12}\s*>>>/gi, '')
        .trim()
      if (body) out.set(h.gid, body)
    }
    return out
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
    ensureDir(memoryDirOf())
    const old = readMemoryOf(gid)
    if (old && old.text.trim() === body) return false // 内容没变：不写、不留冗余版本
    const keep = retainRevisions()
    if (old && keep > 0) {
      try {
        const revDir = path.join(memoryDirOf(), REVISIONS)
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
    invalidateMemoryOf(gid) // 让读取侧下次重新读盘
    return true
  }

  /** 把模型输出校验后落盘（批量 / 逐群共用）。 */
  function applyModelText(gid, rawText) {
    const body = cleanOutput(rawText)
    if (!body) return { gid, status: 'failed', detail: '模型输出为空' }
    if (body.length < 30) return { gid, status: 'failed', detail: `模型输出过短（${body.length} 字），疑似无效` }
    if (!/#/.test(body)) return { gid, status: 'failed', detail: '模型输出不像 Markdown（缺标题行）' }
    const wrote = writeMemory(gid, body)
    return { gid, status: wrote ? 'updated' : 'skipped', detail: wrote ? `${body.length} 字` : '内容未变化' }
  }

  /** 记一个群的最终结果（同一群重复提交时以最后一次为准，数组里不重复）。 */
  function recordGroup(result, gid, status, detail = '') {
    for (const arr of [result.updated, result.skipped]) {
      const i = arr.indexOf(gid)
      if (i >= 0) arr.splice(i, 1)
    }
    const fi = result.failed.findIndex((x) => x && x.gid === gid)
    if (fi >= 0) result.failed.splice(fi, 1)
    if (status === 'updated') result.updated.push(gid)
    else if (status === 'skipped') result.skipped.push(gid)
    else result.failed.push({ gid, detail: detail || '失败' })
  }

  /**
   * memory_append 工具的实现：模型把某个群的「新增要点」提交上来。
   * 只在 digest 批次的模型回合内有效（activeBatch 非空）；合并/去重/备份/写盘仍是本地逻辑，
   * 模型拿不到文件写入权（不会写坏文件，也不会有 `<<<GROUP>>>` 文本格式解析）。
   */
  function submit(args) {
    const b = activeBatch
    if (!b) throw new Error('当前没有进行中的群记忆积累轮次（memory_append 只在后台积累任务里、且只在模型回合内可用）')
    const gid = String(args?.group_id ?? '').trim()
    if (!/^\d{4,12}$/.test(gid)) throw new Error(`group_id 不合法：${JSON.stringify(args?.group_id)}（要原样抄 prompt 里的群号）`)
    if (!b.gids.has(gid)) throw new Error(`群 ${gid} 不在本轮范围里（本轮：${[...b.gids].join('、')}）`)
    const points = String(args?.points ?? '').trim()
    if (!points) throw new Error('points 不能为空；没有新增就写「（无新增）」')
    const m = mergeDigest(gid, points)
    markDigested(gid)
    b.applied.add(gid)
    recordGroup(b.result, gid, (m.added || m.updated || m.dropped) ? 'updated' : 'skipped')
    const i = b.result.digest.findIndex((x) => x && x.gid === gid)
    if (i >= 0) b.result.digest.splice(i, 1)
    b.result.digest.push({ gid, ...m, via: 'tool' })
    log.info(`[群记忆] 工具提交 ${gid} → +${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}`)
    return {
      ok: true,
      group_id: gid,
      added: m.added,
      updated: m.updated,
      dropped: m.dropped,
      message: (m.added || m.updated || m.dropped)
        ? `已合并（新增 ${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}）`
        : '没有新增要点，已记下这个群处理过了',
    }
  }

  /** 单个群积累一次（逐群模式 / 批量漏群兜底）。返回 `{gid, status:'updated'|'skipped'|'failed', detail}`。 */
  async function accumulateGroup(gid, rowsIn, modeIn) {
    const mode = modeIn || (accumulateMode() === 'digest' ? 'digest' : 'rewrite')
    const rows = Array.isArray(rowsIn) ? rowsIn : readRecentMessages(gid)
    if (rows.length < minNewMsgs()) {
      return { gid, status: 'skipped', detail: `最近消息 ${rows.length} 条 < 门槛 ${minNewMsgs()}` }
    }
    const runner = bot.dsh?.runIsolatedTask
    if (typeof runner !== 'function') {
      return { gid, status: 'failed', detail: '内核不支持后台任务（runIsolatedTask），无法积累' }
    }
    const old = readMemoryOf(gid)
    const item = { gid, oldText: old?.text || '', transcript: transcriptOf(rows) }
    callsInRound += 1
    const res = await runner({
      name: `群记忆积累(${gid}${mode === 'digest' ? '·增量' : ''})`,
      prompt: mode === 'digest' ? buildDigestPrompt([item]) : buildPrompt(item),
      cwd: dataDirOf(),
      timeoutMs: 10 * 60 * 1000,
    })
    if (mode === 'digest') {
      const parsed = parseBatchOutput(res?.text, [gid])
      if (!parsed.size) return { gid, status: 'failed', detail: '模型输出为空或格式不符' }
      const m = mergeDigest(gid, parsed.get(gid))
      markDigested(gid)
      return (m.added || m.updated || m.dropped)
        ? { gid, status: 'updated', detail: `要点 +${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}` }
        : { gid, status: 'skipped', detail: '无新增要点' }
    }
    const r = applyModelText(gid, res?.text)
    if (r.status !== 'failed') markDigested(gid)
    return r
  }

  /** 一批（一次模型调用）处理多个群；解析失败/漏群的按需兜底。 */
  async function runBatch(due, result) {
    const runner = bot.dsh?.runIsolatedTask
    if (typeof runner !== 'function') {
      for (const d of due) result.failed.push({ gid: d.gid, detail: '内核不支持后台任务（runIsolatedTask），无法积累' })
      return
    }
    // 按提示词体积拆批（旧记忆 + 聊天正文 + 固定说明）；一般一轮就一批
    const chunks = []
    let cur = []
    let curLen = 0
    for (const d of due) {
      const old = readMemoryOf(d.gid)
      const transcript = transcriptOf(d.rows)
      const size = (old?.text || '').length + transcript.length + 400
      if (cur.length && curLen + size > batchMaxCharsOf()) { chunks.push(cur); cur = []; curLen = 0 }
      cur.push({ gid: d.gid, rows: d.rows, oldText: old?.text || '', transcript })
      curLen += size
    }
    if (cur.length) chunks.push(cur)

    for (const chunk of chunks) {
      const items = chunk.map((it) => ({ gid: it.gid, oldText: it.oldText, transcript: it.transcript }))
      const mode = accumulateMode() === 'rewrite' ? 'rewrite' : 'digest'
      const gids = new Set(items.map((it) => it.gid))
      const viaTool = new Set() // 本轮模型用 memory_append 提交过的群
      let res
      // digest：开「工具提交」入口（模型跑这一轮期间有效；submit 里合并/记账）
      activeBatch = mode === 'digest' ? { gids, result, applied: viaTool } : null
      try {
        callsInRound += 1
        res = await runner({
          name: `群记忆积累(${items.length} 个群${mode === 'digest' ? '·增量' : '·重写'})`,
          prompt: mode === 'digest' ? buildDigestPrompt(items, { submitTool: true }) : buildBatchPrompt(items),
          cwd: dataDirOf(),
          timeoutMs: 15 * 60 * 1000,
        })
      } catch (e) {
        // 超时/中断：已工具提交的群保留它们的结果，只把没提交的记失败
        for (const it of chunk) {
          if (!viaTool.has(it.gid)) result.failed.push({ gid: it.gid, detail: String(e.message || e) })
        }
        continue
      } finally {
        activeBatch = null
      }

      if (mode === 'digest') {
        // ① 工具提交的群：submit() 里已合并并记账；② 剩下的群用正文做兼容兜底（模型没调工具/老 prompt）
        if (viaTool.size) log.info(`[群记忆] 本轮 ${viaTool.size}/${items.length} 个群由工具提交`)
        const rest = items.filter((it) => !viaTool.has(it.gid))
        if (rest.length) {
          const parsed = parseBatchOutput(res?.text, rest.map((it) => it.gid))
          if (!parsed.size) {
            // 留一段原文，下次排查不用再去翻后台会话存档
            const raw = String(res?.text || '').replace(/\s+/g, ' ').trim()
            log.warn(`[群记忆] ${rest.length} 个群既没工具提交、正文也没解析到：${raw.slice(0, 300) || '（空）'}`)
          }
          for (const it of rest) {
            const text = parsed.get(it.gid)
            if (text == null) {
              result.failed.push({ gid: it.gid, detail: '模型没有提交这个群的要点（没调 memory_append，正文里也没有该群）' })
              continue
            }
            try {
              const m = mergeDigest(it.gid, text)
              markDigested(it.gid)
              recordGroup(result, it.gid, (m.added || m.updated || m.dropped) ? 'updated' : 'skipped')
              result.digest.push({ gid: it.gid, ...m, via: 'text' })
            } catch (e) {
              result.failed.push({ gid: it.gid, detail: String(e.message || e) })
            }
          }
        }
        continue
      }

      // ── rewrite：模型重写各群完整记忆（整篇替换）──
      const parsed = parseBatchOutput(res?.text, chunk.map((it) => it.gid))
      if (!parsed.size) {
        const raw = String(res?.text || '').replace(/\s+/g, ' ').trim()
        log.warn(`[群记忆] 批量解析失败（${chunk.length} 群）：${raw.slice(0, 300) || '（空）'}`)
        for (const it of chunk) result.failed.push({ gid: it.gid, detail: '模型输出里没有解析到任何群（格式不符）' })
        continue
      }
      const missing = []
      for (const it of chunk) {
        const text = parsed.get(it.gid)
        if (text == null) { missing.push(it); continue }
        try {
          const r = applyModelText(it.gid, text)
          if (r.status === 'updated') { result.updated.push(it.gid); markDigested(it.gid) }
          else if (r.status === 'skipped') { result.skipped.push(it.gid); markDigested(it.gid) }
          else result.failed.push({ gid: it.gid, detail: r.detail })
        } catch (e) {
          result.failed.push({ gid: it.gid, detail: String(e.message || e) })
        }
      }
      // 漏群兜底：最多 MAX_BATCH_FALLBACK 个，避免又退回“每群一次”
      for (const it of missing.slice(0, MAX_BATCH_FALLBACK)) {
        try {
          const r = await accumulateGroup(it.gid, it.rows, mode)
          if (r.status === 'updated') result.updated.push(it.gid)
          else if (r.status === 'skipped') result.skipped.push(it.gid)
          else result.failed.push({ gid: it.gid, detail: r.detail })
        } catch (e) {
          result.failed.push({ gid: it.gid, detail: String(e.message || e) })
        }
      }
      for (const it of missing.slice(MAX_BATCH_FALLBACK)) {
        result.failed.push({ gid: it.gid, detail: '模型输出漏了这个群（兜底上限已用完）' })
      }
    }
  }

  /** 跑一轮：先筛“有新消息”的群，再按积累方式批量或逐群处理，最后车轮清理旧记录。 */
  async function runRound({ trigger = 'schedule' } = {}) {
    const started = Date.now()
    callsInRound = 0
    const ids = listGroupIds().slice(0, MAX_GROUPS_PER_ROUND)
    const result = { ok: true, trigger, groups: ids.length, updated: [], skipped: [], failed: [], digest: [], calls: 0, pruned: null }
    const due = []
    for (const gid of ids) {
      if (!accumulateOn() && trigger === 'schedule') break // 跑的过程中被关掉：立即停
      const rows = readRecentMessages(gid)
      if (rows.length < minNewMsgs()) {
        result.skipped.push(gid)
        continue
      }
      due.push({ gid, rows })
    }
    if (due.length) {
      if (accumulateMode() === 'per-group') {
        for (const d of due) {
          try {
            const r = await accumulateGroup(d.gid, d.rows, 'rewrite')
            if (r.status === 'updated') result.updated.push(d.gid)
            else if (r.status === 'skipped') result.skipped.push(d.gid)
            else result.failed.push({ gid: d.gid, detail: r.detail })
          } catch (e) {
            log.warn(`[群记忆] 积累失败 (${d.gid}): ${e.message}`)
            result.failed.push({ gid: d.gid, detail: String(e.message || e) })
          }
        }
      } else {
        await runBatch(due, result)
      }
    }
    // 车轮清理：只删「已消化 且 超过保留窗口」的原始记录
    try { result.pruned = pruneArchive() } catch (e) { log.warn(`[群记忆] 旧记录清理失败: ${e.message}`) }
    result.calls = callsInRound
    result.ms = Date.now() - started
    const pruneNote = result.pruned?.removed ? `，清理 ${result.pruned.removed} 行旧记录` : ''
    result.message = `更新 ${result.updated.length} / 跳过 ${result.skipped.length} / 失败 ${result.failed.length}（本轮 ${result.calls} 次模型调用${pruneNote}）`
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

  function nextDueAt() {
    if (!accumulateOn()) return 0
    return lastRunAt ? lastRunAt + intervalMs() : bootAt + 5 * 60 * 1000
  }
  function statusOf() {
    return {
      enabled: accumulateOn(),
      mode: accumulateMode(),
      intervalHours: Math.round(intervalMs() / 3600000),
      batchMaxChars: batchMaxCharsOf(),
      keepDays: keepDaysOf(),
      keepRows: keepRowsOf(),
      sectionMaxItems: sectionMaxItemsOf(),
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
  const start = () => {
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
      + `｜记忆目录 ${memoryDirOf()}`)
    return timer
  }

  const status = () => statusOf()
  const manual = async (payload = {}) => {
    if (payload?.confirm !== true) return { ok: false, error: '需要 confirm:true（会调用模型）' }
    const r = trigger({ trigger: 'manual' })
    return { ok: true, started: r.started, busy: r.busy, message: r.message, status: statusOf() }
  }
  const sync = async (payload = {}) => {
    if (payload?.confirm !== true) return { ok: false, error: '需要 confirm:true（会调用模型）' }
    const r = trigger({ trigger: 'manual' })
    const result = await r.promise
    return { ok: true, ...result }
  }

  return { status, trigger, manual, sync, submit, start }
}
