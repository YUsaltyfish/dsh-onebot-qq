// ⚠️ 这是**第三方代码**，不是我们写的 —— 原样 vendor，不要在这里改逻辑（要改就提 issue / 换版本）。
// 来源：https://github.com/JackZo400/dsh-sticker-library  （MIT，见同目录 dsh-sticker-library.LICENSE）
// 文件：src/shelf.js   取得日期：2026-10-12   拉取渠道：cdn.jsdelivr.net @main（内容 sha1 前 16 位 b84e4dd2a55c40f8）
// 它做什么：表情包库核心 —— 内容哈希去重 / 大小闸 / index.json / TAG_VER / catalog+resolve。
// 它不做什么：不发送、不依赖 dsh、不依赖 IM 协议（README 明说可单独用）→ 我们只包一层 QQ 采集与发送。
// 升级方式：重新从上游 src/shelf.js 拉这个文件覆盖，并把上面的日期/sha1 改掉，然后跑 selfcheck-sticker-shelf.cjs。
// 🔧 **本地补丁（升级覆盖后必须重打）**：`applyTagResult()` 里那两道**按字兜底**正则（adult 的
//    `/逼|屌|…|操|…|黄/`、lowq 的 `/烂梗|…|低质/`）已删 —— 它们只在「脏：/烂：」两行缺失时兜底，
//    而我们的提示词不产那两行 → 兜底成了唯一路径、只剩误杀（一张大哭表情脸写了「黄色」→ 永久成人化）。
//    重打方法：把 `it.adult = dirty ? … : false` / `it.lowq = lowq ? … : false` 里的兜底正则去掉，
//    然后跑自检（⑧c 专门钉这个，被覆盖回去会当场红）。
/**
 * 表情包架子的核心逻辑 —— 不依赖 dsh，也不依赖任何 IM 协议。
 *
 * 它要解决的不是「存表情包」，而是这四件经常被做错的事：
 *
 *   1. **什么算表情包**。绝对不要用 `summary === '[图片]'` 之类的启发式去认 ——
 *      OneBot / 各家桥对**普通图片**也给同样的 summary，那样会把群友的真人照片收进库里。
 *      只认协议明确标出来的「贴图」（emoji_id / sub_type=1 之类），让调用方 `isSticker` 判断。
 *
 *   2. **怎么算「懂」这张图**。别用固定标签表。我们试过 40 个固定词，结果 40 多张图
 *      被压成「可爱 / 卖萌 / 无语」三类，等于没有区分度，挑图基本等于随机。
 *      让视觉模型自己写「画的是什么 / 什么场合发 / 关键词」，它才真的能挑。
 *
 *   3. **删了就删了**。（本机已移除上游的"内容哈希黑名单"补丁，见文件头「本地补丁 2」）
 *      删除 = 删文件 + 删索引条目；同一张图再被发进群会被重新收回来。
 *
 *   4. **两条安全线**：脏（脏话/性暗示）和烂（低质烂梗素材）。命中就在入库那一刻拦掉，
 *      别指望下游的模型每次都记得别发。
 *
 * 状态是每个实例一份的（工厂函数，不用模块级单例）：你可以同时开好几个架子，
 * 也可以把它挂在测试里反复建/拆。
 *
 * @module sticker-library/shelf
 */

import { createHash } from 'node:crypto'
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { extname, join } from 'node:path'

