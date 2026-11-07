/**
 * kernel/pacing.js — 回复节奏：**静默合批** + **主动接话**。
 *
 * 一块是时间维度、一块是"要不要自己开口"，都只有内核知道：
 *   · 等待槽：唤醒消息先压 `pacing.merge.waitMs`（默认 5 秒）再入站 —— 私聊合批（窗口内
 *     所有消息并入并刷新计时）、群聊排队（唤醒各自成轮，窗口内非唤醒消息并入当前轮）。
 *     非唤醒消息只并入当前打开的槽，永远不单独成轮；机器人正在回答时唤醒直接排队。
 *   · 主动接话：没人叫也偶尔接一句。一次"机会"= 最多一轮模型调用；
 *     到点后等一个**合适的时机**（按语境打分），拿不到就放弃这一次，绝不硬凑。
 *     命中后发一条**候选入站**给模型，由模型自己判断接不接（不调发送工具 = 不接）。
 *
 * 纪律：
 *   · 本模块**不发消息**（出站只有 deliver，由内核那一侧负责），也不碰 prompt。
 *   · 参数全部来自实例配置的 `pacing.reply` / `pacing.merge`（控制台可改，热生效）。
 *   · 主动接话轮 `wake.kind='proactive'`，出站强制不 @ 不引用（内核 decorate 钩子硬挡）。
 *   · **默认不启用主动接话**（配置里 `pacing.reply.enabled` 默认 false）：不启用时不装调度定时器、
 *     也不起念；只有显式开启后才 start/apply 起来。
 *
 * 频率口径（控制台/文档只认这一种，别再搞第二套算法）：
 *   群聊/私聊共用 interval 随机窗；每次安排只抽一次并持久化 nextAt。
 *   真实发送才累加未回，真人私聊/明确群唤醒重置；普通群消息不重排。
 */

const HOUR = 3600000
const clamp01 = (v) => Math.max(0, Math.min(1, Number(v) || 0))
const num = (v, d) => (Number.isFinite(Number(v)) ? Number(v) : d)
const log1p = (v) => Math.log1p(Math.max(0, Number(v) || 0))

/** 主动接话默认参数：配置缺键时用它（与 config-store v2 的默认配置对齐，改默认值只改这里） */
export const REPLY_DEFAULTS = {
  enabled: false,            // 默认关：不装调度、不起念
  interval: { minMs: 3600000, maxMs: 14400000, unansweredMinMs: 14400000,
    unansweredMaxMs: 36000000, maxBackoffMs: 86400000 },
  silenceEnabled: true,      // 冷场找话：关 = 只在群里有新消息时才可能接话（不定时找话）
  topicWindowMs: 600000,     // 机会窗口：到点后再等多久的合适时机（10 分钟）
  topicMinMsgs: 3,           // 窗口内至少几条消息才按"话题"挑时机（防单条消息就接）
  sensitivity: 0.45,         // 语境敏感度 0~1（越高越挑"值得接"的时机）
  maxChars: 140,             // 主动接话单条字数上限（提示用；超了照发但记日志）
  groups: [],                // 允许主动接话的群号（数组或 {"群号": true} 对象都认）
  quietHours: { enabled: true, start: '23:00', end: '08:00', timeZone: 'Asia/Shanghai' },
  privateChats: [],          // 允许主动问候的 QQ 数字数组；与群共用 enabled 总闸
  // 连续对话（2026-10-27）：被真人叫过、且它回过话之后，等一会儿把这期间的新消息塞回模型再判一次。
  // 只暴露 enabled / delayMs / bonus 三个到控制台；其余是防"自己转"的内部闸门（改这里就够了）。
  continuation: {
    enabled: false,          // 总开关（默认关；跟主动接话一起受 pacing.reply.enabled 总闸管）
    delayMs: 120000,         // 回完话后等多久再检查（默认 2 分钟）
    bonus: 1.5,              // 复用主动接话 9 个权重的"情境加分"（直接加到 logit 上）
    hourlyMax: 5,            // 每群每小时最多续几次（内部闸门）
    minGapMs: 300000,        // 两次续聊最小间隔（5 分钟，内部闸门）
    maxPerChain: 1,          // 一次唤醒最多检查几次（1 = 补一次就收手，防自转）
    requireNewMessage: true, // 它回完之后必须有人类新消息才检查（关掉容易变成自问自答）
    quoteLastHuman: false,   // 续聊是否引用最后一条人类消息（默认不引用）
  },
  style: {
    splitEnabled: true,
    splitProbability: 0.5,   // 拆条概率（0~1）
    splitMinLen: 12,
    splitDelayMs: 1000,
    splitMaxParts: 3,        // 一段回复最多拆几条（2~4）
    stickerEnabled: true,
    stickerProbability: 0.8, // 表情包概率（0~1）
  },
  weights: {                 // 语境权重（MaiBot 日志拟合值；一般不用动，改「语境敏感度」就够了）
    intercept: -1.2005,
    mentionBot: 1.5852,
    atOther: -1.1157,
    hasQuestion: 0.4807,
    placeholderOnly: -1.0281,
    selfRatio: 2.6525,
    recentCount: -0.0367,
    logSecondsSinceBot: 0.0571,
    pendingCount: 0.1012,
  },
}

/**
 * 合批默认参数（与 config-store v2 的默认配置对齐）。
 * 语义只有一条：**唤醒消息先压 `waitMs`，等待期内到达的消息并进同一轮**。
 *   · 私聊 = 合批：窗口内每条唤醒都并入并刷新计时（debounce），安静 waitMs 后一次入站；
 *   · 群聊 = 排队：唤醒消息各自独立成轮；窗口内又来唤醒 → 当前槽立即发车、新唤醒开新槽；
 *   · 非唤醒消息只并入当前槽，永远不单独成轮；机器人正在回答时唤醒直接排队（不合批）。
 */
export const MERGE_DEFAULTS = {
  enabled: true,
  waitMs: 5000,           // 唤醒后等多久再入站（等待期内的消息并进同一轮）
  loadImages: true,       // 合批后由内核统一载入全部消息的图片；关闭时仅首条
}

