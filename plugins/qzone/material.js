/**
 * material.js — 「当日素材」装配（qzone 插件内部模块，不是独立子插件）
 *
 * 为什么单独一层：写说说这件事的**输入**是「今天发生了什么」，而这件事散在三处：
 *   ① 聊天留档 `logs/qq_chat/{group|private}_<号>.jsonl`（当天所有消息，含机器人自己说的）
 *   ② 群记忆 `qq-memory/<群号>.md`（如果开了 group-memory，仅作摘要参考）
 *   ③ 空间里已经发过的说说（由 feed.js 另取）
 * 三处都不属于任何一个 DSH 会话 —— 这正是「会话记忆各自独立、它读不到一整天」的根因。
 * 本模块把它们合成**一篇人可读的 Markdown**：既喂给模型，也能被主人直接打开看。
 *
 * 三条纪律：
 *  ① 只读，不写聊天留档（留档归 group-memory 的车轮清理管，绝不在这里删）。
 *  ② 预算先给「最近」，超了从最早的开始丢 —— 越靠后越接近它此刻的心情。
 *  ③ 输出必须**人可读**（带时间、带昵称、带 QQ），排障时不用再猜模型看到了什么。
 */
import fs from 'node:fs'
import path from 'node:path'

/** 本地日期 YYYY-MM-DD（不用 toISOString：那是 UTC，会把晚上 8 点算成第二天） */
export function localDateOf(ms) {
  const d = new Date(Number(ms) || Date.now())
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return d.getFullYear() + '-' + mm + '-' + dd
}

/** 某个本地日期的 [start, end) 毫秒区间 */
export function dayRange(dateStr) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(dateStr || ''))
  if (!m) return { start: 0, end: 0 }
  const start = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 0, 0, 0, 0).getTime()
  return { start, end: start + 24 * 3600 * 1000 }
}

const hhmm = (ms) => {
  const d = new Date(ms)
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
}

const mmdd = (ms) => {
  const d = new Date(ms)
  return String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
}

/** 压成一行：换行/连续空白折叠，超长截断（正文里出现多行会把清单撑爆） */
const oneLine = (s, max) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > max ? t.slice(0, max) + '…' : t
}

const ARCHIVE_RE = /^(group|private)_(\d{4,12})\.jsonl(?:\.(\d+))?$/

/** 列留档文件（含轮转的 .1/.2 分片），按文件名分组：'group:123' → [文件名…] */
function listArchiveFiles(archiveDir) {
  let names = []
  try { names = fs.readdirSync(archiveDir) } catch { return new Map() }
  const byChat = new Map()
  for (const n of names) {
    const m = ARCHIVE_RE.exec(n)
    if (!m) continue
    const key = m[1] + ':' + m[2]
    if (!byChat.has(key)) byChat.set(key, [])
    byChat.get(key).push(n)
  }
  return byChat
}

/** 读一份留档里落在 [start,end) 的消息（宽松解析：坏行跳过，绝不抛） */
function readRows(file, start, end) {
  let text = ''
  try { text = fs.readFileSync(file, 'utf8') } catch { return [] }
  const out = []
  for (const line of text.split('\n')) {
    const s = line.trim()
    if (!s) continue
    let row
    try { row = JSON.parse(s) } catch { continue }
    const ts = Number(row?.ts) || 0
    if (!ts || ts < start || ts >= end) continue
    const msg = oneLine(row?.text, 300)
    if (!msg) continue
    if (/^\[CQ:[^\]]+\]$/.test(msg)) continue // 纯图片/表情占位不占素材预算
    out.push({
      ts,
      out: row?.dir === 'out',
      who: String(row?.sender?.card || row?.sender?.name || '').trim(),
      qq: String(row?.sender?.qq ?? '').trim(),
      text: msg,
    })
  }
  return out
}

/** 一行一条：`[21:03] 昵称(QQ)：…`；机器人自己的用 → 前缀；跨天时带上日期 */
function renderLine(r, withDate) {
  const name = r.who && r.qq ? r.who + '(' + r.qq + ')' : (r.who || r.qq || '未知')
  const stamp = withDate ? mmdd(r.ts) + ' ' + hhmm(r.ts) : hhmm(r.ts)
  return (r.out ? '→' : '') + '[' + stamp + '] ' + (r.out ? '你' : name) + '：' + r.text
}

/** 从末尾按字符预算保留（越新越优先），返回 { lines, dropped } */
function tailByChars(rows, budget, withDate) {
  const lines = []
  let used = 0
  let dropped = 0
  for (let i = rows.length - 1; i >= 0; i -= 1) {
    const line = renderLine(rows[i], withDate)
    const size = line.length + 1
    if (lines.length && used + size > budget) { dropped = i + 1; break }
    used += size
    lines.push(line)
  }
  lines.reverse()
  return { lines, dropped, used }
}

/**
 * 群记忆摘录。
 * ⚠️ 记忆可能是**很久以前**积累的（group-memory 关着就不会再更新）：
 * 2026-10-28 的素材里混进过 10-23 的旧记忆，读起来像“今天发生的事”，那是错的。
 * 所以这里按文件 mtime 判新旧：超过 memoryMaxAgeDays 天就整段不要，宁可少一段。
 * @returns {{text:string, skipped:string, ageDays:number}}
 */