/** 打标默认提示词：五个字段，两行是安全线。`看` 里要求"图上的字照抄"是关键 —— 表情包一半的含义在图上的字里。 */
export const DEFAULT_TAG_PROMPT =
  '这是一张聊天里用的表情包（可能是动图，按整体感觉判断）。请严格按五行输出，不要解释、不要编号：\n' +
  '看：这张图上画的是什么（40 字以内，图上的字照抄）\n' +
  '用：什么场合、什么心情下会发它（20 字以内）\n' +
  '词：2-4 个关键词，用逗号分隔（自由写，不用挑现成的词）\n' +
  '脏：有 / 无 —— 图上有脏话、性暗示、性器官、成人下流内容的写「有」，否则写「无」\n' +
  '烂：有 / 无 —— 这张是不是网上那种低质烂梗素材：短视频平台的恶搞低质图、3D 塑料感的怪诞人偶、' +
  '土味商业图、AI 生成的诡异丑图；这些写「有」。正常的表情包（猫图、卡通方块脸、简洁线条图、二次元、可爱玩偶）一律写「无」\n' +
  '如果这张图里包含真人照片、色情图片或违法内容，只回复 BLOCK。'

/** 打标提示词的版本号：改了字段/说法就 +1，会让整个库重新打标（贵，别乱动）。 */
export const TAG_VER = 1

const noop = () => {}

/**
 * 建一个表情包架子。
 *
 * @param {object} options
 * @param {string} options.dir          图片存哪（会自动建）
 * @param {function} options.describe   **必填**：`(filePath, prompt) => Promise<string>`，
 *                                      把一张本地图片交给视觉模型，拿回上面那五行文本。
 * @param {string} [options.indexFile]  索引 JSON 路径，默认 `<dir>/index.json`
 * @param {number} [options.maxItems]   库上限
 * @param {number} [options.maxBytes]   单张上限（默认 4MB：聊天软件里的贴图基本都在这以下）
 * @param {number} [options.minBytes]   单张下限（挡掉 icon 那种几十字节的垃圾）
 * @param {string} [options.prompt]     打标提示词，默认 {@link DEFAULT_TAG_PROMPT}
 * @param {function} [options.log]
 */