/** 合并文本里的发送人前缀：`[昵称(QQ:号)]`（群里分辨谁说的；私聊同格式便于模型对齐） */
function senderTag(ev) {
  const name = String(ev?.sender?.card || ev?.sender?.name || '').trim() || String(ev?.sender?.qq || '?')
  const qq = String(ev?.sender?.qq || '').trim()
  return qq ? `[${name}(QQ:${qq})]` : `[${name}]`
}

/** 被合并消息的一行正文：正文保留 `[图片]` 占位；图片描述另交内核统一载入。 */
function mergedLine(ev) {
  const text = String(ev?.text || '').trim()
  const hasImg = (Array.isArray(ev?.images) && ev.images.length > 0)
    || (Array.isArray(ev?.imageParts) && ev.imageParts.length > 0)
  if (!text && !hasImg) return ''
  const body = text || '[图片]'
  return `${senderTag(ev)}: ${body}${hasImg && text ? ' [图片]' : ''}`
}

/** 兴趣分：把一条群消息按权重算成 0~1 的"值得接吗"（纯函数，自检直接用） */
export function scoreFeatures(f = {}, weights = REPLY_DEFAULTS.weights) {
  const w = { ...REPLY_DEFAULTS.weights, ...(weights || {}) }
  const logit = num(w.intercept, -1.2)
    + num(w.mentionBot, 0) * (f.mentionBot ? 1 : 0)
    + num(w.atOther, 0) * (f.atOther ? 1 : 0)
    + num(w.hasQuestion, 0) * (f.hasQuestion ? 1 : 0)
    + num(w.placeholderOnly, 0) * (f.placeholderOnly ? 1 : 0)
    + num(w.selfRatio, 0) * clamp01(f.selfRatio)
    + num(w.recentCount, 0) * Math.max(0, num(f.recentCount, 0))
    + num(w.logSecondsSinceBot, 0) * log1p(f.secondsSinceBot)
    + num(w.pendingCount, 0) * Math.max(0, num(f.pendingCount, 0))
  const p = 1 / (1 + Math.exp(-logit))
  return { score: p, logit }
}

/** 语境敏感度 → 触发门槛：0% = 0.15（几乎来什么接什么）；50% = 0.50；100% = 0.85（很挑） */
export function thresholdForSensitivity(sensitivity) {
  return Math.max(0, Math.min(0.95, 0.15 + 0.7 * clamp01(sensitivity)))
}

/** Pure shared quiet-hours check. Invalid configuration falls back to safe defaults.
 * config is reply.quietHours; start=end means all day. endAt is an epoch millisecond.
 */
export function quietHoursStatus(config = {}, now = Date.now()) {
  const defaults = REPLY_DEFAULTS.quietHours
  const validTime = (value) => /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(String(value))
  const start = validTime(config?.start) ? config.start : defaults.start
  const end = validTime(config?.end) ? config.end : defaults.end
  let timeZone = config?.timeZone || defaults.timeZone
  let formatter
  const makeFormatter = (zone) => new Intl.DateTimeFormat('en-GB', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  })
  try {
    if (/^[+-]/.test(timeZone)) throw new RangeError('Expected an IANA time zone')
    formatter = makeFormatter(timeZone)
  } catch {
    timeZone = defaults.timeZone
    formatter = makeFormatter(timeZone)
  }
  const partsAt = (at) => Object.fromEntries(formatter.formatToParts(at)
    .filter((part) => part.type !== 'literal').map((part) => [part.type, Number(part.value)]))
  const ts = Number(now)
  const local = partsAt(ts)
  const minutes = local.hour * 60 + local.minute
  const toMinutes = (value) => Number(value.slice(0, 2)) * 60 + Number(value.slice(3))
  const from = toMinutes(start)
  const until = toMinutes(end)
  const enabled = config?.enabled !== false
  const active = enabled && (from === until || (from < until
    ? minutes >= from && minutes < until : minutes >= from || minutes < until))
  let endAt = null
  if (active) {
    const nextDay = from === until || (from > until && minutes >= from)
    const localEnd = Date.UTC(local.year, local.month - 1, local.day + (nextDay ? 1 : 0),
      Math.floor(until / 60), until % 60)
    endAt = ts + (localEnd - Date.UTC(local.year, local.month - 1, local.day, local.hour, local.minute, local.second))
    // Resolve the local wall-clock boundary across timezone offset/DST changes.
    for (let i = 0; i < 4; i += 1) {
      const p = partsAt(endAt)
      const delta = localEnd - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
      if (!delta) break
      endAt += delta
    }
    endAt = Math.floor(endAt / 1000) * 1000
  }
  return { active, enabled, start, end, timeZone, endAt }
}

/** 把实例配置的 `pacing` 段归一成"每块都齐全"的配置（数组/对象两种群号写法都认） */
function normalize(rawPacing) {
  const p = rawPacing && typeof rawPacing === 'object' ? rawPacing : {}
  const r = p.reply && typeof p.reply === 'object' ? p.reply : {}
  const style = r.style && typeof r.style === 'object' ? r.style : {}
  const weights = r.weights && typeof r.weights === 'object' ? r.weights : {}
  const groups = {}
  if (Array.isArray(r.groups)) {
    for (const g of r.groups) if (String(g || '').trim()) groups[String(g).trim()] = true
  } else if (r.groups && typeof r.groups === 'object') {
    for (const [g, on] of Object.entries(r.groups)) if (on === true) groups[String(g)] = true
  }
  const m = p.merge && typeof p.merge === 'object' ? p.merge : {}
  return {
    reply: {
      ...REPLY_DEFAULTS,
      ...Object.fromEntries(Object.entries(r).filter(([k]) => !['style', 'weights', 'groups', 'privatePolicy', 'hourlyMax', 'minGapMs', 'coldSilenceMs'].includes(k))),
      style: { ...REPLY_DEFAULTS.style, ...style },
      weights: { ...REPLY_DEFAULTS.weights, ...weights },
      continuation: { ...REPLY_DEFAULTS.continuation, ...(r.continuation && typeof r.continuation === 'object' ? r.continuation : {}) },
      groups,
      quietHours: { ...REPLY_DEFAULTS.quietHours, ...(r.quietHours && typeof r.quietHours === 'object' ? r.quietHours : {}) },
      privateChats: [...new Set((Array.isArray(r.privateChats) ? r.privateChats : [])
        .filter((id) => /^\d{1,12}$/.test(String(id)) && Number.isSafeInteger(Number(id)) && Number(id) > 0)
        .map((id) => String(Number(id))))],
      interval: (() => {
        const values = Object.fromEntries(Object.entries(REPLY_DEFAULTS.interval).map(([k, fallback]) =>
          [k, Math.max(1, num(r.interval?.[k], fallback))]))
        values.maxMs = Math.max(values.minMs, values.maxMs)
        values.unansweredMaxMs = Math.max(values.unansweredMinMs, values.unansweredMaxMs)
        return values
      })(),
    },
    merge: { ...MERGE_DEFAULTS, ...m },
  }
}