function memoryExcerpt(memoryDir, chatKey, maxChars, maxAgeDays) {
  const m = /^(group|private):(\d{4,12})$/.exec(chatKey)
  if (!m || m[1] !== 'group') return { text: '', skipped: '', ageDays: 0 }
  const file = path.join(memoryDir, m[2] + '.md')
  let text = ''
  let mtime = 0
  try {
    text = fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')
    mtime = fs.statSync(file).mtimeMs
  } catch { return { text: '', skipped: '', ageDays: 0 } }
  const t = text.trim()
  if (!t) return { text: '', skipped: '', ageDays: 0 }
  const ageDays = Math.floor((Date.now() - mtime) / (24 * 3600 * 1000))
  if (maxAgeDays > 0 && ageDays > maxAgeDays) {
    return { text: '', skipped: '记忆最后更新于 ' + ageDays + ' 天前，太旧，已略过', ageDays }
  }
  const body = t.length > maxChars ? t.slice(0, maxChars) + '\n…（记忆过长，已截断）' : t
  return { text: body, skipped: '', ageDays }
}

/**
 * 装配当天素材。
 * @returns {{date:string, text:string, stats:object, file:string}}
 */
export function buildDailyMaterial({
  archiveDir, memoryDir, workspaceDir, date,
  msgPerChat = 400, perChatChars = 8000, totalChars = 60000, memoryChars = 1200, includePrivate = true,
  onlyChatKey = '', days = 1, memoryMaxAgeDays = 0,
} = {}) {
  const day = String(date || localDateOf(Date.now()))
  const today = dayRange(day)
  const span = Math.max(1, Math.min(14, Math.round(Number(days) || 1)))
  // 往回看 span 天（默认只今天）：宁可少喂，也别把上周的旧事当今天的经历
  const start = today.start - (span - 1) * 24 * 3600 * 1000
  const end = today.end
  const memMaxAge = Math.max(0, Number(memoryMaxAgeDays) || 0)
  const byChat = listArchiveFiles(String(archiveDir || ''))
  const chats = []
  const only = String(onlyChatKey || '').trim()
  for (const [chatKey, files] of byChat) {
    if (only && chatKey !== only) continue // 只写某一个群："/空间 群聊" 用
    if (!includePrivate && chatKey.startsWith('private:')) continue
    let rows = []
    for (const f of files) rows = rows.concat(readRows(path.join(String(archiveDir), f), start, end))
    if (!rows.length) continue
    rows.sort((a, b) => a.ts - b.ts)
    chats.push({ chatKey, rows: rows.slice(-msgPerChat), total: rows.length })
  }
  chats.sort((a, b) => b.total - a.total)

  // 预算：先按每会话上限，再按当天总上限收口（每会话额度 = 总预算 / 会话数）
  const perChat = Math.max(500, Math.min(perChatChars, Math.floor(totalChars / Math.max(1, chats.length))))
  const sections = []
  let messages = 0
  let droppedTotal = 0
  for (const c of chats) {
    const { lines, dropped } = tailByChars(c.rows, perChat, span > 1)
    messages += lines.length
    droppedTotal += dropped + Math.max(0, c.total - c.rows.length)
    const m = /^(group|private):(\d{4,12})$/.exec(c.chatKey)
    const kind = m && m[1] === 'private' ? '私聊 ' : '群 '
    const num = m ? m[2] : c.chatKey
    const first = c.rows.length ? c.rows[0].ts : 0
    const last = c.rows.length ? c.rows[c.rows.length - 1].ts : 0
    const timeSpan = c.rows.length
      ? ((span > 1 ? mmdd(first) + ' ' : '') + hhmm(first) + '–' + (span > 1 ? mmdd(last) + ' ' : '') + hhmm(last))
      : '-'
    const head = '## ' + kind + num + '（' + (span > 1 ? '最近 ' + span + ' 天 ' : '今天 ') + c.total + ' 条，' + timeSpan + '）'
    const mem = memoryExcerpt(String(memoryDir || ''), c.chatKey, memoryChars, memMaxAge || span)
    const body = [head]
    if (mem.text) body.push('', '**群记忆摘要**（最后更新 ' + (mem.ageDays <= 0 ? '今天' : mem.ageDays + ' 天前') + '）', mem.text)
    else if (mem.skipped) body.push('', '（' + mem.skipped + '）')
    if (dropped) body.push('', '（更早的 ' + dropped + ' 条已省略）')
    body.push('', lines.join('\n'))
    sections.push(body.join('\n'))
  }

  const scopeText = only ? '（只看 ' + only + ' 这一段）' : ''
  const rangeText = span > 1 ? '最近 ' + span + ' 天' : '今天'
  const header = [
    '# ' + day + ' · ' + rangeText + '的经历' + scopeText,
    '',
    '共 ' + chats.length + ' 个会话、' + messages + ' 条消息' + (droppedTotal ? '（已省略 ' + droppedTotal + ' 条较早的）' : '') + '。',
    '格式：`[' + (span > 1 ? '日期 时间' : '时间') + '] 昵称(QQ)：内容`；行首 `→` 是**你自己**说的话。',
  ].join('\n')
  const emptyText = only ? '（这一段' + rangeText + '没有任何人说话。）' : '（' + rangeText + '没有任何人说话。）'
  const text = chats.length ? header + '\n\n' + sections.join('\n\n') : header + '\n\n' + emptyText

  // 落地一份供人查看（也是排障时「模型到底看到了什么」的唯一答案）
  let file = ''
  try {
    const dir = path.join(String(workspaceDir || '.'), 'qzone-desk')
    fs.mkdirSync(dir, { recursive: true })
    file = path.join(dir, day + '.md')
    fs.writeFileSync(file, text + '\n')
  } catch { file = '' }

  return {
    date: day,
    text,
    file,
    stats: { chats: chats.length, messages, chars: text.length, dropped: droppedTotal, days: span },
  }
}