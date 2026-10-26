/**
 * stickers — 表情包子插件（id: 'stickers'，order: 80）
 *
 * 存储核心在 `./shelf.js`（自己写的：索引读写 / 哈希去重 / 大小闸 / 挑图 / 清单），
 * 本文件只做三件事：① QQ 入站采集；② GIF 按魔数过滤；③ 提醒/工具/失败降级。
 * （2026-10-26 起不再随包携带第三方 vendor；打标/黑名单/画面描述这些用不上的能力一并删了。）
 *
 * 四条纪律（旧代码注释与事故记录，别改）：
 *  ① **判据只看协议字段**：`emoji_id` 有值 或 `sub_type != 0`；**绝不看 summary 字符串** ——
 *     实测有真人照片/截图带 `[文件名]` 式 summary，靠字符串猜会把照片灌进表情库（手册 §21.1）。
 *  ② **单写者**：index.json 只由本插件**进程内这一条串行队列**写（采集/打标/删条目/记使用全排队）。
 *     旧实现靠"人工冻结采集 → 注入 → 再恢复"才没打架（§21.8 双实例实测整份覆盖、日志无痕）——
 *     这次从结构上根治：本文件不存在第二条写索引的路，外部脚本也不该再写它。
 *  ③ **挑不到就明说，不硬塞**：点名 `#N` 没找到 → 如实返回"没合适的"；关键词没命中才随便给一张。
 *  ④ **自我降级**：库初始化失败 / 取图失败 / 库满 → 只记日志，聊天一个字都不能受影响。
 */
import fs from 'node:fs'
import path from 'node:path'
import { cqImage } from '../../platform/cq-file.js'
import { createShelf, readIndex } from './shelf.js'

/** 是不是 GIF（GIF87a / GIF89a）。**按内容魔数判，不看扩展名** —— 扩展名改成 .jpg 也拦得住。 */
function isGif(buf) {
  if (!buf || buf.length < 6) return false
  const head = buf.subarray(0, 6).toString('latin1')
  return head === 'GIF87a' || head === 'GIF89a'
}

/**
 * 「这一段是不是一张表情」的**唯一判据**（采集与提示共用）。
 * 判据 = **协议字段**：`emoji_id` 有值 / `sub_type` 非 0（QQ 实测 1=动画表情、7/11=收藏表情类）。
 * 早先的实现只认 `sub_type === '1'`（字符串），7/11 会被静默滤掉 —— 所以判据按数值判。
 * **不看 summary 字符串**：真人照片/截图也带 `[文件名]` 式 summary，靠字符串猜会把照片灌进库。
 */
function isStickerSeg(seg) {
  const d = (seg && seg.data) || seg || {}
  if (d.emoji_id != null && String(d.emoji_id) !== '') return true
  const st = Number(d.sub_type ?? 0)
  return Number.isFinite(st) && st !== 0
}


/**
 * 串行队列 = **单写者**。index.json 整个库只有一份索引 → 队列必须**进程内唯一**
 * （放 ChatState.get(chatKey) 里会变成每群一条 → 又是并发写）。前一个失败不挡后一个。
 */
class AsyncQueue {
  #tail = Promise.resolve()
  push(fn) {
    const run = this.#tail.then(() => fn())
    this.#tail = run.catch(() => {})
    return run
  }
}


/** 元标签：描述的是"图源/场合大类"，不是情绪，拿它点名只会永远发同一张 → 不许用来匹配提示。 */
const META_TAGS = new Set(['群聊', '表情包', '二次元', '搞笑', '可爱', '梗图', '网络', '日常', '图片', '动画表情'])

/**
 * 最近发过的图（进程内，最多 30 个 id，最新在前）：只用于**避开重复**，不写索引。
 * 只读模式下 `uses/lastUsed` 不更新，没有这层轮换时"同一个词"会永远挑到同一张。
 */
const RECENT_SENT_MAX = 30

