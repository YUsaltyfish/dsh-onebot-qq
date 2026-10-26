/**
 * shelf.js — 表情库的**唯一**存储实现（索引读写 / 入库 / 挑图 / 清单 / 统计）。
 *
 * 为什么自己写：2026-10-26 之前这里用的是随包携带的第三方 vendor
 * （`vendor/dsh-sticker-shelf.mjs`，MIT，JackZo400/dsh-sticker-library）。主人要求不携带别人的代码
 * → 按我们**实际用到**的部分重写。原 vendor 里这些一并去掉（本机从来没用上）：
 *   · 自动打标（tagPending / 看图的 describe 回调 / BLOCK 安全线）—— 内核没有看图能力，是死开关；
 *   · 删除黑名单（blocked-hashes.txt）—— 2026-10-26 已删；
 *   · adult / lowq / renumber / saveFiles / seenCount / lastSeen / desc / use。
 *
 * ## 数据结构
 *
 * `<dir>/index.json`（**紧凑 JSON，单行**）：
 *
 * ```json
 * {"items":[{"id":107,"hash":"9c8b4e611267ea95","file":"107-阴阳怪气-装凶-凶人.jpg",
 *            "tags":["阴阳怪气","装凶"],"tagged":true,"blocked":false,
 *            "uses":9,"lastUsed":1792941917653,"ts":1791819008196}],"nextId":242}
 * ```
 *
 * - `hash`：图片内容 sha1 的前 16 位 → **去重**就靠它（同一张图再被发进群只算"见过"，不重复存）；
 * - `file`：相对 `<dir>` 的文件名 `<id>-<hash>.<ext>` → 索引靠它定位真实图片（改名必须同步改这里）；
 * - `tags`：情绪/场合关键词（索引**只记标签**，不存画面描述）；
 * - `uses` / `lastUsed`：可写模式下挑图时更新（只读模式不写盘）；
 * - `blocked`：历史字段，目前不用（保留只为兼容旧索引里的值）。
 *
 * ## 单写者
 *
 * 本模块**不自己排队**：插件的 `AsyncQueue` 是唯一写入口（采集 / 挑图记使用 / 删条目都排在它里面）。
 * 每个写函数都是同步一次性调用，不并发。
 *
 * ## 读
 *
 * 读一律走 `readIndex(dir)`（每次读盘、剥 BOM）。这样主人在外部手动改 `index.json` 后，
 * 只读路径（挑图 / 清单 / 控制台统计）能立刻看到新内容。
 * 注意：写路径用内存缓存（`load()` 只读一次），所以**手动改索引前先停 dsh-web**
 * （否则下一次写入会把内存里的旧副本整份写回去 —— 2026-10-20 标签丢失的根因）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { readJsonFile, atomicWriteFileSync } from '../../platform/atomic.js'

/** 只认这几种图片格式（按内容魔数，不看扩展名）。 */
function extOf(buf) {
  if (!buf || buf.length < 12) return ''
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png'
  const head6 = buf.subarray(0, 6).toString('latin1')
  if (head6 === 'GIF87a' || head6 === 'GIF89a') return 'gif'
  if (buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp'
  return ''
}

/** 内容哈希（sha1 前 16 位）—— 去重键。 */
const hashOf = (buf) => crypto.createHash('sha1').update(buf).digest('hex').slice(0, 16)

/**
 * 读索引（唯一实现）：文件不存在 / 解析失败 → 空索引。
 * 每次读盘，不做缓存 —— 供只读路径与外部查看用。
 */
export function readIndex(dir) {
  try {
    const data = readJsonFile(path.join(dir, 'index.json'))
    return data && typeof data === 'object' && Array.isArray(data.items) ? data : { items: [], nextId: 1 }
  } catch {
    return { items: [], nextId: 1 }
  }
}

/**
 * 建一个库（每个插件实例一个）。
 * @param {object} opts
 * @param {string} opts.dir            库目录（index.json 与图片都在这里）
 * @param {number} [opts.maxItems]     库上限（张）；满了跳过新图，不淘汰旧的
 * @param {number} [opts.maxBytes]     单张上限（字节）
 * @param {number} [opts.minBytes]     单张下限（字节，挡掉 icon 那种几十字节的垃圾）
 * @param {(msg:string)=>void} [opts.log]
 */
export function createShelf(opts = {}) {
  const dir = String(opts.dir || '').trim()
  if (!dir) throw new Error('createShelf: 需要 dir')
  const maxItems = Math.max(1, Number(opts.maxItems) || 200)
  const maxBytes = Math.max(1, Number(opts.maxBytes) || 2 * 1024 * 1024)
  const minBytes = Math.max(0, Number(opts.minBytes) || 0)
  const log = typeof opts.log === 'function' ? opts.log : () => {}

  let cache = null // { items, nextId } —— 只给写路径用

  function load() {
    if (cache) return cache
    try {
      fs.mkdirSync(dir, { recursive: true })
    } catch {
      /* 已经在了 / 建不了就让后面报错 */
    }
    const idx = readIndex(dir)
    cache = {
      items: idx.items.filter((i) => i && Number.isFinite(Number(i.id))),
      nextId: Math.max(1, Number(idx.nextId) || 1),
    }
    return cache
  }

  /** 原子写回（紧凑 JSON）。失败只记日志，不抛给聊天。 */
  function save() {
    try {
      atomicWriteFileSync(path.join(dir, 'index.json'), JSON.stringify(cache))
      return true
    } catch (e) {
      log('索引写入失败: ' + e.message)
      return false
    }
  }

  /** 能用的条目：没被 blocked、有文件名、**磁盘上真有这个文件**。 */
  function usableItems() {
    return load().items.filter((i) => !i.blocked && i.file && fs.existsSync(path.join(dir, i.file)))
  }

  /** 挑图结果（统一形状）。 */
  const hitOf = (it) => ({ id: it.id, file: it.file, path: path.join(dir, it.file), tags: it.tags || [], untagged: !it.tagged })

  /** 记一次使用（挑中 → uses+1、lastUsed=now，保存）。 */
  function take(it) {
    it.uses = (Number(it.uses) || 0) + 1
    it.lastUsed = Date.now()
    save()
    return hitOf(it)
  }

  /**
   * 入库一批（**已由插件按协议字段筛过**的表情段）。
   * @param {object[]} segs     OneBot 消息段（只用它取 file/url，交给 download）
   * @param {{nick?:string,uid?:string}} meta 来源信息（只进日志）
   * @param {(seg:object)=>Promise<Buffer|null>} download 取字节；返回 null = 按"跳过"计
   * @returns {Promise<{added:number, seen:number, skipped:number}>}
   */
  async function harvest(segs, meta = {}, download = null) {
    const out = { added: 0, seen: 0, skipped: 0 }
    if (!Array.isArray(segs) || !segs.length || typeof download !== 'function') return out
    load()
    for (const seg of segs) {
      let buf = null
      try {
        buf = await download(seg)
      } catch (e) {
        log(`取图失败，跳过一张: ${(e && e.message) || e}`)
        out.skipped += 1
        continue
      }
      if (!buf || buf.length < minBytes || buf.length > maxBytes) {
        out.skipped += 1
        continue
      }
      const ext = extOf(buf)
      if (!ext) {
        out.skipped += 1
        continue
      }
      const hash = hashOf(buf)
      if (cache.items.some((i) => i.hash === hash)) {
        out.seen += 1 // 同一张，不重复存、也不写盘
        continue
      }
      if (cache.items.length >= maxItems) {
        log(`库已满(${maxItems})，跳过新贴图`)
        break
      }
      const id = cache.nextId
      const file = `${id}-${hash}.${ext}`
      try {
        fs.writeFileSync(path.join(dir, file), buf)
      } catch (e) {
        log(`写图片失败 #${id}: ${e.message}`)
        out.skipped += 1
        continue
      }
      cache.nextId = id + 1
      cache.items.push({
        id,
        hash,
        file,
        tags: [],
        tagged: false,
        blocked: false,
        uses: 0,
        lastUsed: 0,
        ts: Date.now(),
      })
      out.added += 1
      log(`收下 #${id} ${ext} ${(buf.length / 1024).toFixed(0)}KB${meta?.nick ? ' from ' + meta.nick : ''}`)
    }
    if (out.added) save()
    return out
  }

  /** 删一张：文件真删 + 索引条目删掉（不记黑名单）。 */
  function remove(id) {
    load()
    const n = Number(String(id).replace(/^#/, ''))
    const it = cache.items.find((x) => x.id === n)
    if (!it) return { ok: false, reason: 'not found' }
    try {
      const src = path.join(dir, it.file || '')
      if (it.file && fs.existsSync(src)) fs.unlinkSync(src)
    } catch (e) {
      log(`删文件失败 #${n}: ${e.message}`)
    }
    cache.items = cache.items.filter((x) => x.id !== n)
    save()
    log(`删除 #${n}${it.tags?.length ? ' ' + it.tags.join('/') : ''}`)
    return { ok: true, id: n }
  }

  /**
   * 挑一张（可写模式用；会记 uses/lastUsed）。
   * - `#12` / `12`：点名，**没找到就 null**（绝不换一张别的）；
   * - 关键词：只按 `tags` 精确匹配；没命中 → null（调用方再回落随机）。
   * @returns {object|null} { id, file, path, tags, untagged }
   */
  function resolve(tag) {
    const t = String(tag == null ? '' : tag).trim()
    const usable = usableItems()
    if (!usable.length) return null
    const m = /^#?(\d{1,4})$/.exec(t)
    if (m) {
      const it = usable.find((x) => x.id === Number(m[1]))
      return it ? take(it) : null
    }
    if (!t) return null
    const pool = usable.filter((i) => (Array.isArray(i.tags) ? i.tags : []).includes(t))
    if (!pool.length) return null
    // 最少用的 5 张里随机 —— 避免老发同一张
    pool.sort((a, b) => (Number(a.lastUsed) || 0) - (Number(b.lastUsed) || 0))
    const top = pool.slice(0, Math.min(5, pool.length))
    return take(top[Math.floor(Math.random() * top.length)])
  }

  /** 只记一次使用（可写模式下点名/随机挑中某张时用）。 */
  function recordUse(id) {
    load()
    const it = cache.items.find((x) => x.id === Number(id))
    if (!it) return null
    return take(it)
  }

  /** 清单（给模型看）：久没露脸的排前面，一行一张「#编号 标签/标签」。 */
  function catalog(limit = 30) {
    const usable = usableItems()
    if (!usable.length) return ''
    return usable
      .slice()
      .sort((a, b) => (Number(a.lastUsed) || 0) - (Number(b.lastUsed) || 0))
      .slice(0, Math.max(1, Number(limit) || 50))
      .map((i) => {
        const tags = (Array.isArray(i.tags) ? i.tags : []).slice(0, 3).join('/')
        return '#' + i.id + (tags ? ' ' + tags : '')
      })
      .join('\n')
  }

  /** 只看不改的统计（控制台/工具回显用）。 */
  function stats() {
    load()
    const usable = usableItems()
    return {
      dir,
      items: cache.items.length,
      usable: usable.length,
      tagged: usable.filter((i) => i.tagged).length,
      nextId: cache.nextId,
    }
  }

  return { dir, harvest, remove, resolve, recordUse, catalog, stats, usableItems }
}