export function createShelf(options = {}) {
  const dir = String(options.dir || '').trim()
  if (!dir) throw new Error('createShelf: 需要 dir')
  if (typeof options.describe !== 'function') throw new Error('createShelf: 需要 describe(filePath, prompt)')

  const indexFile = options.indexFile || join(dir, 'index.json')
  const maxItems = Number(options.maxItems) || 200
  const maxBytes = Number(options.maxBytes) || 4 * 1024 * 1024
  const minBytes = Number(options.minBytes) || 200
  const prompt = options.prompt || DEFAULT_TAG_PROMPT
  const log = options.log || noop
  const describe = options.describe

  /** @type {{items: any[], nextId: number}|null} */
  let cache = null
  let dirty = false
  let tagging = false // 打标运行锁：启动时和定时任务可能同时来，别重复烧视觉 API

  const ensureDir = () => {
    try {
      mkdirSync(dir, { recursive: true })
    } catch {
      /* 已经在了 */
    }
  }

  function load() {
    if (cache) return cache
    ensureDir()
    try {
      const j = JSON.parse(readFileSync(indexFile, 'utf8'))
      cache = { items: Array.isArray(j.items) ? j.items : [], nextId: Number(j.nextId) || 1 }
    } catch {
      cache = { items: [], nextId: 1 }
    }
    return cache
  }

  function save() {
    if (!dirty) return true
    try {
      ensureDir()
      // 先写临时文件再原子替换：写一半断电，索引不会变成半个 JSON
      const tmp = indexFile + '.tmp'
      writeFileSync(tmp, JSON.stringify(cache, null, 0))
      renameSync(tmp, indexFile)
      dirty = false
      return true
    } catch (e) {
      log('save fail:', e.message)
      return false
    }
  }

  const touch = () => {
    dirty = true
  }

  // ---------------- 收 ----------------

  const sha1 = (buf) => createHash('sha1').update(buf).digest('hex').slice(0, 16)

  /** 按**文件头**认格式：扩展名是聊天软件给的，不可信；认不出的一律不收。 */
  function extOf(buf) {
    if (buf.length > 3 && buf.slice(0, 3).toString('latin1') === 'GIF') return 'gif'
    if (buf.length > 8 && buf[0] === 0x89 && buf.slice(1, 4).toString('latin1') === 'PNG') return 'png'
    if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg'
    if (
      buf.length > 12 &&
      buf.slice(0, 4).toString('latin1') === 'RIFF' &&
      buf.slice(8, 12).toString('latin1') === 'WEBP'
    )
      return 'webp'
    return null
  }

  /** 这是不是一张「贴图」（而不是真人照片/普通图片）。判断权交给调用方：不同协议标记不一样。 */
  function isSticker(seg) {
    const d = (seg && seg.data) || {}
    if (d.emoji_id || d.emoji_package_id) return true // QQ 商城表情
    if (String(d.sub_type) === '1') return true // OneBot：自定义贴图
    return false
  }

  /**
   * 收图入库。
   * @param {any[]} segs      消息段
   * @param {{nick?:string,uid?:string}} meta 谁发的（只用来记来源）
   * @param {(seg:any)=>Promise<Buffer|null>} download 怎么把这一段的图拿下来 —— 由调用方决定（不同协议 URL 形式不同）
   */
  async function harvest(segs, meta, download) {
    load()
    if (!Array.isArray(segs)) return { added: 0, seen: 0, skipped: 0 }
    const found = segs.filter(isSticker)
    if (!found.length) return { added: 0, seen: 0, skipped: 0 }
    let added = 0
    let seen = 0
    let skipped = 0
    for (const seg of found) {
      try {
        const buf = await download(seg)
        if (!buf || buf.length < minBytes || buf.length > maxBytes) {
          skipped++
          continue
        }
        const ext = extOf(buf)
        if (!ext) {
          skipped++
          continue
        }
        const hash = sha1(buf)
        const exists = cache.items.find((i) => i.hash === hash)
        if (exists) {
          exists.seenCount = (exists.seenCount || 1) + 1
          exists.lastSeen = Date.now()
          touch()
          seen++
          continue
        }
        if (cache.items.length >= maxItems) {
          log('库已满(' + maxItems + ')，跳过新贴图')
          break
        }
        const id = cache.nextId++
        const name = id + '-' + hash + '.' + ext
        writeFileSync(join(dir, name), buf)
        const d = (seg && seg.data) || {}
        cache.items.push({
          id,
          hash,
          file: name,
          summary: String(d.summary || '').slice(0, 24),
          fromNick: String((meta && meta.nick) || '').slice(0, 24),
          fromUid: String((meta && meta.uid) || ''),
          ts: Date.now(),
          uses: 0,
          lastUsed: 0,
          tags: [],
          tagged: false,
          blocked: false,
          seenCount: 1,
        })
        touch()
        added++
        log('收下 #' + id, ext, (buf.length / 1024).toFixed(0) + 'KB', 'from', (meta && meta.nick) || '')
      } catch (e) {
        // 单张失败不能带倒整批：群里一次发好几张是常事
        skipped++
        log('harvest item err:', String((e && e.message) || e).slice(0, 100))
      }
    }
    save()
    return { added, seen, skipped }
  }

  /**
   * 协议无关的入库口：直接喂**本地文件路径**或 Buffer。
   *
   * `harvest()` 那条路要靠 IM 的段结构（`emoji_id` / `sub_type`）+ 一个下载回调；
   * 没有 IM 的场合（写脚本批量整理、把某个目录里的图倒进来、别的通道插件自己下好图了）
   * 用这个 —— 去重、大小闸、编号全跟 harvest 走同一套。
   *
   * @param {Array<string|{path?:string,buf?:Buffer,summary?:string}>|string} inputs 文件路径 / Buffer / 它们的混合数组
   * @param {{nick?:string,uid?:string}} [meta] 来源信息（谁发的），只用于记档
   * @returns {{added:number, seen:number, skipped:number}} 新增 / 之前见过 / 跳过（太小、太大、认不出格式）
   */
  function saveFiles(inputs, meta = {}) {
    load()
    const list = Array.isArray(inputs) ? inputs : [inputs]
    let added = 0
    let seen = 0
    let skipped = 0
    for (const raw of list) {
      try {
        const filePath = typeof raw === 'string' ? raw : String((raw && raw.path) || '')
        const buf = raw && raw.buf ? raw.buf : (filePath ? readFileSync(filePath) : null)
        if (!buf || buf.length < minBytes || buf.length > maxBytes) {
          skipped++
          continue
        }
        const ext = extOf(buf)
        if (!ext) {
          skipped++
          continue
        }
        const hash = sha1(buf)
        const exists = cache.items.find((i) => i.hash === hash)
        if (exists) {
          exists.seenCount = (exists.seenCount || 1) + 1
          exists.lastSeen = Date.now()
          touch()
          seen++
          continue
        }
        if (cache.items.length >= maxItems) {
          log('库已满(' + maxItems + ')，跳过新贴图')
          break
        }
        const id = cache.nextId++
        const name = id + '-' + hash + '.' + ext
        writeFileSync(join(dir, name), buf)
        cache.items.push({
          id,
          hash,
          file: name,
          summary: String((raw && raw.summary) || '').slice(0, 24),
          fromNick: String((meta && meta.nick) || '').slice(0, 24),
          fromUid: String((meta && meta.uid) || ''),
          ts: Date.now(),
          uses: 0,
          lastUsed: 0,
          tags: [],
          tagged: false,
          blocked: false,
          seenCount: 1,
        })
        touch()
        added++
        log('收下 #' + id, ext, (buf.length / 1024).toFixed(0) + 'KB')
      } catch (e) {
        // 单张失败不能带倒整批
        skipped++
        log('saveFiles err:', String((e && e.message) || e).slice(0, 100))
      }
    }
    save()
    return { added, seen, skipped }
  }

  // ---------------- 懂 ----------------

  /**
   * 给还没打过标的图打标（用视觉模型）。
   * 返回打了几张。跑之前会加锁，重入直接返回 0。
   */
  async function tagPending(limit = 15) {
    if (tagging) return 0
    tagging = true
    try {
      load()
      const todo = cache.items
        .filter((i) => !i.blocked && (!i.tagged || i.tagVer !== TAG_VER))
        .slice(0, limit)
      if (!todo.length) return 0
      let n = 0
      for (const it of todo) {
        const file = join(dir, it.file)
        if (!existsSync(file)) {
          // 文件被人手删了：标掉，别再排队
          it.tagged = true
          it.tagVer = TAG_VER
          it.blocked = true
          touch()
          continue
        }
        try {
          const raw = String((await describe(file, prompt)) || '').trim()
          if (/BLOCK|真人照片|色情|违法/i.test(raw)) {
            it.blocked = true
            it.tagged = true
            it.tagVer = TAG_VER
          } else {
            applyTagResult(it, raw)
          }
          touch()
          save()
          n++
          log(
            '打标 #' + it.id,
            (it.blocked ? 'BLOCK' : (it.tags || []).join(',') + ' | ' + (it.desc || '') + ' | ' + (it.use || '')) +
              (it.adult ? ' | ⚠️成人/脏话' : '') +
              (it.lowq ? ' | 🚫拒收(烂梗)' : ''),
          )
        } catch (e) {
          // 失败不堵队头：连续 3 次还失败就标过，剩下的继续
          it.failCount = (it.failCount || 0) + 1
          if (it.failCount >= 3) it.tagged = true
          touch()
          save()
          log('打标失败 #' + it.id, 'failCount=' + it.failCount, String((e && e.message) || e).slice(0, 80))
        }
      }
      return n
    } finally {
      tagging = false
    }
  }

  /** 把模型那五行文本贴到条目上。模型没按格式写时退回按行拆 —— 宁可粗一点，也别把这张图永远晾着。 */
  function applyTagResult(it, raw) {
    const lines = raw.split(/\n+/).map((x) => x.trim()).filter(Boolean)
    const field = (name) => {
      const l = lines.find((x) => x.replace(/\s/g, '').startsWith(name))
      return l ? l.replace(/^[^:：]*[:：]/, '').trim() : ''
    }
    let look = field('看')
    let use = field('用')
    const words = field('词')
    const dirty = field('脏')
    const lowq = field('烂')
    if (!look && !use && !words && lines.length) {
      look = lines[0]
      use = lines.slice(1).join(' ').slice(0, 30)
    }
    const clean = (s) => String(s || '').replace(/^[-–—•\d.、\s]+/, '').trim()
    it.desc = clean(look).slice(0, 60)
    it.use = clean(use).slice(0, 30)
    it.tags = clean(words)
      .split(/[，,、/|；;]+/)
      .map((s) => s.trim())
      .filter(Boolean)
      .slice(0, 4)
      .map((s) => s.slice(0, 6))
    // 🔧 本地改动（2026-10-12，主人定）：原先这两行是「没给脏/烂就按字粗查」的兜底正则，**已摘掉** ——
    //    我们的提示词根本不产「脏：/烂：」两行 → 兜底是唯一会跑的路径，而它只会误杀（模型写「黄色表情脸」
    //    就把整张图永久判成成人图、挑不到也发不出）。上游刷新覆盖后**必须重打这个补丁**（见文件头）。
    it.adult = dirty ? /有/.test(dirty) : false
    it.lowq = lowq ? /有/.test(lowq) : false
    if (it.lowq) it.blocked = true
    it.tagged = true
    it.tagVer = TAG_VER
  }

  // ---------------- 挑 ----------------

  /** 能发的那些：没被拦、打过标、不是成人图。 */
  const usableItems = () => cache.items.filter((i) => !i.blocked && i.tagged && !i.adult)

  /**
   * 挑一张。`tag` 可以是 `#12` / `12`（点名）、一个关键词，或空（随机）。
   * @returns {{id:number,file:string,path:string,desc:string,use:string,tags:string[]}|null}
   */
  function resolve(tag) {
    load()
    const t = String(tag || '').trim()
    const usable = usableItems()
    if (!usable.length) return null

    const take = (it) => {
      it.uses = (it.uses || 0) + 1
      it.lastUsed = Date.now()
      touch()
      save()
      return { id: it.id, file: it.file, path: join(dir, it.file), desc: it.desc || '', use: it.use || '', tags: it.tags || [] }
    }

    // ① 点名某个编号
    const idm = t.match(/^#?(\d{1,4})$/)
    if (idm) {
      const it = usable.find((x) => x.id === Number(idm[1]))
      if (it) return take(it)
      // 点名没找到就明说没有 —— **绝不能顺手挑一张别的**。
      // 我们真踩过：删掉 #34 之后，`#34` 掉进下面"关键词"那条路，结果随机发出去一张 #38，
      // 它以为发的是 #34，群里收到的却是另一张图。这种错最难受：没人报错，只有人觉得对不上。
      if (cache.items.some((x) => x.id === Number(idm[1]) && x.adult)) log('点名的 #' + idm[1] + ' 是成人图，不发')
      return null
    }

    // ② 关键词 / 随机
    let pool = usable
    if (t && t !== '随机' && t !== '随便') {
      const byTag = usable.filter((i) => (i.tags || []).includes(t))
      const byText = usable.filter((i) => (i.desc && i.desc.includes(t)) || (i.use && i.use.includes(t)))
      pool = byTag.length ? byTag : byText
      // 完全没对上就别硬凑一张意思不对的图；一个字的模糊词除外（那种本来就没指望精确）
      if (!pool.length) pool = t.length <= 1 ? usable : []
    }
    if (!pool.length) return null
    pool.sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))
    const top = pool.slice(0, Math.min(5, pool.length)) // 最少用的 5 张里随机，避免老发同一张
    return take(top[Math.floor(Math.random() * top.length)])
  }

  /**
   * 生成给模型看的清单：一行一张「#编号 关键词 · 画面是什么 —— 适合什么场合发」。
   * 久没露脸的排前面，长尾的图也有机会被看见。
   */
  function catalog(limit = 50) {
    load()
    const usable = usableItems()
    if (!usable.length) return ''
    return usable
      .slice()
      .sort((a, b) => (a.lastUsed || 0) - (b.lastUsed || 0))
      .slice(0, limit)
      .map((i) => {
        const tags = (i.tags || []).slice(0, 3).join('/')
        const desc = String(i.desc || '').replace(/\s+/g, ' ').trim()
        const use = String(i.use || '').replace(/\s+/g, ' ').trim()
        let line = '#' + i.id + (tags ? ' ' + tags : '')
        if (desc) line += ' · ' + desc
        if (use) line += ' —— ' + use
        return line
      })
      .join('\n')
  }

  // ---------------- 删 / 整理 ----------------

  /** 删一张：文件真删 + 索引条目删掉（不再记黑名单：删掉的图下次被发进群会重新收进来）。 */
  function remove(id, why) {
    load()
    const n = Number(String(id).replace(/^#/, ''))
    const it = cache.items.find((x) => x.id === n)
    if (!it) return { ok: false, reason: 'not found' }
    try {
      const src = join(dir, it.file)
      if (existsSync(src)) unlinkSync(src)
    } catch (e) {
      log('删文件失败 #' + n + ':', String((e && e.message) || e).slice(0, 80))
    }
    cache.items = cache.items.filter((x) => x.id !== n)
    dirty = true
    save()
    log('删除 #' + n, it.hash, (it.desc || '').slice(0, 30), why ? '（' + why + '）' : '')
    return { ok: true, id: n, hash: it.hash, desc: it.desc || '' }
  }

  /** 重排编号 1..N（删过之后会有空洞），文件名跟着改。 */
  function renumber() {
    load()
    const items = cache.items.slice().sort((a, b) => a.id - b.id)
    let moved = 0
    items.forEach((it, idx) => {
      const want = idx + 1
      const ext = extname(it.file || '')
      const wantFile = want + '-' + it.hash + ext
      if (it.file !== wantFile) {
        try {
          const from = join(dir, it.file || '')
          const to = join(dir, wantFile)
          if (existsSync(from)) {
            renameSync(from, to)
            moved++
          }
        } catch (e) {
          log('改文件名失败 #' + it.id, String(e.message).slice(0, 60))
        }
        it.file = wantFile
      }
      it.id = want
    })
    cache.nextId = items.length + 1
    dirty = true
    save()
    log('重新编号', '共 ' + items.length + ' 张，改名 ' + moved + ' 个')
    return { count: items.length, moved }
  }

  /** 只看不改的统计：给人看的（也方便测试断言）。 */
  function stats() {
    load()
    const by = (f) => cache.items.filter(f).length
    return {
      total: cache.items.length,
      usable: usableItems().length,
      untagged: by((i) => !i.tagged),
      blocked: by((i) => i.blocked),
      adult: by((i) => !!i.adult),
      lowq: by((i) => !!i.lowq),
    }
  }

  /** 某个编号是不是还在（含"在但被拦下了"）—— 点名时用得上。 */
  function get(id) {
    load()
    const n = Number(String(id).replace(/^#/, ''))
    return cache.items.find((x) => x.id === n) || null
  }

  return {
    dir,
    harvest,
    saveFiles,
    tagPending,
    resolve,
    catalog,
    remove,
    renumber,
    stats,
    get,
    isSticker,
    // 给测试/迁移用
    _load: load,
    _save: save,
  }
}