export default {
  id: 'stickers',
  title: '表情包',
  order: 80,

  configSchema: {
    enabled: { type: 'bool', default: true, group: '表情包', label: '表情包库（总开关）', hint: '开：回话时可以挑图发、控制台能看库；关：整个表情功能停用（连挑图发也不行）。收新图另看「收表情（会写索引）」。' },
    collect: {
      type: 'bool', default: false, group: '表情包', label: '收表情（会写索引）',
      hint: '**默认关**：库只读 —— 机器人照样能从现有表情里挑图发，但不收新图、不改 index.json（采集/打标/清理/记使用全停）。\n'
        + '打开后才会：把群里新出现表情写进库、更新索引、记录使用次数。\n'
        + '⚠️ 索引是插件内存里的副本，运行中改 index.json 会被写回覆盖（2026-10-20 标签全丢就是这原因）；'
        + '**收表情/改库前先停 dsh-web → 改 → 再启动**，或干脆保持这个开关关着。',
    },
    dir: { type: 'str', default: 'qq-stickers', group: '表情包', label: '库目录',
      hint: '相对路径由内核按数据目录解析；index.json 与图片都在这里。**只由本插件一条串行队列写**，别再让外部脚本写它' },
    max: { type: 'int', default: 200, min: 10, max: 2000, step: 10, group: '表情包', label: '库上限（张）',
      hint: '满了跳过新图（不淘汰旧的）；要换血就手动删几张' },
    // 不做自动打标：内核没有看图能力（bot.describeImage），索引也只记标签 —— 不加死开关。
    skipGif: { type: 'bool', default: true, group: '表情包', label: '跳过 GIF（只收静态图）',
      hint: '按内容魔数判（GIF87a/GIF89a），扩展名改成 .jpg 也拦得住；只挡新收的图' },
    collectGroupsOnly: { type: 'bool', default: true, group: '表情包', label: '只在群里收', hint: '开：只收群聊里的表情；关：私聊里的也收。' },
    offerPercent: { type: 'int', default: 80, min: 0, max: 100, step: 1, unit: '%', group: '表情包', label: '主动想起概率',
      hint: '每轮"提醒它可以发一张"的概率（0=关）；它仍可拒绝 → 实际发出率会低于这个数' },
    offerCooldownMs: { type: 'int', default: 20, min: 0, max: 3600, step: 1, unit: '秒', scale: 1000, group: '表情包', label: '想起冷却',
      hint: '同一会话两次"提醒发表情"的最小间隔' },
    maxPerTurn: { type: 'int', default: 1, min: 1, max: 5, step: 1, group: '表情包', label: '每轮最多几张', hint: '一轮回话最多发几张表情（1 张最自然）。' },
  },

  setup(bot) {
    const cfg = bot.cfg || {}
    const log = bot.log
    const dir = String(cfg.dir || '').trim() || path.join(String(bot.core?.dataDir || '.'), 'qq-stickers')
    // 单位口径（与 admin-bridge 一致）：schema 写 unit:'秒' + scale:1000 ⇒ 配置存**人话单位（秒）**，
    // 用的时候乘回毫秒。全文件只有这一处换算 —— 内核若改成存毫秒，只改这一行。
    const cooldownMs = () => Math.max(0, Number(cfg.offerCooldownMs) || 0) * 1000
    const maxPerTurn = () => Math.max(1, Number(cfg.maxPerTurn) || 1)
    // 「收表情（会写索引）」：默认关 → 库只读。关着时**任何**写索引的路径都不跑
    //（采集 / 打标 / 清理手删条目 / 挑图时记 uses），只保留读：挑图、清单、统计。
    const collectOn = () => cfg.collect === true

    // 单写者队列。挂到 bot.state 上只是让内核/自检能看见并 await 它；队列本身进程内唯一。
    const queue = new AsyncQueue()
    if (bot.state && typeof bot.state === 'object') bot.state.stickersQueue = queue

    let prunedAt = 0
    const offerAt = new Map() // chatKey -> 上次提醒时间（丢了也只会早提醒一次，不值得进 ChatState）

    // 存储核心（自己的实现，见 ./shelf.js）。单写者 = 本插件那条串行队列。
    const shelf = createShelf({
      dir,
      maxItems: Math.max(1, Number(cfg.max) || 200),
      maxBytes: 2 * 1024 * 1024, // 单张 ≤2MB（表情常见 1~2MB）
      minBytes: 1024, // 挡掉 icon 那种几十字节的垃圾
      log: (...a) => log.info('[表情] ' + a.join(' ')),
    })

    /**
     * 取图字节：① 段里的 file 是现成本地文件就直接读；② 原始 url 直链兜底。
     * 旧实现第二级是 `napcat.get_file` 溯源（老引用图只有 file 哈希名）；新适配器没暴露 getFile
     * （契约只有 groupHistory/memberInfo/recall/fetchAvatar）→ 老图收不到。passive-tap 本来就只收
     * 当轮新消息（url 新鲜），不为这点在适配器上开洞；失败就跳过这一张。
     */
    async function fetchBytes(file, url) {
      const tried = []
      const local = String(file || '')
      if (local && fs.existsSync(local)) {
        try { if (fs.statSync(local).isFile()) return fs.readFileSync(local) } catch (e) { tried.push(`本地读取失败 ${e.message}`) }
      }
      if (local && !/^https?:\/\//.test(local) && typeof bot.napcat?.getFile === 'function') {
        try {
          const info = await bot.napcat.getFile(local)
          if (info?.file && fs.existsSync(info.file) && fs.statSync(info.file).isFile()) return fs.readFileSync(info.file)
          if (info?.url && /^https?:\/\//.test(info.url)) {
            const r = await fetch(info.url, { signal: AbortSignal.timeout(15000) })
            if (r.ok) return Buffer.from(await r.arrayBuffer())
            tried.push(`溯源直链 HTTP ${r.status}`)
          }
        } catch (e) { tried.push(`get_file ${e.message}`) }
      }
      const link = /^https?:\/\//.test(String(url || '')) ? url : (/^https?:\/\//.test(local) ? local : '')
      if (link) {
        const res = await fetch(link, { signal: AbortSignal.timeout(15000) })
        if (res.ok) return Buffer.from(await res.arrayBuffer())
        tried.push(`直链 HTTP ${res.status}`)
      }
      throw new Error(tried.join(' / ') || '没有可用的图片来源')
    }

    /** 采集一批表情段（已在队列里跑）。 */
    async function harvest(segs, ev) {
      const nick = String(ev.sender?.name || ev.sender?.card || '')
      let gifSkipped = 0 // 我们自己挡掉的 gif（shelf 只回总数，扣掉它免得"有表情没入库"重复报一遍）
      const r = await shelf.harvest(segs, { nick, uid: String(ev.sender?.qq ?? '') }, async (seg) => {
        const d = (seg && seg.data) || {}
        const bytes = await fetchBytes(d.file, d.url)
        // 返回 null = 按「跳过」计数（不写索引、不报警告、不算错）
        if (cfg.skipGif !== false && isGif(bytes)) { log.debug('[表情] 跳过 gif（设置了不收动图）'); gifSkipped++; return null }
        return bytes
      })
      if (!r.added && !r.seen) {
        // 静默丢弃路径要留声（旧实现踩过：sub_type 7/11 被滤掉、日志一个字都没有）
        const other = r.skipped - gifSkipped
        if (other > 0) log.debug(`[表情] 有表情但没入库：跳过 ${other} 张（取字节失败 / 超出 1KB~2MB 闸 / 格式不认识）`)
        return
      }
      log.info(`[表情] 入库 +${r.added}（已有 ${r.seen}，跳过 ${r.skipped}）${nick ? ' ← ' + nick : ''}`)
    }

    /**
     * 清理「文件被手删」的条目（节流 60s）。索引不查文件是否存在，
     * 留着条目就可能挑中一个磁盘上已经没有的路径 → 挑图会报"没合适的"。
     */
    async function pruneLocked(s = shelf) {
      if (!collectOn()) return // 清理=删条目+写索引，只读模式下跳过（条目先留着，不影响挑图）
      const now = Date.now()
      if (now - prunedAt < 60000) return
      prunedAt = now
      const gone = readIndex(dir).items.filter((i) => i.file && !fs.existsSync(path.join(dir, i.file)))
      for (const it of gone) s.remove(it.id)
      if (gone.length) log.info(`[表情] 清理 ${gone.length} 条「文件已被手删」的索引条目：#${gone.map((i) => i.id).join(' #')}`)
    }

    /** 把索引条目变成挑图结果（只读；写 uses/lastUsed 由 shelf.recordUse 负责）。 */
    // 索引只存标签（没有 desc/use 了）→ 挑图结果也只带标签，别再透传空字段
    const hitOf = (it, p) => ({ id: it.id, file: it.file, path: p, tags: it.tags || [], untagged: !it.tagged })

    // 最近发过的 id（最新在前）。只影响"挑哪张"，不影响点名 `#N`（点名要严格听模型的）。
    const recentSent = []
    const noteSent = (id) => {
      const n = Number(id)
      if (!Number.isFinite(n)) return
      const at = recentSent.indexOf(n)
      if (at >= 0) recentSent.splice(at, 1)
      recentSent.unshift(n)
      if (recentSent.length > RECENT_SENT_MAX) recentSent.length = RECENT_SENT_MAX
    }
    /** 把最近发过的排到后面（全都发过就保持原样 —— 库小的时候只能重复）。 */
    const preferFresh = (list) => {
      const fresh = list.filter((it) => !recentSent.includes(it.id))
      return fresh.length ? fresh : list
    }

    /** 点名 `#N`：只认库里真有的那张，没找到就 null（**绝不换一张别的** —— 严格性是踩坑换来的）。 */
    function pickById(s, q, readOnly = false) {
      const n = Number(String(q).replace(/^#/, '')) // ⚠️ 必须剥 #：Number('#3') 是 NaN
      if (!Number.isFinite(n)) return null
      const it = readIndex(dir).items.find((x) => x.id === n)
      if (!it || it.blocked || !it.file) return null
      const p = path.join(dir, it.file)
      if (!fs.existsSync(p)) return null
      if (!readOnly) s.recordUse(it.id) // 可写模式：记一次使用（uses/lastUsed）
      return hitOf(it, p)
    }

    /**
     * 只读关键词挑图：与 `shelf.resolve(词)` 的匹配规则一致（只按标签），但**不写 uses/lastUsed**、不落盘。
     * 只在「收表情（会写索引）」关着时用 —— 索引是只读的，绝不能在挑图这步把内存副本写回去。
     */
    function pickByKeywordReadOnly(q) {
      const usable = readIndex(dir).items.filter((i) => !i.blocked && i.file)
      if (!usable.length) return null
      let pool = usable.filter((i) => (i.tags || []).includes(q)) // 只有标签，没有 desc/use 可匹配
      if (!pool.length) pool = q.length <= 1 ? usable : []
      if (!pool.length) return null
      // 只读模式没有 uses/lastUsed 可依据 → 用进程内"最近发过"做轮换，避免同一个词永远一张
      const fresh = preferFresh(pool)
      const it = fresh[Math.floor(Math.random() * fresh.length)]
      const p = path.join(dir, it.file)
      if (!fs.existsSync(p)) return null
      return hitOf(it, p)
    }

    /**
     * 随便挑一张**可用**的（真随机，不防重复 —— 表情包重复用也是一种聊天方法）。
     * 池子包含"刚收未打标"的图：shelf 的清单只列打过标签的，全靠它挑会永远只用旧图（旧实现真踩过）。
     */
    function pickRandom(s, readOnly = false) {
      const usable = readIndex(dir).items.filter((i) => !i.blocked && i.file)
      if (!usable.length) return null
      const fresh = preferFresh(usable) // 随机也避开刚发过的那几张（库里只有几张时自动退化成纯随机）
      const it = fresh[Math.floor(Math.random() * fresh.length)]
      const p = path.join(dir, it.file)
      if (!fs.existsSync(p)) return null // 手删的（prune 通常已清掉，这里只挡竞态）
      if (!readOnly) s.recordUse(it.id) // 可写模式：记一次使用
      return hitOf(it, p)
    }

    /** 挑一张（在队列里跑）。关键词没命中 → 随便给一张；点名没找到 → 如实说没合适的。 */
    async function pickLocked(s, query) {
      const readOnly = !collectOn()
      if (!readOnly) await pruneLocked(s) // 清理=写索引；只读模式不跑
      const q = String(query || '').trim()
      const pointed = /^#?\d{1,4}$/.test(q) // `#12` / `12` = 点名
      const wantsRandom = !q || q === '随机' || q === '随便'
      let hit = pointed || wantsRandom ? null
        : (readOnly ? pickByKeywordReadOnly(q) : s.resolve(q)) // 关键词只在"打过标"的池里找
      if ((!hit || !hit.path) && pointed) hit = pickById(s, q, readOnly)
      if ((!hit || !hit.path) && !pointed) hit = pickRandom(s, readOnly)
      if (!hit || !hit.path) return { ok: false, reason: '没合适的' }
      return { ok: true, id: hit.id, path: hit.path, untagged: !!hit.untagged, tags: hit.tags || [] }
    }

    /** 清单（模型主动问时才给）：刚收未打标的排最前，后面接 shelf 那份（旧图照旧）。 */
    async function catalogLocked(s, limit) {
      const lim = Number(limit) || 30
      await pruneLocked(s)
      const fresh = readIndex(dir).items
        .filter((i) => !i.blocked && i.file && !i.tagged)
        .sort((a, b) => (b.ts || 0) - (a.ts || 0))
        .slice(0, Math.max(1, Math.round(lim / 3)))
        .map((i) => `#${i.id} （刚收的，还没打标 · 可当语气图随便用）`)
      const body = s.catalog(lim) || ''
      return fresh.concat(body ? [body] : []).join('\n')
    }

    /** 随机池大小（只读盘，不排队）：掷骰前置判断"挑得到才提示"。 */
    const pickableCount = () => readIndex(dir).items.filter((i) => !i.blocked && i.file).length

    /** 控制台「表情包」页顶部那行实时概况（数量随时变 → 由这里现算，不写进 schema 静态文字）。 */
    bot.shared.stickerStats = () => {
      // 数量必须和磁盘对得上：只算文件真实存在的条目（手删图片后控制台立刻少一张）
      const all = readIndex(dir).items.filter((i) => !i.blocked && i.file)
      const items = all.filter((i) => fs.existsSync(path.join(dir, i.file)))
      const dead = all.length - items.length
      const tagged = items.filter((i) => i.tagged)
      const tags = new Set()
      for (const it of tagged) for (const t of (Array.isArray(it.tags) ? it.tags : [])) tags.add(String(t || '').trim())
      tags.delete('')
      return {
        ok: true,
        dir,
        count: items.length,
        tagged: tagged.length,
        tags: tags.size,
        dead, // 索引里有、磁盘上已没了的条目数（只读模式不会自动清）
        collect: collectOn(),
        max: Math.max(1, Number(cfg.max) || 200),
      }
    }

    /** 从上下文里找一个能对上的表情标签（给"主动想起"的提示用；找不到返回 ''） */
    function matchContextTag(ev) {
      // 只拿**真实聊天内容**匹配：先剥掉内核注入的脚手架行（`[群聊上文]`、`[群历史: …]`）。
      // 不剥的话「[群聊上文]」里的「群聊」会命中库里带「群聊」标签的那张，
      // 于是每轮提示都是同一个词、永远发同一张图（2026-10-26 实测 58/64 次点名「群聊」）。
      const strip = (t) => String(t || '').replace(/^\s*\[(?:群聊上文|群历史)[^\]]*\]\s*$/gm, '')
      let ctx = strip(ev?.text)
      if (ev?.historyBlock) ctx += '\n' + strip(ev.historyBlock)
      if (!ctx.trim()) return ''
      let items = []
      try { items = readIndex(dir).items } catch { return '' }
      const hit = new Set()
      for (const it of items) {
        if (!it || it.blocked || !it.file) continue
        for (const t of (Array.isArray(it.tags) ? it.tags : [])) {
          const w = String(t || '').trim()
          if (w.length < 2 || META_TAGS.has(w)) continue // 元标签/单字：没有区分度，不许点名
          if (ctx.includes(w)) hit.add(w)
        }
      }
      if (!hit.size) return ''
      // 取**最长**的那个（更具体：「阴阳怪气」优于「好用」），同长度取字典序靠前的，结果稳定
      return [...hit].sort((a, b) => b.length - a.length || a.localeCompare(b))[0]
    }

    /** 挑图（工具与自检共用；所有触碰索引的动作都走这条队列）。 */
    async function pick(query) {
      if (cfg.enabled === false) return { ok: false, reason: '表情库没开' }
      return queue.push(async () => {
        try { return await pickLocked(shelf, query) } catch (e) {
          log.warn(`[表情] 挑图失败: ${e.message}`)
          return { ok: false, reason: '挑图出错' }
        }
      })
    }

    // ── 入口 ①：旁路采集（fire-and-forget，任何异常只记日志） ──────────────────
    bot.on('passive-tap', (ev) => {
      if (cfg.enabled === false) return
      if (!collectOn()) return // 收表情开关关着 = 库只读：不采集、不写索引（控制台「表情包 → 收表情」）
      if (cfg.collectGroupsOnly !== false && !ev.isGroup) return
      // 直接从**原始段**读协议字段：这条判据是我们自己钉的，不借道适配器算好的 ev.images[].isSticker（防它改宽）
      const segs = (ev.rawSegments || []).filter((s) => s && s.type === 'image' && isStickerSeg(s))
      if (!segs.length) return
      queue.push(() => harvest(segs, ev)).catch((e) => log.warn(`[表情] 采集失败（不影响聊天）: ${e.message}`))
    })

    // ── 入口 ②：主动想起（内核管概率、模型管语境、本插件管挑图） ───────────────
    // 命中只往 hint 加一行短标记；发不发、发什么由模型定 —— 内核不懂语境，绝不替它直发。
    // 前置（任一不满足就不掷、零成本）：库开着 / 概率>0 / 只在群聊（旧实现 offerGroupsOnly 默认 true）/
    //  冷却已过 / 库里有可挑的图。
    bot.on('before-turn', (ev) => {
      if (cfg.enabled === false || !ev.wake) return // 没唤醒的消息不该掷骰（也别白推进冷却）
      if (ev.wake.kind === 'welcome') return // 入群欢迎轮只发欢迎语，别塞"发表情包"提醒分心
      const pct = Number(cfg.offerPercent) || 0
      if (!(pct > 0) || !ev.isGroup) return // 私聊不主动提醒（想发时仍可自己调工具）
      const now = Date.now()
      const cd = cooldownMs()
      if (cd > 0 && now - (offerAt.get(ev.chatKey) || 0) < cd) return
      const pool = pickableCount()
      if (!(pool > 0) || Math.random() * 100 >= pct) return // 挑得到才提示（免得模型白跑一趟）
      offerAt.set(ev.chatKey, now)
      // 结合语境：能从最近聊天里对上一个标签就点名，比"随便发一张"更容易被用上
      const tag = matchContextTag(ev)
      // 记进本轮上下文：send_message 的返回里会再轻推一句（模型更容易顺手带上）
      ev._scratch.turnExtras = { ...(ev._scratch.turnExtras || {}), stickerOffer: { tag: tag || '' } }
      // 提示要"顺手"，但**不能写成唯一答案**：句式轮换 + 明确许可自选词，
      // 否则模型会把同一句照抄 40 多次、每轮都发同一张（2026-10-26 实测）。
      const lead = tag
        ? [
          `[表情:这轮可以顺手带一张「${tag}」的 —— 发正文时给 send_message 加 sticker:"${tag}" 就行]`,
          `[表情:这轮想配图的话，「${tag}」那张挺合适（send_message 加 sticker:"${tag}"）]`,
          `[表情:要是想配个表情，「${tag}」这个词对得上（sticker:"${tag}"，也可以按你此刻的心情自己换个词）]`,
        ]
        : [
          '[表情:这轮可以顺手带一张 —— send_message 加 sticker:"随便挑"，或按当下心情自己给个词]',
          '[表情:想配图的话，库里随便挑一张就行（sticker:"随便挑"；也可以自己给个词）]',
          '[表情:这轮要不要带张表情？sticker:"随便挑" 或你喜欢的词都行]',
        ]
      ev.hint.push(lead[Math.floor(Math.random() * lead.length)])
      log.info(`[表情包] 掷骰命中 (${ev.chatKey}, p=${pct}%, 可挑 ${pool} 张${tag ? `, 语境标签=${tag}` : ''}) → 本轮提示「可以发一张」`)
    })

    // ── 入口 ③：工具 send_sticker（一轮最多 maxPerTurn 张；target 取当前 TurnContext，不信模型传） ──
    /**
     * 发一张表情包（本插件唯一的发送实现）：工具 send_sticker 与内核 send_message 的 sticker 参数都走这里。
     * target 只认会话键；每轮上限 / 主动接话条数上限都在这里判，避免两套计数。
     */
    async function sendStickerTo(target, query = '', turnCtx = null) {
      if (!/^(group|private):\d{1,12}$/.test(String(target || ''))) return { ok: false, reason: `target 格式不对: ${target}` }
      const turn = turnCtx || bot.currentTurn(target)
      const cap = maxPerTurn()
      if ((turn?.stickersSent || 0) >= cap) return { ok: false, reason: `这轮已经发过 ${turn.stickersSent} 张了（每轮上限 ${cap}）` }
      const hit = await pick(query)
      if (!hit.ok) return hit
      // 说明文字原样交给内核（脱敏 / CQ 转义是 sendMedia → deliver 的事，插件不写第二份）
      await bot.sendMedia(target, cqImage(hit.path), '')
      if (turn) turn.stickersSent = (turn.stickersSent || 0) + 1
      noteSent(hit.id)
      log.info(`[表情] 发出 #${hit.id}${hit.untagged ? '(新收未打标)' : ''} → ${target} (${(hit.tags || []).join('/') || '无标注'})`)
      return { ok: true, target, pick: { id: hit.id, tags: hit.tags, untagged: hit.untagged } }
    }
    // 内核 send_message 的 sticker 参数通过这个共享槽拿到"挑图 + 发送"（插件没启用时就没人注册 → 内核如实报）
    bot.shared.stickerSend = ({ target, query, turnCtx }) => sendStickerTo(target, query, turnCtx)

    bot.registerTool('send_sticker', {
      description: '从群里攒下来的表情包库里挑一张发出去（库里的图都是群里真实发过的，带标签）。'
        + '表情包多数时候只是语气（敷衍/赞同/无语/看热闹）或图一乐 —— 想发就发，不必给它找理由。'
        + 'query 给心情/关键词（「无语」「夸人」「震惊」）或 `#12` 点名；什么都不给 = 真随机挑一张；同一张反复用没问题。'
        + '关键词没命中会随便给你一张；只有点名没找到才返回 ok:false —— 那时别改发别的图，也别在正文里解释。'
        + '提示里出现 `[表情:…]` 就发，不必贴合当下语境。'
        + '**最快的方式是不单独调本工具**：发正文时给 send_message 加 sticker:"关键词" 即可一并带出。一轮最多一张。',
      // DSH `defineTool` 的 parameters 是**扁平**的「属性名 → 值 schema」映射（不是 JSON Schema 的
      // `{type:'object',properties}`）；required 写在属性上 `required: true`。
      parameters: {
        query: { type: 'string', description: '关键词/心情（如「无语」「猫」「夸人」），或 `#12` 点名编号；不传 = 随便挑一张' },
        text: { type: 'string', description: '随图发的一句文字，一般不用给' },
      },
      async execute(args) {
        const turn = bot.currentTurn()
        const target = turn?.chatKey
        if (!target) return { ok: false, reason: '没有进行中的会话（send_sticker 只能在回话轮里用）' }
        return sendStickerTo(target, args?.query ?? args?.mood ?? '', turn)
      },
    })

    // ── 入口 ④：工具 sticker_catalog（先看看有什么，不占每轮 token） ─────────────
    bot.registerTool('sticker_catalog', {
      description: '列出库里可用表情包的清单（编号 · 标签/关键词）与库现状。'
        + '想先看看有什么再挑、或要按编号点名（send_sticker 传 query:"#12"）时用它；不用每轮都看。',
      parameters: {
        limit: { type: 'number', description: '最多列几条，默认 30' },
      },
      execute: async (args) => queue.push(async () => {
        try {
          await pruneLocked(shelf)
          return {
            ok: true,
            catalog: await catalogLocked(shelf, args?.limit),
            stats: { enabled: cfg.enabled !== false, dir, ok: true, ...shelf.stats(), pickable: pickableCount() },
          }
        } catch (e) {
          return { ok: true, catalog: '', stats: { enabled: cfg.enabled !== false, dir, ok: false, err: e.message } }
        }
      }),
    })
  },
}
