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
 *      让它逐群调用 `memory_append` 工具提交「新增要点」（结构化；没调工具时兼容
 *      `<<<GROUP:群号>>> … <<<END:群号>>>` 文本块），本地按 QQ/事实去重后合并进记忆文件。
 *      `rewrite` = 模型重写各群完整记忆再整篇替换；`per-group` = 逐群各调一次（仅排障）。
 *      群太多超过 `accumulateBatchMaxChars` 才自动拆批。
 *      模型跑在**独立的一次性后台会话**里（内核 runIsolatedTask）；该会话只放行 `memory_append`
 *      这一个 mcp__qq__ 工具（其它 QQ 工具在工具入口被拒），不会把积累结果发到群里。
 *   ③ 原子写回 `qq-memory/<群号>.md`，旧版备份到 `.revisions/`（保留 N 份）。
 *      **写盘基准是未截断的原文**（截断只在返回给模型时发生）——旧版用截断文本当基准，
 *      超过 maxBytes 的尾部会在每轮整篇写回时被丢掉。
 *   ④ 水位按「本轮实际喂给模型的最新一条消息 ts」推进，不是 Date.now()。
 *      每群只取最近 `accumulateMsgPerGroup` 条 / `accumulateMaxChars` 字；更早的新消息计入
 *      `sampledOut`（日志/控制台可见，不回补——需要更高覆盖率请调大上限或缩短间隔）。
 *   ⑤ 车轮清理：每轮结束删「已消化 且 早于 accumulateKeepDays 天」的原始聊天留档
 *      （行级裁剪、原子写；未消化的记录不删）。
 *
 * 代价与保护：单飞锁、单群失败隔离、单轮群数上限 + 轮转游标（不饿死大号段群）、
 *             首启 5 分钟缓冲、少于门槛跳过、批量漏群时最多兜底 3 个群。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { senderNameOf } from '../../kernel/format.js'
import { readJsonFile, writeJsonFileSync, atomicWriteFileSync } from '../../platform/atomic.js'
import { ensureDir } from '../../platform/paths.js'

/** 单轮默认最多处理多少个群（配置项 accumulateMaxGroupsPerRound 可覆盖；配合轮转游标保证公平）。 */
const DEFAULT_MAX_GROUPS_PER_ROUND = 12
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
 * @param {(gid:string) => ({text:string,bytes:number}|null)} deps.readMemoryOf
 *        读旧版（prompt + 备份 + 合并基准用）——**必须是未截断的原文**，
 *        否则超过 maxBytes 的尾部会在每次整篇写回时被丢掉。
 * @param {(gid:string) => void} deps.invalidateMemoryOf           写完后让读取侧缓存失效
 * @param {() => number} [deps.maxBytesOf]                        单篇读取上限（写盘预算用）
 * @returns {{status:Function, trigger:Function, manual:Function, sync:Function, start:Function, stop:Function, submit:Function}}
 */
