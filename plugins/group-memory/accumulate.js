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
 *   ② 在**独立的一次性后台会话**里让模型输出更新后的完整 Markdown（内核 runIsolatedTask，
 *      该会话被内核禁止调用任何工具，不会误发 QQ 消息）；
 *   ③ 原子写回 `qq-memory/<群号>.md`，旧版备份到 `.revisions/`（保留 N 份）。
 *
 * 代价与保护：单飞锁、单群失败隔离、一轮群数上限、首启 5 分钟缓冲、少于门槛跳过。
 */
import fs from 'node:fs'
import path from 'node:path'
import { readJsonFile, writeJsonFileSync, atomicWriteFileSync } from '../../platform/atomic.js'
import { ensureDir } from '../../platform/paths.js'

/** 单轮最多处理多少个群（防止首次开启时一口气跑几十个模型调用）。 */
const MAX_GROUPS_PER_ROUND = 12
/** 历史版本子目录（与旧版布局一致）。 */
const REVISIONS = '.revisions'

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
  const lookbackMs = () => num(cfg.accumulateLookbackHours, 8, 1, 72) * 3600 * 1000
  const msgPerGroup = () => Math.round(num(cfg.accumulateMsgPerGroup, 200, 20, 1000))
  const maxCharsOf = () => Math.round(num(cfg.accumulateMaxChars, 8000, 1000, 30000))
  const minNewMsgs = () => Math.round(num(cfg.accumulateMinNewMsgs, 20, 0, 500))
  const retainRevisions = () => Math.round(num(cfg.accumulateRetainRevisions, 20, 0, 200))
  /** 某群的记忆文件路径（与读取侧同一目录、同一命名）。 */
  const fileOf = (gid) => path.join(memoryDirOf(), `${gid}.md`)
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
    const old = readMemoryOf(gid)
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

  return { status, trigger, manual, sync, start }
}