/**
 * @param {{log?: object, state: object}} deps
 *   state — ChatState（用它的 map / get()，不新开一套会话状态）
 */
export function createPacing({ log = console, state, clock = null, random = Math.random,
  timingState = null, onTimingStateChange = null, privateState = {}, onPrivateStateChange = null }) {
  // clock：自检用（可传函数/对象把"现在"钉住）；运行时一律真实时间
  const nowMs = () => {
    const v = typeof clock === 'function' ? Number(clock()) : (clock && typeof clock.now === 'function' ? Number(clock.now()) : NaN)
    return Number.isFinite(v) ? v : Date.now()
  }
  let cfg = normalize(null)
  let lastLogged = ''
  let timer = null
  let onProactiveTurn = null
  let isBusy = () => false
  const timings = new Map()
  const sentTurns = new WeakSet()
  const sentTurnIds = new Set()
  const replyTurns = new WeakSet()
  const replyTurnIds = new Set()
  const notifyTiming = onTimingStateChange || onPrivateStateChange
  // Only timing metadata crosses the persistence boundary, never ChatState/text/session mappings.
  for (const [key, saved] of Object.entries(timingState || privateState || {})) {
    if (!/^(private|group):\d{1,12}$/.test(key) || !saved || typeof saved !== 'object') continue
    timings.set(key, Object.fromEntries(['baselineAt', 'lastInboundAt', 'lastOutboundAt', 'unanswered', 'nextAt']
      .map((k) => [k, saved[k] === null && k === 'nextAt' ? null : Math.max(0, num(saved[k], 0))])))
  }

  function timingStateSnapshot() {
    return Object.fromEntries([...timings].map(([key, timing]) => [key,
      Object.fromEntries(['baselineAt', 'lastInboundAt', 'lastOutboundAt', 'unanswered', 'nextAt'].map((field) => [field, timing[field]]))]))
  }

  function timingChanged() {
    if (typeof notifyTiming !== 'function') return
    try {
      Promise.resolve(notifyTiming(timingStateSnapshot()))
        .catch((e) => log.error(`[主动接话] 计时保存失败: ${e.message}`))
    } catch (e) { log.error(`[主动接话] 计时保存失败: ${e.message}`) }
  }

  function timingOf(key) {
    if (!timings.has(key)) timings.set(key,
      { baselineAt: nowMs(), lastInboundAt: 0, lastOutboundAt: 0, unanswered: 0, nextAt: 0 })
    return timings.get(key)
  }

  const isPrivate = (key) => /^private:\d+$/.test(key)
  const allowedPrivateIds = () => [...cfg.reply.privateChats]
  const allowed = (key) => isPrivate(key)
    ? allowedPrivateIds().includes(key.slice(8))
    : allowedGroups().has(key.replace(/^group:/, ''))
  const busy = (key) => slots.has(key) || isBusy(key)
  const privateSilence = (key, now) => {
    const t = timingOf(key)
    const st = state.get(key)
    return Math.max(0, now - Math.max(t.baselineAt, t.lastInboundAt, t.lastOutboundAt,
      Number(st.lastInboundAt) || 0, Number(st.lastSendAt) || 0))
  }

  // ── 合批 ────────────────────────────────────────────────────
  // 等待槽：chatKey → { evs: 待入站事件, at: 开槽时刻, timer, run }
  const slots = new Map()
  const outbound = new Map() // chatKey → [ts…]（最近 20 条出站，算"自己发言占比"）

  // ── 主动接话 ────────────────────────────────────────────────
  const rings = new Map()    // chatKey → [{ ts, text, mentionBot, atOther, hasQuestion, placeholderOnly, short }]
  const opp = new Map()      // chatKey → { dueAt, windowUntil, fired, missed }
  const fired = []           // 最近主动接话事件 [{ at, chatKey, gid, reason, score, sent }]
  const MAX_RING = 60
  const RING_TTL = 30 * 60000

  function pushRing(map, key, ts, max = 20) {
    const list = map.get(key) || []
    list.push(ts)
    while (list.length > max) list.shift()
    map.set(key, list)
  }

  /** 当前生效的群集合（Set<群号字符串>） */
  function allowedGroups() {
    return new Set(Object.keys(cfg.reply.groups || {}))
  }

  /** 写一条进"最近群消息环"（只收允许主动接话的群；自检也用它造样本） */
  function remember(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    const now = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const text = String(ev.text || '')
    const list = rings.get(key) || []
    list.push({
      ts: now,
      // 记下消息 id：「续聊时引用最后一条人类消息」（quoteLastHuman）要用它挂引用
      id: ev.messageId ?? null,
      text: text.slice(0, 200),
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(text),
      hasQuestion: /[?？]/.test(text),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(text),
      short: text.replace(/[\s\p{P}\p{S}]/gu, '').length < 4,
    })
    while (list.length > MAX_RING) list.shift()
    while (list.length && now - list[0].ts > RING_TTL) list.shift()
    rings.set(key, list)
  }

  /** 记录一条入站（内核在最前面调；必须在管线之前） */
  function noteInbound(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key) return
    const ts = Number(ev.time) > 0 ? Number(ev.time) : nowMs()
    const st = state.get(key)
    const human = !ev.notice && !ev._scratch?.notice
      && !['proactive', 'continuation', 'welcome'].includes(ev.wake?.kind)
    if (!human) return
    st.lastInboundAt = ts
    if (allowed(key) || timings.has(key)) {
      const t = timingOf(key)
      t.lastInboundAt = Math.max(t.lastInboundAt, ts)
      if (isPrivate(key) && ev.sender?.qq) { t.unanswered = 0; t.resetAt = ts; schedule(key, ts) }
    }
    remember(ev)
  }

  /** 记录一条出站（内核的 afterSend 调；用于"自己发言占比"） */
  function seenTurn(token, objects, ids) {
    if (!token) return false
    const object = typeof token === 'object'
    const set = object ? objects : ids
    if (set.has(token)) return true
    set.add(token)
    if (!object && ids.size > 1000) ids.delete(ids.values().next().value)
    return false
  }

  function noteOutbound(target, turnToken = null) {
    const key = String(target ?? '')
    if (!key) return
    pushRing(outbound, key, nowMs())
    if (!allowed(key) && !timings.has(key)) return
    const t = timingOf(key)
    t.lastOutboundAt = nowMs()
    const synthetic = ['proactive', 'continuation', 'welcome', 'command', 'system'].includes(turnToken?.wakeKind)
    if (turnToken?.wakeKind && !synthetic && !seenTurn(turnToken, replyTurns, replyTurnIds)) schedule(key, nowMs())
    else timingChanged()
  }

  /** 主动接话轮里真的发出了一条 → 记在最近事件上（控制台"最近"里显示已接） */
  function markSent(chatKey, turnToken = null) {
    const objectToken = turnToken && typeof turnToken === 'object'
    if (turnToken && (objectToken ? sentTurns.has(turnToken) : sentTurnIds.has(turnToken))) return
    const event = [...fired].reverse().find((e) => e.chatKey === chatKey)
    if (!event || event.sent || nowMs() - event.at >= 10 * 60000) return
    if (turnToken) {
      if (objectToken) sentTurns.add(turnToken)
      else {
        sentTurnIds.add(turnToken)
        if (sentTurnIds.size > 1000) sentTurnIds.delete(sentTurnIds.values().next().value)
      }
    }
    event.sent = true
    const t = timingOf(chatKey)
    if ((t.resetAt || 0) <= event.at) t.unanswered += 1
    schedule(chatKey, nowMs())
  }

  function sample(min, max) {
    return Math.round(min + (max - min) * clamp01(random()))
  }

  function randomGap(key, normal = false) {
    const interval = cfg.reply.interval
    const count = normal ? 0 : timingOf(key).unanswered
    if (!count) return sample(interval.minMs, interval.maxMs)
    const factor = 2 ** Math.min(30, count - 1)
    return sample(Math.min(interval.maxBackoffMs / 2, interval.unansweredMinMs * factor),
      Math.min(interval.maxBackoffMs, interval.unansweredMaxMs * factor))
  }

  function daytimeTarget(key, target) {
    const q = quietHoursStatus(cfg.reply.quietHours, target)
    if (!q.active) return target
    if (q.start === q.end) return null
    // Draw once after the quiet boundary. If that draw is nighttime too, project its
    // offset into the following daylight span instead of drawing forever.
    const candidate = q.endAt + randomGap(key, true)
    const next = quietHoursStatus(cfg.reply.quietHours, candidate)
    if (!next.active) return candidate
    const [sh, sm] = q.start.split(':').map(Number)
    const [eh, em] = q.end.split(':').map(Number)
    const daylightMs = ((sh * 60 + sm - eh * 60 - em + 1440) % 1440) * 60000
    return next.endAt + Math.min(daylightMs - 1, Math.max(1, (candidate - q.endAt) % daylightMs))
  }

  function setNext(key, nextAt) {
    const o = opp.get(key) || { dueAt: null, windowUntil: 0, fired: 0, missed: 0 }
    o.dueAt = nextAt
    o.windowUntil = 0
    opp.set(key, o)
    timingOf(key).nextAt = nextAt
    timingChanged()
    return o
  }

  function schedule(key, from = nowMs()) {
    return setNext(key, daytimeTarget(key, from + randomGap(key)))
  }

  const isQuietTime = () => quietHoursStatus(cfg.reply.quietHours, nowMs()).active

  /** Normalize a saved/nighttime target once, never redraw on every tick. */
  function deferQuietOpportunity(key, o, now) {
    const current = quietHoursStatus(cfg.reply.quietHours, now)
    if (o.dueAt !== null) {
      const target = current.active && o.dueAt <= now ? now : o.dueAt
      const nextAt = daytimeTarget(key, target)
      if (nextAt !== o.dueAt) setNext(key, nextAt)
    }
    return current.active
  }

  function deferQuietOpportunities(now) {
    for (const [key, o] of opp) deferQuietOpportunity(key, o, now)
  }

  /** 某群的"下一次机会"状态（懒创建；开机后第一次随机错开，避免重启瞬间一起开口） */
  function oppOf(chatKey) {
    let o = opp.get(chatKey)
    if (!o) {
      const t = timingOf(chatKey)
      o = t.nextAt === null || t.nextAt > 0 ? setNext(chatKey, t.nextAt) : schedule(chatKey)
    }
    deferQuietOpportunity(chatKey, o, nowMs())
    return o
  }

  /** 从宿主事件/环算兴趣分（给自检与日志看；也供外部插件调用） */
  function interestFor(ev = {}) {
    const key = String(ev.chatKey ?? '')
    const st = key ? state.get(key) : { lastSendAt: 0 }
    const now = nowMs()
    const list = (rings.get(key) || []).filter((m) => now - m.ts < 5 * 60000)
    const recentOut = (outbound.get(key) || []).filter((t) => now - t < 5 * 60000)
    const total = list.length + recentOut.length
    const features = {
      mentionBot: !!ev.mentionedSelf,
      atOther: /@\d{4,}/.test(String(ev.text ?? '')),
      hasQuestion: /[?？]/.test(String(ev.text ?? '')),
      placeholderOnly: /^\s*\[(表情包|图片|语音|文件|卡片)/.test(String(ev.text ?? '')),
      selfRatio: total > 0 ? recentOut.length / total : 0,
      recentCount: list.length,
      secondsSinceBot: (now - Number(st.lastSendAt || 0)) / 1000,
      pendingCount: isBusy(key) ? 1 : 0,
    }
    return { ...scoreFeatures(features, cfg.reply.weights), features }
  }

  /** 到点后进入"窗口"；窗口过期 = 这次机会作废（宁可少说，不硬凑） */
  function ensureWindow(chatKey, now) {
    const o = oppOf(chatKey)
    if (o.dueAt === null || now < o.dueAt) return null
    if (!o.windowUntil) o.windowUntil = now + Math.max(60000, num(cfg.reply.topicWindowMs, 600000))
    if (now > o.windowUntil) {
      schedule(chatKey, now)
      o.missed += 1
      log.info(`[主动接话] ${chatKey} 本次没有合适时机，重新安排随机机会`)
      return null
    }
    return o
  }

  /** 真正起一轮主动接话：先记账（防止模型/失败反复触发），再交给内核起回合 */
  function fire(chatKey, gid, reason, score) {
    const o = oppOf(chatKey)
    const now = nowMs()
    if (deferQuietOpportunity(chatKey, o, now)) return
    const privateChat = isPrivate(chatKey)
    const silenceMs = privateSilence(chatKey, now)
    const unanswered = timingOf(chatKey).unanswered
    schedule(chatKey, now)
    o.fired += 1
    const payload = { chatKey, groupId: privateChat ? null : gid, isGroup: !privateChat,
      userId: privateChat ? chatKey.slice(8) : null, reason, score, silenceMs, unanswered }
    fired.push({ at: now, chatKey, gid: payload.groupId, ...payload, score: Number(score) || 0, sent: false })
    while (fired.length > 30) fired.shift()
    log.info(`[主动接话] ${chatKey} 起念（${reason === 'silence' ? '冷场找话' : '话题合适'}，兴趣分 ${(Number(score) * 100).toFixed(0)}%）`)
    if (typeof onProactiveTurn !== 'function') return
    Promise.resolve()
      .then(() => {
        if (isQuietTime()) { deferQuietOpportunity(chatKey, o, nowMs()); return }
        return onProactiveTurn(payload)
      })
      .catch((e) => log.error(`[主动接话] 起回合失败 ${chatKey}: ${e.stack || e.message}`))
  }

  /**
   * 一条**没唤醒机器人**的群消息进来后：看看要不要把它捡成"接话时机"。
   * 内核在管线跑完后调（有 wake 的消息不进来，避免被叫时同时主动插话）。
   */
  function consider(ev) {
    if (!proactiveEnabled()) return
    if (!ev?.isGroup) return
    const key = String(ev.chatKey ?? '')
    if (!key) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    if (isQuietTime()) { oppOf(key); return }
    if (busy(key)) return // 包括等待合批的唤醒，不能抢
    if (contPending(key)) return // 已经有续聊排队，别抢同一时刻
    const now = nowMs()
    const o = ensureWindow(key, now)
    if (!o) return
    const text = String(ev.text || '').trim()
    // 窗口里至少得有几条消息才按"话题"挑时机：单条孤零零的消息不接（冷场路径另算）
    const recent = (rings.get(key) || []).filter((m) => now - m.ts < Math.max(60000, num(cfg.reply.topicWindowMs, 600000) / 2))
    if (recent.length < Math.max(1, num(cfg.reply.topicMinMsgs, 3))) return
    const last = recent[recent.length - 1]
    // 纯表情/图/太短的：不按话题接（分值也会很低，这里先挡一道省计算）
    if (!text || last?.placeholderOnly || last?.short) return
    const { score, logit } = interestFor(ev)
    const threshold = thresholdForSensitivity(cfg.reply.sensitivity)
    log.debug(`[主动接话] ${key} 兴趣分 ${(score * 100).toFixed(0)}% / 门槛 ${(threshold * 100).toFixed(0)}%（logit ${logit.toFixed(2)}）`)
    if (score >= threshold) fire(key, gid, 'topic', score)
  }

  /** 冷场找话是否开启（关 = 只由入站消息驱动「话题合适时接话」，不再定时找话）。 */
  const silenceOn = () => cfg.reply.silenceEnabled !== false

  // ── 连续对话（2026-10-27）────────────────────────────────────
  // 只做一件事：真人叫过它、它也回过话之后，隔一会儿把**这期间的新消息**塞回模型再判一次
  // "要不要补一句"。判据不另起一套：续聊分 = sigmoid(主动接话那 9 个权重算出的 logit + bonus)。
  // 防"自己转"：只由真人唤醒登记；合成轮（proactive/continuation/welcome）不登记；
  //            一次链路默认只检查 1 次；且必须有人类新消息（requireNewMessage）。
  const cont = new Map()      // chatKey → { gid, armedAt, lastReplyAt, dueAt, chain, lastFireAt }
  const contFires = new Map() // chatKey → [ts…]（每群每小时续聊次数）

  /** 它上次回复之后，群里又有几条人类消息 */
  function humanMsgsSince(chatKey, since) {
    return (rings.get(chatKey) || []).filter((m) => m.ts > Number(since || 0))
  }

  /** 真人唤醒时登记一条"续聊链"（同一群再来一次就重置，不叠加） */
  function noteWake(ev) {
    const key = String(ev?.chatKey ?? '')
    if (!key || !ev?.isGroup) return
    if (!proactiveEnabled() || ev.notice || ev._scratch?.notice) return
    const kind = String(ev?.wake?.kind ?? '')
    if (!['at', 'quote', 'keyword', 'followup', 'monitor'].includes(kind)) return
    const gid = String(ev.groupId ?? key.replace(/^group:/, ''))
    if (!allowedGroups().has(gid)) return
    const t = timingOf(key)
    t.unanswered = 0
    t.resetAt = nowMs()
    schedule(key)
    if (cfg.reply.continuation.enabled) cont.set(key, { gid, armedAt: nowMs(), lastReplyAt: 0, dueAt: 0, chain: 0, lastFireAt: 0 })
  }

  /** 它真的发出了一条回复 → 从这一刻开始计时（主动/续聊/欢迎轮不参与） */
  function noteReplySent(chatKey, turnCtx) {
    const key = String(chatKey ?? '')
    const c = cont.get(key)
    if (!c) return
    if (['proactive', 'continuation', 'welcome'].includes(String(turnCtx?.wakeKind ?? ''))) return
    c.lastReplyAt = nowMs()
    if (c.chain < num(cfg.reply.continuation.maxPerChain, 1)) {
      c.dueAt = c.lastReplyAt + num(cfg.reply.continuation.delayMs, 120000)
    }
  }

  /** 该群是否有待执行的续聊（主动接话两条路径要避让，别同一时刻说两句） */
  function contPending(chatKey) {
    const c = cont.get(String(chatKey))
    return Boolean(c && c.dueAt > 0)
  }

  /** 到点检查：有人类新消息 + 续聊分够 → 起一轮；否则记日志、链结束 */
  function tickContinuation(now) {
    const cf = cfg.reply.continuation
    if (!cfg.reply.continuation.enabled) return
    if (isQuietTime()) {
      // A continuation is tied to a live human exchange, never a next-morning backlog.
      cont.clear()
      deferQuietOpportunities(now)
      return
    }
    for (const [key, c] of [...cont]) {
      if (now - c.armedAt > 10 * 60000) { cont.delete(key); continue } // 链活太久（唤醒 10 分钟后语境已变）
      if (!c.dueAt || now < c.dueAt) continue
      if (!allowedGroups().has(String(c.gid)) || busy(key)) continue
      if (c.chain >= num(cf.maxPerChain, 1)) { cont.delete(key); continue }
      const fires = (contFires.get(key) || []).filter((t) => now - t < HOUR)
      contFires.set(key, fires)
      if (fires.length >= num(cf.hourlyMax, 5)) { cont.delete(key); continue }
      if (now - c.lastFireAt < num(cf.minGapMs, 300000)) continue
      const humans = humanMsgsSince(key, c.lastReplyAt)
      if (cf.requireNewMessage && humans.length === 0) {
        log.info(`[连续对话] ${key} 没人接话 → 不检查（链结束）`)
        cont.delete(key)
        continue
      }
      const last = humans[humans.length - 1]
      if (!last || last.placeholderOnly || last.short) {
        log.info(`[连续对话] ${key} 最后一条是媒体/太短 → 跳过`)
        cont.delete(key)
        continue
      }
      // 复用主动接话的权重：结构不变的 logit + 情境加分
      const { logit } = interestFor({ chatKey: key, isGroup: true, groupId: c.gid, text: last.text, mentionedSelf: last.mentionBot })
      const p = 1 / (1 + Math.exp(-(logit + num(cf.bonus, 1.5))))
      const threshold = thresholdForSensitivity(cfg.reply.sensitivity)
      if (p < threshold) {
        log.info(`[连续对话] ${key} 续聊分 ${(p * 100).toFixed(0)}% < 门槛 ${(threshold * 100).toFixed(0)}% → 跳过`)
        cont.delete(key)
        continue
      }
      c.chain += 1
      c.lastFireAt = now
      fires.push(now)
      // 「引用最后一条人类消息」：只有开关打开、且这条消息有 id 时才带
      const quoteTo = cf.quoteLastHuman ? (last.id ?? null) : null
      log.info(`[连续对话] ${key} 起念（续聊分 ${(p * 100).toFixed(0)}%，新消息 ${humans.length} 条，第 ${c.chain}/${num(cf.maxPerChain, 1)} 次${quoteTo ? '，引用 ' + quoteTo : ''}）`)
      if (typeof onProactiveTurn === 'function') {
        Promise.resolve()
          .then(() => {
            if (isQuietTime()) return
            return onProactiveTurn({ chatKey: key, groupId: c.gid, isGroup: true, userId: null,
              silenceMs: Math.max(0, now - Number(state.get(key).lastInboundAt || 0)), unanswered: 0,
              reason: 'continuation', score: p, humanMsgs: humans.length, quoteTo })
          })
          .catch((e) => log.error(`[连续对话] 起回合失败 ${key}: ${e.stack || e.message}`))
      }
      // 默认只检查一次：起过就结束；要再续必须等新的真人唤醒
      if (c.chain >= num(cf.maxPerChain, 1)) cont.delete(key)
      else c.dueAt = now + num(cf.delayMs, 120000)
    }
  }

  /** 冷场：到点了、群又安静够久 → 直接起一轮"找话"（不等消息） */
  function tickSilence(now) {
    if (!proactiveEnabled() || !onProactiveTurn) return
    if (isQuietTime()) {
      for (const gid of allowedGroups()) oppOf(`group:${gid}`)
      deferQuietOpportunities(now)
      return
    }
    const targets = [
      ...[...allowedGroups()].map((id) => [`group:${id}`, id]),
      ...allowedPrivateIds().map((id) => [`private:${id}`, id]),
    ]
    for (const [key, id] of targets) {
      const privateChat = isPrivate(key)
      if (!privateChat && now - Number(state.get(key).lastInboundAt || 0)
        < Math.max(60000, num(cfg.reply.topicWindowMs, 600000))) continue
      if (busy(key) || contPending(key)) continue // 等待槽/续聊均先让路
      const o = ensureWindow(key, now)
      if (!o) continue
      o.windowUntil = now // 立即用掉窗口，避免下个 tick 重复
      fire(key, id, 'silence', 1)
    }
  }

  /** 定时器入口：冷场找话（可选）+ 连续对话（可选） */
  function tick() {
    const now = nowMs()
    deferQuietOpportunities(now)
    if (silenceOn()) tickSilence(now)
    tickContinuation(now)
  }

  /**
   * 装好回调并按需启动调度：**主动接话默认关**（`enabled:false`）时只记回调、不装定时器，
   * 免得"关着却每 30s 空跑一次"。配置热改成开启后 apply() 会重新 start。
   */
  function start(opts = {}) {
    if (typeof opts.onProactiveTurn === 'function') onProactiveTurn = opts.onProactiveTurn
    if (typeof opts.isBusy === 'function') isBusy = opts.isBusy
    if (timer) clearInterval(timer)
    timer = null
    if (!proactiveEnabled()) return null
    deferQuietOpportunities(nowMs())
    // 冷场找话与连续对话都关掉时不需要定时器：接话机会只由入站消息触发（topic 路径）
    if (!silenceOn() && !cfg.reply.continuation.enabled) return null
    timer = setInterval(() => {
      try { tick() } catch (e) { log.error(`[主动接话] tick 异常: ${e.message}`) }
    }, 30000)
    timer.unref?.()
    return timer
  }

  function stop() {
    if (timer) clearInterval(timer)
    timer = null
    for (const slot of slots.values()) if (slot.timer) clearTimeout(slot.timer)
    slots.clear()
  }

  // ── 等待槽（合批/排队） ─────────────────────────────────────
  /**
   * 请求入站（唤醒消息才会进来）：
   *   · 私聊 = 合批：窗口内每条唤醒都并入并刷新计时（debounce），安静 waitMs 后一次入站；
   *   · 群聊 = 排队：唤醒消息各自独立成轮；窗口内又来唤醒 → 当前槽立即发车、新唤醒开新槽；
   *   · 机器人正在回复时：唤醒直接交给 serialize 排队（不合批、不等待）。
   * @param {object} ev 已唤醒事件（ev.wake 有值）
   * @param {(ev:object)=>Promise} run 真正执行的入口
   */
  function submit(ev, run) {
    const c = cfg.merge
    const kind = ev?.wake?.kind
    // 主动接话轮与入群欢迎轮是"系统自己发起的轮"，不和群友消息合批
    if (!c.enabled || !ev || kind === 'proactive' || kind === 'welcome') return run(ev)
    const key = String(ev.chatKey)
    if (isBusy(key)) {
      // 忙时不合批（直接排队）。但已经攒着等待槽的唤醒必须**先发车**再走这条，
      // 否则后到的唤醒会插队先入站（A 等 5 秒、B 立刻跑 → 回答顺序颠倒）。
      if (slots.has(key)) flush(key)
      return run(ev)
    }
    let slot = slots.get(key)
    if (slot && ev.isGroup) {
      // 群聊：唤醒消息独立成轮 —— 当前槽立即发车，这条另开新槽
      flush(key)
      slot = null
    }
    if (!slot) {
      slot = { evs: [], at: nowMs(), timer: null, run }
      slots.set(key, slot)
    }
    slot.evs.push(ev)
    slot.run = run
    if (slot.timer) clearTimeout(slot.timer)
    const wait = Math.max(0, num(c.waitMs, 5000))
    if (wait <= 0) {
      flush(key)
      return undefined
    }
    slot.timer = setTimeout(() => flush(key), wait)
    slot.timer.unref?.()
    return undefined
  }

  /**
   * 非唤醒消息：只并入已经打开的等待槽（合批），**永远不单独成轮**。
   * 没有槽就返回 false（这条只留在群上文里，不排队、不成轮）。
   */
  function collect(ev) {
    if (!cfg.merge.enabled || !ev) return false
    const slot = slots.get(String(ev.chatKey))
    if (!slot) return false
    slot.evs.push(ev)
    return true
  }

  /** 到点（或群聊被新唤醒顶掉）时把槽里的一批并成一条事件，交给最近一次提交的 run */
  function flush(key) {
    const slot = slots.get(String(key))
    if (!slot) return
    slots.delete(String(key))
    if (slot.timer) clearTimeout(slot.timer)
    const evs = slot.evs.filter(Boolean)
    const base = evs[0]
    if (!base) return
    if (!base._scratch || typeof base._scratch !== 'object') base._scratch = {}
    if (evs.length > 1) {
      // 正文 = 唤醒消息 + 后续各条 `[昵称(QQ:号)]: 内容`（正文留图占位，附件另收）
      const lines = evs.slice(1).map(mergedLine).filter(Boolean)
      base.text = [String(base.text || '').trim(), ...lines].filter(Boolean).join('\n')
      const hints = []
      for (const e of evs) for (const h of (e.hint || [])) if (!hints.includes(h)) hints.push(h)
      base.hint = hints
      // Snapshot before changing base: never retain a reference back to the event itself.
      // Loading and final attachment-number/source hints belong to the kernel loader.
      const selected = cfg.merge.loadImages === false ? [base] : evs
      const imageEvents = selected.map((e) => ({
        sender: { qq: e.sender?.qq ?? null, name: e.sender?.name || '', card: e.sender?.card || '' },
        messageId: e.messageId ?? null,
        images: (Array.isArray(e.images) ? e.images : []).map((image) => ({ ...image })),
        imageParts: [...(Array.isArray(e.imageParts) ? e.imageParts : [])],
        imagePaths: [...(Array.isArray(e.imagePaths) ? e.imagePaths : [])],
      }))
      base._scratch.mergedImageEvents = imageEvents
      base.images = imageEvents.flatMap((e) => e.images)
      const parts = []
      const paths = []
      const seenPaths = new Set()
      for (const e of imageEvents) {
        for (let i = 0; i < e.imageParts.length; i += 1) {
          const imagePath = e.imagePaths[i] || null
          if (imagePath && seenPaths.has(imagePath)) continue
          if (imagePath) seenPaths.add(imagePath)
          parts.push(e.imageParts[i])
          paths.push(imagePath)
        }
      }
      base.imageParts = parts
      base.imagePaths = paths
      const quoted = evs.map((e) => e._scratch?.quoteText).find(Boolean)
      if (quoted && !base._scratch.quoteText) base._scratch.quoteText = quoted
      // 混合成员合批不能借某一条主人的身份获得生图冷却豁免。
      base._scratch.mergedIsMaster = evs.every((e) => e.sender?.isMaster === true)
      if (base.turnCtx) base.turnCtx.isMaster = base._scratch.mergedIsMaster
      base._scratch.mergedCount = evs.length
      log.info(`[合批] ${key} ${evs.length} 条 → 1 轮（等 ${Math.max(0, nowMs() - slot.at)}ms, ${base.isGroup ? '群聊' : '私聊'}）`)
    }
    // 合并进来的消息 id：群上文拉取要排除它们（否则同一句话出现两遍）
    base._scratch.mergedIds = evs.map((e) => e.messageId).filter((v) => v !== null && v !== undefined)
    Promise.resolve(slot.run(base)).catch((e) => log.error(`[合批] 执行失败 ${key}: ${e.stack || e.message}`))
  }

  // ── 配置 / 状态 ─────────────────────────────────────────────
  function apply(pacingCfg) {
    const previous = cfg
    cfg = normalize(pacingCfg)
    const changed = lastLogged && (JSON.stringify(previous.reply.interval) !== JSON.stringify(cfg.reply.interval)
      || JSON.stringify(previous.reply.quietHours) !== JSON.stringify(cfg.reply.quietHours))
    // 群集合变了：清掉不再允许的群的调度状态（防止旧群继续按旧间隔起念）
    const allow = allowedGroups()
    for (const key of [...opp.keys()]) {
      if (!allowed(key)) opp.delete(key)
    }
    for (const key of [...rings.keys()]) {
      if (!allow.has(key.replace(/^group:/, ''))) rings.delete(key)
    }
    for (const key of [...allowedGroups()].map((id) => `group:${id}`).concat(allowedPrivateIds().map((id) => `private:${id}`))) {
      if (changed) schedule(key)
      else oppOf(key)
    }
    deferQuietOpportunities(nowMs())
    // 开关热更新：开了就装调度，关了就连定时器一起停（不空跑）
    if (proactiveEnabled() && !timer && onProactiveTurn) start()
    else if (!proactiveEnabled() && timer) { clearInterval(timer); timer = null }
    const r = cfg.reply
    // 同一份配置只打一行（启动时 apply + 控制台热改可能重复触发）
    const stamp = JSON.stringify([r, cfg.merge])
    if (stamp === lastLogged) return cfg
    lastLogged = stamp
    try {
      log.info(`节奏：主动接话=${r.enabled ? '开' : '关'}`
        + `（随机${Math.round(r.interval.minMs / 60000)}–${Math.round(r.interval.maxMs / 60000)}分钟，`
        + (silenceOn() ? '到点可冷场接话' : '只在群里有新消息时接')
        + `，敏感度${Math.round(clamp01(r.sensitivity) * 100)}%，群${Object.keys(r.groups).join('/') || '（无）'}）`
        + ` 合批=${cfg.merge.enabled ? `开（等 ${Math.round(num(cfg.merge.waitMs, 5000) / 1000)} 秒；私聊合并/群聊唤醒独立）` : '关'}`)
    } catch { /* 日志失败不影响配置生效 */ }
    return cfg
  }

  /** 主动接话总开关（控制台/内核用；关掉 = 连"要不要插一句"的念头都不起） */
  function proactiveEnabled() {
    return cfg.reply.enabled === true
  }

  /** 允许主动接话的群号列表（给内核开机播种"最后一条消息时间"用） */
  function allowedGroupIds() {
    return [...allowedGroups()]
  }

  /** 控制台状态：本小时用了几次 / 最近几次的去向（"已接 / 没发"） */
  function stats() {
    const now = nowMs()
    const hourAgo = now - HOUR
    const groups = [...allowedGroups()].map((gid) => {
      const key = `group:${gid}`
      const list = fired.filter((e) => e.chatKey === key && e.at > hourAgo)
      const last = [...fired].reverse().find((e) => e.chatKey === key)
      const o = opp.get(key)
      return {
        groupId: gid,
        used: list.length,
        chatKey: key,
        unanswered: timingOf(key).unanswered,
        silenceMs: privateSilence(key, now),
        lastAt: last ? last.at : null,
        lastSent: last ? !!last.sent : null,
        lastReason: last ? last.reason : null,
        lastScore: last ? last.score : null,
        nextAt: o && Number.isFinite(o.dueAt) ? o.dueAt : null,
      }
    })
    return {
      ok: true,
      enabled: proactiveEnabled(),
      quietHours: quietHoursStatus(cfg.reply.quietHours, now),
      interval: { ...cfg.reply.interval },
      sensitivity: clamp01(cfg.reply.sensitivity),
      threshold: thresholdForSensitivity(cfg.reply.sensitivity),
      // 连续对话：只在控制台"最近状态"里显示待执行/本小时次数（UI 只暴露 3 个可调项）
      continuation: {
        enabled: cfg.reply.continuation.enabled === true,
        threshold: thresholdForSensitivity(cfg.reply.sensitivity),
        pending: [...cont.keys()].length,
        firedThisHour: [...contFires.values()].reduce((n, list) => n + list.filter((t) => now - t < HOUR).length, 0),
      },
      groups,
      privateChats: allowedPrivateIds().map((userId) => {
        const chatKey = `private:${userId}`
        const timing = timingOf(chatKey)
        const last = [...fired].reverse().find((e) => e.chatKey === chatKey)
        return {
          userId, chatKey, unanswered: timing.unanswered,
          nextAt: timing.nextAt,
          silenceMs: privateSilence(chatKey, now), lastAt: last?.at ?? null, lastSent: last ? !!last.sent : null,
          lastReason: last?.reason ?? null, lastScore: last?.score ?? null,
        }
      }),
      recent: fired.slice(-8).reverse().map((e) => ({
        at: e.at, chatKey: e.chatKey, isGroup: e.isGroup, userId: e.userId, groupId: e.gid, reason: e.reason, sent: !!e.sent, score: e.score,
      })),
    }
  }

  return {
    apply, start, stop,
    noteInbound, noteOutbound,
    noteWake, noteReplySent, // 连续对话的两个钩子（内核在唤醒/出站时调）
    markProactiveSent: markSent,
    submit, collect, flush,
    consider,
    interestFor,
    proactiveEnabled, isQuietTime, allowedGroupIds, allowedPrivateIds, timingStateSnapshot,
    privateStateSnapshot: timingStateSnapshot, stats,
    nextOpportunityAt: (chatKey) => {
      const o = opp.get(String(chatKey))
      return o && Number.isFinite(o.dueAt) ? o.dueAt : null
    },
    tickNow: tick,
    get config() { return cfg },
  }
}