export function createAccumulator({ bot, cfg = {}, log = console, dataDirOf, memoryDirOf, readMemoryOf, invalidateMemoryOf, maxBytesOf }) {
  const maxBytesOfSafe = () => Math.max(1000, Number(maxBytesOf?.()) || 24000)
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
  const maxGroupsOf = () => Math.round(num(cfg.accumulateMaxGroupsPerRound, DEFAULT_MAX_GROUPS_PER_ROUND, 1, 200))
  /** 某群的记忆文件路径（与读取侧同一目录、同一命名）。 */
  const fileOf = (gid) => path.join(memoryDirOf(), `${gid}.md`)
  const archiveDirOf = () => String(bot.core?.archive?.dir || '').trim() || path.join(dataDirOf(), 'logs', 'qq_chat')
  const stateFileOf = () => path.join(dataDirOf(), 'state', 'group-memory.json')

  // 积累状态（落盘：重启后不立刻重跑；也给控制台显示"上次/下次"）
  let state = {}
  try { state = readJsonFile(stateFileOf()) || {} } catch { state = {} }
  if (!state.groups || typeof state.groups !== 'object') state.groups = {}
  let cursor = String(state.cursor || '') // 上一轮最后一个被处理的群号：下一轮从它后面开始，避免大号段群永远饿死
  let lastRunAt = Number(state.lastRunAt) || 0
  let lastResult = state.lastResult && typeof state.lastResult === 'object' ? state.lastResult : null
  let running = null // Promise | null：单飞锁
  let lastError = ''
  let callsInRound = 0 // 本轮实际调了几次模型（写进 lastResult，控制台能看）
  let activeBatch = null // 本轮 digest 批次的「提交入口」（memory_append 工具用）：只在模型回合内有效，结束立刻清空
  const bootAt = Date.now() // 首次启动缓冲：没有 lastRunAt 时也先等 5 分钟再跑，避免重启即抢模型

  const saveState = () => {
    try { writeJsonFileSync(stateFileOf(), { lastRunAt, lastResult, lastError, cursor, groups: state.groups }) } catch (e) { log.warn(`[群记忆] 状态写入失败: ${e.message}`) }
  }

  /**
   * 每群「消化水位」：**本轮实际喂给模型的最新一条消息 ts**（不是“写完的时刻”）。
   * 两者差一轮模型调用的时长：用 Date.now() 会把积累期间新到的消息一起标成已消化（旧版会丢这些消息）。
   */
  const digestedAtOf = (gid) => Number(state.groups?.[gid]?.digestedAt) || 0
  // ID 不跨方向复用；无 ID 的旧留档用内容指纹，轮转/裁剪后仍稳定。
  const messageKey = (row) => createHash('sha256').update(JSON.stringify(
    row.messageId != null
      ? [row.dir, String(row.messageId), row.ts]
      : [row.dir, row.ts, row.sender, row.text],
  )).digest('hex')
  function isDigested(gid, row, seen) {
    const group = state.groups[gid] || {}
    if (Array.isArray(group.seenMessages)) {
      return Number(row.ts) < (Number(group.legacyDigestedBefore) || 0) || (seen || new Set(group.seenMessages.map(([key]) => key))).has(messageKey(row))
    }
    return Number(row.ts) < digestedAtOf(gid) // 旧水位边界重放一次，不回灌更早历史
  }
  function markDigested(gid, ts, checkpoint) {
    const at = Number(ts)
    if (!(at > 0)) return false // 没喂到任何消息 → 不推水位（下轮重试）
    const old = state.groups[gid] || {}
    state.groups[gid] = { ...old, ...checkpoint, digestedAt: Math.max(digestedAtOf(gid), at), at: Date.now() }
    return true
  }

  /** 本轮按 12 群上限选群：从上次的 cursor 之后开始轮转，保证每个群都有机会。 */
  function pickGroups() {
    const all = listGroupIds()
    const cap = maxGroupsOf()
    let start = 0
    if (cursor) {
      const i = all.indexOf(cursor)
      if (i >= 0) start = (i + 1) % all.length
    }
    const rotated = start ? all.slice(start).concat(all.slice(0, start)) : all
    return { selected: rotated.slice(0, cap), deferred: Math.max(0, rotated.length - cap), total: all.length }
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

  /**
   * 读某群「上次消化之后」的聊天留档（jsonl，含轮转文件），按时间升序。
   * 在既有 lookback 窗口内重叠读取，以稳定消息键去重，接住同秒/乱序迟到消息。
   * 旧版纯 ts 水位只重放边界一次；更早的旧历史保持已处理语义。
   * @returns {{rows:Array, total:number, newestTs:number}} rows = 最近 msgPerGroup 条窗口（更早的计入 total）
   */
  function readRecentMessages(gid) {
    const dir = archiveDirOf()
    let names = []
    try {
      names = fs.readdirSync(dir)
        .filter((n) => new RegExp(`^group_${gid}\\.jsonl(?:\\.(\\d+))?$`).test(n))
        .map((n) => ({ n, mtime: (() => { try { return fs.statSync(path.join(dir, n)).mtimeMs } catch { return 0 } })() }))
        .sort((a, b) => a.mtime - b.mtime) // 旧 → 新
        .map((x) => x.n)
    } catch { return { rows: [], total: 0, newestTs: 0 } }
    // 只取「上次消化之后」的新消息；从没消化过就取最近 lookback 窗口
    const group = state.groups[gid] || {}
    const since = Array.isArray(group.seenMessages)
      ? Math.max(Number(group.replayFrom) || 0, Date.now() - lookbackMs())
      : (digestedAtOf(gid) || (Date.now() - lookbackMs()))
    const seen = new Map(Array.isArray(group.seenMessages) ? group.seenMessages : [])
    const out = []
    for (const n of names) {
      let text = ''
      try { text = fs.readFileSync(path.join(dir, n), 'utf8') } catch { continue }
      for (const line of text.split('\n')) {
        const s = line.trim()
        if (!s) continue
        let row
        try { row = JSON.parse(s) } catch { continue }
        if (!row || typeof row !== 'object') continue
        const ts = Number(row?.ts) || 0
        if (ts && ts < since) continue
        const key = messageKey(row)
        if (seen.has(key)) continue
        seen.set(key, ts)
        const msg = String(row?.text ?? '').replace(/\s+/g, ' ').trim()
        if (!msg) continue
        if (/^\[CQ:[^\]]+\]$/.test(msg)) continue // 纯图片/表情占位不喂给模型
        const outbound = row?.dir === 'out'
        const nick = String(senderNameOf(row.sender) || '').trim()
        const qq = String(row?.sender?.qq ?? '').trim()
        out.push({ ts, out: outbound, who: outbound ? '机器人' : (nick && qq && nick !== qq ? `${nick}(${qq})` : (nick || qq || '未知')), text: msg })
      }
    }
    out.sort((a, b) => a.ts - b.ts)
    const newestTs = out.length ? out[out.length - 1].ts : 0
    // 去重状态只保留回看窗口；不能按条数截断同秒边界，否则迟到消息会再次漏掉。
    const checkpoint = {
      replayFrom: since,
      legacyDigestedBefore: Number(group.legacyDigestedBefore) || (!Array.isArray(group.seenMessages) ? digestedAtOf(gid) : 0),
      seenMessages: [...seen].filter(([, ts]) => ts >= since),
    }
    return { rows: out.slice(-msgPerGroup()), total: out.length, newestTs, checkpoint }
  }

  /**
   * 把一批消息压成正文（超字符上限从最早的开始丢），并返回**实际喂进去的那几条**。
   * 水位只按 included 的最新 ts 推进；没喂到的更早消息记为 sampled（本轮采样跳过），
   * 不再假装“都消化了”。
   */
  function transcriptOf(rows) {
    const lines = rows.map((r) => `${r.out ? '→' : ''}[${r.who}] ${r.text}`)
    let total = 0
    const kept = []
    const included = []
    for (let i = lines.length - 1; i >= 0; i -= 1) {
      const size = lines[i].length + 1
      if (kept.length && total + size > maxCharsOf()) break
      total += size
      kept.push(lines[i])
      included.push(rows[i])
    }
    kept.reverse()
    included.reverse()
    return { text: kept.join('\n'), included }
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
    parts.push('4. 不要写以「这轮 / 本轮」开头的临时内容；不要把一次对话写成流水账。')
    parts.push('5. 宁缺毋滥，每个群最多 20 条要点。')
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

  /** 临时叙事（「这轮…」）不写进长期画像：这是积累器的内部措辞，不是稳定信息。 */
  const TRANSIENT_RE = /^(?:这轮|本轮)/
  /** 风格类条目的前缀（模型不一定严格写「风格：」，这几个也算）。 */
  const STYLE_PREFIX_RE = /^(?:风格|对话风格|氛围|回话|称呼|语气|唤醒)[：:]/

  /** 解析 `**昵称(QQ)**：事实` / `**昵称（QQ）**：…` / `**QQ（昵称）**：…` / `**QQ**：…`。 */
  function parsePerson(raw) {
    const m = /^\*\*(.+?)\*\*\s*[：:]\s*([\s\S]*)$/.exec(String(raw || '').trim())
    if (!m) return null
    const label = m[1].trim()
    const fact = m[2].trim()
    let mm = /^(.+?)[（(](\d{4,12})[)）]$/.exec(label)
    if (mm) return { qq: mm[2], nick: mm[1].trim(), fact }
    mm = /^(\d{4,12})[（(](.+?)[)）]$/.exec(label)
    if (mm) return { qq: mm[1], nick: mm[2].trim(), fact }
    if (/^\d{4,12}$/.test(label)) return { qq: label, nick: '', fact }
    return null
  }

  /** 存储行带 `- ` 前缀：解析前先剥掉。 */
  function parsePersonLine(line) {
    return parsePerson(String(line || '').replace(/^[-*]\s+/, '').trim())
  }

  /** 把旧版 `；**QQ（昵称）**：…` 这种一条里套两条的 run-on 拍平，避免越滚越长。 */
  function cleanFact(fact) {
    return String(fact || '')
      .replace(/[；;]\s*\*\*[^*\n]{0,120}?[（(]\s*\d{4,12}\s*[)）][^*\n]{0,40}?\*\*\s*[：:]\s*/g, '；')
      .replace(/[；;]\s*\*\*\s*\d{4,12}\s*[（(][^*\n]{0,40}?[)）]\s*\*\*\s*[：:]\s*/g, '；')
      .replace(/[；;]\s*\*\*\s*\d{4,12}\s*\*\*\s*[：:]\s*/g, '；')
      // 把「这轮…」这类临时叙事从事实里剥掉（长期画像只留稳定信息）
      .replace(/(?:^|[；。])\s*(?:这轮|本轮)[^；。]*/g, '')
      .replace(/\s+/g, ' ')
      .replace(/^[；;、,，\s]+/, '')
      .trim()
  }

  /** 事实列表去重（旧被新覆盖时保留更完整的新版本）+ 从最新往前截到 maxLen。 */
  function joinFacts(facts, maxLen = 400) {
    const list = []
    for (const f of facts) {
      const t = cleanFact(f)
      const n = normText(t)
      if (!t || !n) continue
      let dup = false
      for (let k = 0; k < list.length; k += 1) {
        const x = list[k]
        if (x.n.includes(n)) { dup = true; break }
        if (n.includes(x.n)) { list.splice(k, 1); k -= 1 }
      }
      if (!dup) list.push({ t, n })
    }
    const kept = []
    let len = 0
    for (let i = list.length - 1; i >= 0; i -= 1) {
      const add = list[i].t.length + 1
      if (kept.length && len + add > maxLen) break
      kept.push(list[i].t)
      len += add
    }
    kept.reverse()
    return kept.join('；')
  }

  function renderPerson(nick, qq, fact) {
    return `- **${nick || qq}(${qq})**：${fact}`
  }

  /** 同一 QQ 的多条画像合并成一条（旧文件里重复条目的渐进清理）。 */
  function normalizePeople(peopleSec, stat) {
    const slots = new Map()
    const next = []
    for (const line of peopleSec.lines) {
      const p = parsePersonLine(line)
      if (!p) { next.push(line); continue }
      if (!slots.has(p.qq)) {
        const slot = { qq: p.qq, nick: p.nick, facts: [cleanFact(p.fact)].filter(Boolean), plain: line }
        slots.set(p.qq, slot)
        next.push(slot)
      } else {
        const slot = slots.get(p.qq)
        const fact = cleanFact(p.fact)
        if (fact) slot.facts.push(fact)
        if (!slot.nick && p.nick) slot.nick = p.nick
        stat.dropped += 1
      }
    }
    const rendered = []
    for (const x of next) {
      if (typeof x === 'string') { rendered.push(x); continue }
      const fact = joinFacts(x.facts)
      if (!fact) { stat.dropped += 1; continue } // 全是临时内容 → 不留空壳
      rendered.push(renderPerson(x.nick, x.qq, fact))
    }
    peopleSec.lines = rendered
  }

  /** 新增一个群友事实：同 QQ 合并；昵称以新提交的为准（认人仍看 QQ）。 */
  function mergePerson(peopleSec, p, fact, stat) {
    const idx = peopleSec.lines.findIndex((line) => {
      const q = parsePersonLine(line)
      return q && q.qq === p.qq
    })
    if (idx < 0) {
      peopleSec.lines.push(renderPerson(p.nick, p.qq, fact))
      stat.added += 1
      return
    }
    const oldP = parsePersonLine(peopleSec.lines[idx])
    const oldFact = cleanFact(oldP.fact)
    const nOld = normText(oldFact)
    const nNew = normText(fact)
    if (!nNew || nOld.includes(nNew)) return
    const merged = joinFacts([oldFact, fact], 400)
    const nick = p.nick || oldP.nick
    peopleSec.lines[idx] = renderPerson(nick, p.qq, merged)
    stat.updated += 1
  }

  /** 每节条数上限 + 全文体积预算：超出从最早的（最旧的）开始丢，保证正文 <= maxBytes 的 92%。 */
  function trimSections(sections, preambleText, stat) {
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
    const budget = Math.floor(maxBytesOfSafe() * 0.92) - Buffer.byteLength(String(preambleText || ''), 'utf8')
    if (budget <= 0 || !sections.length) return
    // 预算优先保「群里的人」（长期画像），风格/其它更容易重写；否则长条目会把老群友挤掉
    const weights = sections.map((s) => (PEOPLE_HEAD.test(s.title) ? 0.7 : STYLE_HEAD.test(s.title) ? 0.15 : 0.15))
    const wsum = weights.reduce((a, b) => a + b, 0) || 1
    sections.forEach((s, i) => {
      const secBudget = Math.floor((budget * weights[i]) / wsum)
      const bytes = (l) => Buffer.byteLength(l, 'utf8') + 1
      const bullets = s.lines.filter((l) => /^[-*]\s+/.test(l.trim()))
      const plain = s.lines.filter((l) => !/^[-*]\s+/.test(l.trim()))
      const kept = []
      let sum = 0
      for (let k = bullets.length - 1; k >= 0; k -= 1) {
        const add = bytes(bullets[k])
        if (kept.length && sum + add > secBudget) { stat.dropped += 1; continue }
        kept.push(bullets[k])
        sum += add
      }
      kept.reverse()
      s.lines = plain.concat(kept)
    })
  }

  /**
   * 增量要点合并进记忆文件。
   * 返回 `{added, updated, dropped, parsed, none, transient}`：
   *   · `parsed` = 识别到的要点条数（0 且 `none`=false 说明模型没按格式提交 → 调用方不应推水位）
   *   · `none`   = 模型明确写了「（无新增）」
   */
  function mergeDigest(gid, digestText) {
    const stat = { added: 0, updated: 0, dropped: 0, parsed: 0, none: false, transient: 0 }
    const bullets = []
    for (const line of String(digestText || '').split('\n')) {
      const raw = line.trim().replace(/^[-*]\s+/, '').trim()
      if (!raw) continue
      if (/^[（(]?无新增[）)]?$/.test(raw)) { stat.none = true; continue }
      if (!/^[-*]\s+/.test(line.trim())) continue
      bullets.push(raw)
    }
    stat.parsed = bullets.length
    if (!bullets.length && !stat.none) return stat

    const old = readMemoryOf(gid)?.text || ''
    const parsed = splitMemory(old)
    // 旧版把读侧截断提示写进了正文；合并时顺手清掉（它不是记忆内容）
    const dropCutMarker = (lines) => lines.filter((l) => !/本群记忆过长已截断/.test(String(l)))
    parsed.preamble = dropCutMarker(parsed.preamble)
    for (const sec of parsed.sections) {
      sec.lines = dropCutMarker(sec.lines)
        .map((line) => {
          const text = String(line).trim()
          if (!/^[-*]\s+/.test(text)) return line
          const body = text.replace(/^[-*]\s+/, '')
          if (/^\*\*/.test(body)) return line // 群友条目由 normalizePeople 统一清洗
          const cleaned = cleanFact(body) // 顺手清掉旧条目里夹带的「这轮…」临时叙事
          return cleaned ? `- ${cleaned}` : ''
        })
        .filter((l) => {
          if (!l) return false
          const text = String(l).trim().replace(/^[-*]\s+/, '')
          return !(TRANSIENT_RE.test(text)) // 旧文件里的「这轮…」条目整条清掉
        })
    }
    const sections = parsed.sections
    const ensureSection = (title, re) => {
      let s = sections.find((x) => re.test(x.title))
      if (!s) { s = { title, lines: [] }; sections.push(s) }
      return s
    }
    const styleSec = ensureSection('唤醒与对话风格', STYLE_HEAD)
    const peopleSec = ensureSection('群里的人', PEOPLE_HEAD)
    const otherSec = ensureSection('其它', OTHER_HEAD)

    // 先做一次重复画像归一（旧版 rewrite 留下的重复条目会在这里逐步收掉）
    normalizePeople(peopleSec, stat)

    for (const raw of bullets) {
      if (TRANSIENT_RE.test(raw)) { stat.transient += 1; continue }
      const person = parsePerson(raw)
      if (person) {
        const fact = cleanFact(person.fact)
        if (!fact) continue
        if (TRANSIENT_RE.test(fact)) { stat.transient += 1; continue }
        mergePerson(peopleSec, person, fact, stat)
        continue
      }
      const isStyle = STYLE_PREFIX_RE.test(raw)
      const text = cleanFact(raw.replace(STYLE_PREFIX_RE, '').replace(/^其它[：:]\s*/, ''))
      const nNew = normText(text)
      if (!nNew) continue
      if (TRANSIENT_RE.test(text)) { stat.transient += 1; continue }
      const target = isStyle ? styleSec : otherSec
      const exists = target.lines.some((l) => {
        const n = normText(l.replace(/^[-*]\s+/, ''))
        return n && (n.includes(nNew) || nNew.includes(n))
      })
      if (exists) continue
      target.lines.push(`- ${text}`)
      stat.added += 1
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
    preamble = preamble.trim()
    trimSections(sections, preamble, stat)
    const parts = [preamble]
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
      const seen = new Set((state.groups[gid]?.seenMessages || []).map(([key]) => key))
      const file = path.join(dir, n)
      let text = ''
      try { text = fs.readFileSync(file, 'utf8') } catch { continue }
      const rows = []
      let removed = 0
      for (const line of text.split('\n')) {
        if (!line.trim()) continue
        let row
        try { row = JSON.parse(line) || {} } catch { row = {} }
        const ts = Number(row?.ts) || 0
        const expired = cutoff > 0 && ts > 0 && ts < cutoff
        const digested = digestedAt > 0 && isDigested(gid, row, seen)
        if (expired && digested) { removed += 1; continue }
        rows.push({ line, ts, digested })
      }
      if (keepRows > 0 && rows.length > keepRows) {
        const overflow = rows.length - keepRows
        let dropped = 0
        const kept = []
        for (const r of rows) {
          if (dropped < overflow && r.digested) { dropped += 1; removed += 1; continue }
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
      `5. 过时或明显不对的旧条目要修正或删掉；宁缺毋滥，总长度控制在 ${Math.floor(maxBytesOfSafe() * 0.9 / 3)} 字（约 ${Math.floor(maxBytesOfSafe() * 0.9)} 字节）以内。`,
      '6. 记忆里提到机器人自己一律用「我」，不要写人设。',
      '7. 不要写以「这轮 / 本轮」开头的临时内容。',
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
    parts.push(`5. 过时或明显不对的旧条目要修正或删掉；宁缺毋滥，每个群控制在 ${Math.floor(maxBytesOfSafe() * 0.9 / 3)} 字以内。`)
    parts.push('6. 记忆里提到机器人自己一律用「我」，不要写人设。')
    parts.push('7. 不要写以「这轮 / 本轮」开头的临时内容。')
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

  /** 版本文件命名：积累器 `<gid>-YYYYMMDD-HHmmss[-n].md`，控制台手改 `<gid>-YYYYMMDD-HHmmss-manual.md`。 */
  const revisionReOf = (gid) => new RegExp(`^${gid}-(?:\\d{8}-\\d{6}(?:-\\d+)?|\\d{8}-\\d{6}-manual)\\.md$`)

  /** 只保留某群最近 keep 份历史版本（按 mtime；同秒序号不影响判定）。返回删了几份。 */
  function pruneRevisionsFor(gid, keep) {
    const revDir = path.join(memoryDirOf(), REVISIONS)
    let names = []
    try { names = fs.readdirSync(revDir) } catch { return 0 }
    const re = revisionReOf(gid)
    const entries = names.filter((n) => re.test(n))
      .map((n) => ({ n, at: (() => { try { return fs.statSync(path.join(revDir, n)).mtimeMs } catch { return 0 } })() }))
      .sort((a, b) => a.at - b.at || a.n.localeCompare(b.n))
    let removed = 0
    for (const e of entries.slice(0, Math.max(0, entries.length - keep))) {
      try { fs.unlinkSync(path.join(revDir, e.n)); removed += 1 } catch { /* ignore */ }
    }
    return removed
  }

  /** 每轮顺手把所有群的历史版本按当前 retainRevisions 收一遍（死群多余版本也会清）。 */
  function pruneAllRevisions() {
    const keep = retainRevisions()
    if (keep <= 0) return { files: 0, removed: 0 }
    let names = []
    try { names = fs.readdirSync(path.join(memoryDirOf(), REVISIONS)) } catch { return { files: 0, removed: 0 } }
    const gids = new Set()
    for (const n of names) {
      const m = /^(\d{4,12})-(?:\d{8}-\d{6}(?:-\d+)?|\d{17}-manual)\.md$/.exec(n)
      if (m) gids.add(m[1])
    }
    let files = 0
    let removed = 0
    for (const gid of gids) {
      const r = pruneRevisionsFor(gid, keep)
      if (r > 0) { files += 1; removed += r }
    }
    return { files, removed }
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
        pruneRevisionsFor(gid, keep) // 只保留最近 N 份（包括控制台手改留下的 -manual 备份）
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
    const bytes = Buffer.byteLength(body, 'utf8')
    const cap = maxBytesOfSafe()
    if (bytes > cap) return { gid, status: 'failed', detail: `模型输出 ${bytes} 字节，超过单篇上限 ${cap}（会读不全）` }
    const wrote = writeMemory(gid, body)
    return { gid, status: wrote ? 'updated' : 'skipped', detail: wrote ? `${bytes} 字节` : '内容未变化' }
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
    // 解析 0 条 ≠ 无新增：模型把要点写成段落/表格时不能假装处理过，否则这批聊天会被静默跳过。
    if (!m.parsed && !m.none) {
      throw new Error('points 里没有解析到任何 Markdown 列表行；请按 `- **昵称(QQ)**：…` / `- 风格：…` / `- 其它：…` 重新提交，没有新增写「（无新增）」')
    }
    const fedTs = b.lastFedTs?.get?.(gid) || 0
    markDigested(gid, fedTs, b.checkpoints.get(gid))
    b.applied.add(gid)
    b.result.sampledOut = (b.result.sampledOut || 0) + (b.sampled?.get?.(gid) || 0)
    recordGroup(b.result, gid, (m.added || m.updated || m.dropped) ? 'updated' : 'skipped')
    const i = b.result.digest.findIndex((x) => x && x.gid === gid)
    if (i >= 0) b.result.digest.splice(i, 1)
    b.result.digest.push({ gid, ...m, via: 'tool' })
    log.info(`[群记忆] 工具提交 ${gid} → +${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}${m.transient ? ` / 丢弃临时 ${m.transient}` : ''}`)
    return {
      ok: true,
      group_id: gid,
      added: m.added,
      updated: m.updated,
      dropped: m.dropped,
      transient: m.transient,
      message: (m.added || m.updated || m.dropped)
        ? `已合并（新增 ${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}）`
        : (m.none ? '没有新增要点，已记下这个群处理过了' : '已提交，但没有可写入的新事实'),
    }
  }

  /**
   * 单个群积累一次（逐群模式 / 批量漏群兜底）。
   * itemIn = `{rows,total}`（runRound 取好的窗口）；不传则现读。
   * 返回 `{gid, status:'updated'|'skipped'|'failed', detail, sampled?}`。
   */
  async function accumulateGroup(gid, itemIn, modeIn) {
    const mode = modeIn || (accumulateMode() === 'digest' ? 'digest' : 'rewrite')
    const item0 = Array.isArray(itemIn) ? { rows: itemIn, total: itemIn.length } : (itemIn || readRecentMessages(gid))
    const rows = item0.rows || []
    if (rows.length < minNewMsgs()) {
      return { gid, status: 'skipped', detail: `最近消息 ${rows.length} 条 < 门槛 ${minNewMsgs()}` }
    }
    const runner = bot.dsh?.runIsolatedTask
    if (typeof runner !== 'function') {
      return { gid, status: 'failed', detail: '内核不支持后台任务（runIsolatedTask），无法积累' }
    }
    const tr = transcriptOf(rows)
    const lastFedTs = tr.included.length ? (Number(tr.included[tr.included.length - 1].ts) || 0) : 0
    const sampled = Math.max(0, Number(item0.total || rows.length) - tr.included.length)
    const old = readMemoryOf(gid)
    const item = { gid, oldText: old?.text || '', transcript: tr.text }
    callsInRound += 1
    const res = await runner({
      name: `群记忆积累(${gid}${mode === 'digest' ? '·增量' : ''})`,
      prompt: mode === 'digest' ? buildDigestPrompt([item]) : buildPrompt(item),
      cwd: dataDirOf(),
      timeoutMs: 10 * 60 * 1000,
    })
    if (mode === 'digest') {
      const parsed = parseBatchOutput(res?.text, [gid])
      if (!parsed.size) return { gid, status: 'failed', detail: '模型输出为空或格式不符', sampled }
      const m = mergeDigest(gid, parsed.get(gid))
      if (!m.parsed && !m.none) return { gid, status: 'failed', detail: '模型提交的内容没有可解析的列表行，未写盘（不推水位）', sampled }
      markDigested(gid, lastFedTs, item0.checkpoint)
      return {
        gid,
        status: (m.added || m.updated || m.dropped) ? 'updated' : 'skipped',
        detail: (m.added || m.updated || m.dropped)
          ? `要点 +${m.added} / 更新 ${m.updated} / 裁剪 ${m.dropped}`
          : '无新增要点',
        sampled,
      }
    }
    const r = applyModelText(gid, res?.text)
    if (r.status !== 'failed') markDigested(gid, lastFedTs, item0.checkpoint)
    return { ...r, sampled }
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
      const tr = transcriptOf(d.rows)
      const lastFedTs = tr.included.length ? (Number(tr.included[tr.included.length - 1].ts) || 0) : 0
      const sampled = Math.max(0, Number(d.total || d.rows.length) - tr.included.length)
      const size = (old?.text || '').length + tr.text.length + 400
      if (cur.length && curLen + size > batchMaxCharsOf()) { chunks.push(cur); cur = []; curLen = 0 }
      cur.push({ gid: d.gid, rows: d.rows, oldText: old?.text || '', transcript: tr.text, lastFedTs, sampled, checkpoint: d.checkpoint })
      curLen += size
    }
    if (cur.length) chunks.push(cur)

    for (const chunk of chunks) {
      const items = chunk.map((it) => ({
        gid: it.gid, oldText: it.oldText, transcript: it.transcript, lastFedTs: it.lastFedTs, sampled: it.sampled, checkpoint: it.checkpoint,
      }))
      const mode = accumulateMode() === 'rewrite' ? 'rewrite' : 'digest'
      const gids = new Set(items.map((it) => it.gid))
      const viaTool = new Set() // 本轮模型用 memory_append 提交过的群
      let res
      // digest：开「工具提交」入口（模型跑这一轮期间有效；submit 里合并/记账）。
      // 同时把每个群「实际喂到的最新 ts / 采样跳过数」交给 submit —— 水位不能再用 Date.now()。
      activeBatch = mode === 'digest'
        ? {
          gids,
          result,
          applied: viaTool,
          checkpoints: new Map(items.map((it) => [it.gid, it.checkpoint])),
          lastFedTs: new Map(items.map((it) => [it.gid, it.lastFedTs])),
          sampled: new Map(items.map((it) => [it.gid, it.sampled])),
        }
        : null
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
              if (!m.parsed && !m.none) {
                result.failed.push({ gid: it.gid, detail: '正文里没有可解析的列表行，未写盘（不推水位）' })
                continue
              }
              markDigested(it.gid, it.lastFedTs, it.checkpoint)
              result.sampledOut = (result.sampledOut || 0) + (it.sampled || 0)
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
          if (r.status !== 'failed') {
            markDigested(it.gid, it.lastFedTs, it.checkpoint)
            result.sampledOut = (result.sampledOut || 0) + (it.sampled || 0)
            if (r.status === 'updated') result.updated.push(it.gid)
            else result.skipped.push(it.gid)
          } else {
            result.failed.push({ gid: it.gid, detail: r.detail })
          }
        } catch (e) {
          result.failed.push({ gid: it.gid, detail: String(e.message || e) })
        }
      }
      // 漏群兜底：最多 MAX_BATCH_FALLBACK 个，避免又退回“每群一次”
      for (const it of missing.slice(0, MAX_BATCH_FALLBACK)) {
        try {
          const r = await accumulateGroup(it.gid, it, mode)
          result.sampledOut = (result.sampledOut || 0) + (r.sampled || 0)
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
    const picked = pickGroups()
    const ids = picked.selected
    const result = {
      ok: true, trigger,
      groups: ids.length, deferred: picked.deferred, sampledOut: 0,
      updated: [], skipped: [], failed: [], digest: [], calls: 0, pruned: null, prunedRevisions: null,
    }
    const due = []
    for (const gid of ids) {
      if (!accumulateOn() && trigger === 'schedule') break // 跑的过程中被关掉：立即停
      const rd = readRecentMessages(gid)
      if (rd.rows.length < minNewMsgs()) {
        result.skipped.push(gid)
        continue
      }
      due.push({ gid, rows: rd.rows, total: rd.total, newestTs: rd.newestTs, checkpoint: rd.checkpoint })
    }
    if (due.length) {
      if (accumulateMode() === 'per-group') {
        for (const d of due) {
          try {
            const r = await accumulateGroup(d.gid, d, 'rewrite')
            result.sampledOut += r.sampled || 0
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
    // 群很多时本轮只处理前 N 个：记下轮转游标，下一轮从下一个群开始（否则大号段群永远饿死）
    if (ids.length) cursor = ids[ids.length - 1]
    // 车轮清理：只删「已消化 且 超过保留窗口」的原始记录
    try { result.pruned = pruneArchive() } catch (e) { log.warn(`[群记忆] 旧记录清理失败: ${e.message}`) }
    try { result.prunedRevisions = pruneAllRevisions() } catch (e) { log.warn(`[群记忆] 旧版本清理失败: ${e.message}`) }
    result.calls = callsInRound
    result.ms = Date.now() - started
    const pruneNote = result.pruned?.removed ? `，清理 ${result.pruned.removed} 行旧记录` : ''
    const sampledNote = result.sampledOut > 0 ? `，采样跳过 ${result.sampledOut} 条` : ''
    const deferNote = result.deferred > 0 ? `，${result.deferred} 个群下轮处理` : ''
    result.message = `更新 ${result.updated.length} / 跳过 ${result.skipped.length} / 失败 ${result.failed.length}（本轮 ${result.calls} 次模型调用${sampledNote}${pruneNote}${deferNote}）`
    if (result.sampledOut > 0) log.warn(`[群记忆] 本轮有 ${result.sampledOut} 条新消息因每群条数/字数上限未被提炼（已按采样跳过，不会回补；需要更高覆盖率请调大 accumulateMsgPerGroup / accumulateMaxChars）`)
    if (result.deferred > 0) log.warn(`[群记忆] 本轮按上限只处理 ${ids.length} 个群，剩 ${result.deferred} 个下轮轮转处理`)
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
      maxGroupsPerRound: maxGroupsOf(),
      sampledOut: Number(lastResult?.sampledOut) || 0,
      deferred: Number(lastResult?.deferred) || 0,
      running: Boolean(running),
      lastRunAt: lastRunAt || 0,
      nextDueAt: nextDueAt(),
      lastResult: lastResult || null,
      lastError: lastError || '',
    }
  }
  let timer = null
  const start = () => {
    if (timer) return timer // 幂等：重复 setup/apply 不会叠出第二个定时器
    timer = setInterval(() => {
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

  /** 停止定时器（fiber 卸载 / 插件禁用时调用；幂等）。 */
  const stop = () => {
    if (!timer) return false
    clearInterval(timer)
    timer = null
    return true
  }

  return { status, trigger, manual, sync, submit, start, stop }
}
