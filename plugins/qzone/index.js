/**
 * qzone — QQ 空间日记（order 62）
 *
 * 给机器人一个自己的 QQ 空间当日记本：每天最多一条，由它自己决定写不写。
 *
 * 三条设计红线（改之前先读）：
 *   ① **"不写"绝不能进空间**。`skip_qzone` 和 `post_qzone` 是两个工具，
 *      skip 只记本地状态、一个字都不会发；post 里还有一道正文防呆（见下）。
 *      合并成一个工具 + 传空值的话，模型很容易把"今天不写"当正文发出去 —— 那是公开的。
 *   ② **配图不碰固定图库**。只接受本地文件路径，并拒绝 `qq-stickers/` 下的文件
 *      （那是主人的固定表情库，混进群图会污染）。生成图存自己的目录。
 *   ③ **配额状态进 ChatState**。不用文件、不开全局 Map：`/reset` 能干净清理，
 *      群间也不会串线（状态挂在 `_scratch`，按 chatKey 隔离）。
 *
 * 提醒时机：到点后第一条被唤醒的消息挂一条 `ev.hint`（不改静态系统提示，保 KV cache）。
 * 提醒不是强制 —— 模型可以写，也可以 skip，也可以完全不理会。
 */
import fs from 'node:fs'
import path from 'node:path'
import { isInsidePath } from '../../platform/paths.js'

/** 本地日期 YYYY-MM-DD（跨平台：不用 toISOString，那是 UTC） */
function localDate() {
  const d = new Date()
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

/** 取本会话的日记槽（懒建；state 不可用时退化为本轮内存，不影响聊天） */
function slotOf(bot, chatKey) {
  const st = bot.state?.get?.(chatKey) ?? {}
  return (st._scratch ||= Object.create(null))
}

export default {
  id: 'qzone',
  title: 'QQ 空间日记',
  order: 62,

  configSchema: {
    info: {
      type: 'info', group: '空间日记',
      text: '给机器人一个自己的 QQ 空间当日记本。\n'
        + '· 每天最多 1 条，由它自己决定写不写；不写不算欠账，第二天不补也不解释。\n'
        + '· 到点后会提醒它考虑一次（提醒 ≠ 强制，它可以不理会）。\n'
        + '· 配图只接受本地文件路径，不会往固定表情包图库里写东西。\n'
        + '· 需要协议端支持 `send_qzone_msg` 扩展；不支持的实现会自动降级为「发不出去」并如实告知。',
    },
    enabled: {
      type: 'bool', default: true, group: '空间日记',
      label: '启用空间日记',
      hint: '关掉后它不会收到写日记的提醒，也不能调发说说工具。',
    },
    dailyLimit: {
      type: 'int', default: 1, min: 1, max: 5, step: 1, group: '空间日记',
      label: '每个会话每天最多发几条',
      hint: '默认 1。调大会让「今天只有一次机会」的选择压力变小，容易写成流水账 —— 建议保持 1。',
    },
    remindAfterHour: {
      type: 'int', default: 22, min: 0, max: 23, step: 1, group: '空间日记',
      label: '每天几点后提醒它考虑',
      hint: '24 小时制。到点后若本会话今天还没写过也没跳过，会在下一条被唤醒的消息里提醒一次；填 0 = 不提醒。',
    },
    maxChars: {
      type: 'int', default: 300, min: 20, max: 2000, step: 10, group: '空间日记',
      label: '单条最多多少字',
      hint: '说说正文上限，超出会被截断（不是报错）。',
    },
    maxImages: {
      type: 'int', default: 1, min: 0, max: 9, step: 1, group: '空间日记',
      label: '最多配几张图',
      hint: '默认 1 张稳妥；QQ 空间本身支持到 9 张。填 0 = 不许配图。',
    },
    imageDir: {
      type: 'str', default: 'qzone-imgs', group: '空间日记',
      label: '配图目录',
      hint: '相对数据目录。**与表情包库 qq-stickers 隔离**，生成/转存的空间配图放这里。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}

    /** 本会话今天的日记槽（跨轮，按 chatKey 隔离） */
    const todaySlot = (chatKey) => {
      const s = slotOf(bot, chatKey)
      const q = (s['qzone:today'] ||= {})
      const d = localDate()
      if (q.date !== d) {
        q.date = d
        q.posted = 0
        q.skipped = false
        q.reminded = false
      }
      return q
    }

    const limit = () => Math.max(1, Number(cfg().dailyLimit) || 1)

    /** 配图目录（相对 dataDir 已由内核解析，这里再做一次兜底） */
    const imageDir = () => {
      const raw = String(cfg().imageDir || 'qzone-imgs').trim() || 'qzone-imgs'
      const base = String(bot.core?.dataDir || '')
      return path.isAbsolute(raw) ? raw : path.join(base, raw)
    }

    /** 图片校验：存在 + 不得来自固定表情库 */
    const checkImage = (p) => {
      const abs = path.resolve(String(p || '').trim())
      if (!abs) return { ok: false, msg: '图片路径为空' }
      let real = abs
      try { real = fs.realpathSync(abs) } catch { return { ok: false, msg: `图片不存在：${abs}` } }
      const stickers = path.join(String(bot.core?.dataDir || ''), 'qq-stickers')
      let stickerReal = stickers
      try { stickerReal = fs.realpathSync(stickers) } catch { /* 库不存在就不用比 */ }
      // 包含判定只走 platform（红线 B.2：禁止 startsWith 拼路径）
      if (isInsidePath(stickerReal, real)) {
        return { ok: false, msg: '不能直接引用表情包库里的文件（会污染固定图库）；请先复制到配图目录再用' }
      }
      return { ok: true, path: real }
    }

    // ── 工具 ①：写日记 ────────────────────────────────────────
    bot.registerTool('post_qzone', {
      description: '把一条日记发到自己的 QQ 空间（每个会话一天只有一次机会，发了就用完）。'
        + '**不想写时不要调这个工具，改调 skip_qzone()** —— 千万别把「今天不写」当正文发出去，那是公开可见的。'
        + 'images 只能给本地文件绝对路径，不支持从表情包库里挑。',
      parameters: {
        target: {
          type: 'string', required: true,
          description: '当前会话：group:<群号> 或 private:<QQ号>（见开头 [QQ会话 …]）',
        },
        content: {
          type: 'string', required: true,
          description: '说说正文（日记内容本身；不要写「今天不写」这类话）',
        },
        images: {
          description: '配图：本地文件绝对路径，可传字符串或数组。可选。',
          oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        },
      },
      async execute(args = {}) {
        const chatKey = String(args.target || '')
        if (!chatKey) return { ok: false, reason: '缺 target（当前会话）' }
        if (cfg().enabled === false) return { ok: false, reason: '空间日记未启用' }

        const q = todaySlot(chatKey)
        if (q.posted >= limit()) {
          return { ok: false, reason: `今天已经写过 ${q.posted} 条了（上限 ${limit()}），明天再来` }
        }

        const text = String(args.content ?? '').trim()
        if (!text) return { ok: false, reason: 'content 不能为空' }

        // 防呆：正文看起来是在说「不写」→ 拒绝，别让这句话真的出现在空间里
        if (/^[【\[]?不写[】\]]?[。.]?$/.test(text) || /^今天不写/.test(text)) {
          return { ok: false, reason: '这看起来是「不写」的意思 —— 请改用 skip_qzone()，不要发到空间' }
        }

        const maxChars = Math.max(1, Number(cfg().maxChars) || 300)
        const body = text.length > maxChars ? text.slice(0, maxChars) : text

        // 配图
        const rawImg = args.images
        const list = Array.isArray(rawImg) ? rawImg : (rawImg ? [rawImg] : [])
        const maxImg = Math.max(0, Number(cfg().maxImages) || 1)
        if (maxImg === 0 && list.length) return { ok: false, reason: '配置里关掉了配图（最多配图数 = 0）' }
        const paths = []
        for (const p of list.slice(0, maxImg)) {
          const r = checkImage(p)
          if (!r.ok) return { ok: false, reason: r.msg }
          paths.push(r.path)
        }

        // 走适配器（不裸发：协议端细节与超时都封在 kernel 里）
        const res = await bot.onebot.sendQzoneMsg({ content: body, images: paths })
        if (!res?.ok) return { ok: false, reason: res?.msg || '发说说失败' }

        q.posted += 1
        bot.log.info(`[空间] 发出日记 ${body.length} 字${paths.length ? ` + ${paths.length} 张图` : ''}`
          + `（今天第 ${q.posted}/${limit()} 条）`)
        return { ok: true, posted: true, chars: body.length, images: paths.length }
      },
    })

    // ── 工具 ②：今天不写（绝不发任何东西）──────────────────────
    bot.registerTool('skip_qzone', {
      description: '今天不写日记。**这个工具不会往空间发任何内容**，只是记下「我考虑过了，今天没有想写的」。'
        + '觉得今天没什么值得记的、或者不想写，就用它 —— 这完全是正常选项，不欠账、明天照常。',
      parameters: {
        target: {
          type: 'string', required: true,
          description: '当前会话：group:<群号> 或 private:<QQ号>',
        },
        reason: { type: 'string', description: '为什么不想写（只记日志，不会发到空间）' },
      },
      async execute(args = {}) {
        const chatKey = String(args.target || '')
        if (!chatKey) return { ok: false, reason: '缺 target（当前会话）' }
        const why = String(args.reason ?? '').trim() || '(没说原因)'
        todaySlot(chatKey).skipped = true
        bot.log.info(`[空间] 今天不写：${why}`)
        return { ok: true, skipped: true }
      },
    })

    // ── 工具 ③：查状态 ────────────────────────────────────────
    bot.registerTool('qzone_status', {
      description: '查本会话今天的日记状态（写过没有、还剩几次机会）。一般不用调，提醒里已经写了。',
      parameters: {
        target: {
          type: 'string', required: true,
          description: '当前会话：group:<群号> 或 private:<QQ号>',
        },
      },
      async execute(args = {}) {
        const chatKey = String(args.target || '')
        if (!chatKey) return { ok: false, reason: '缺 target（当前会话）' }
        const q = todaySlot(chatKey)
        return {
          ok: true,
          enabled: cfg().enabled !== false,
          date: q.date,
          used: q.posted,
          limit: limit(),
          remaining: Math.max(0, limit() - q.posted),
          skippedToday: q.skipped,
        }
      },
    })

    // ── 到点提醒（挂 hint，不改系统提示）──────────────────────
    bot.on('before-turn', (ev) => {
      if (cfg().enabled === false) return
      if (!ev.wake) return // before-turn 对未唤醒消息也会跑
      const startHour = Number(cfg().remindAfterHour) || 0
      if (startHour <= 0) return
      if (new Date().getHours() < startHour) return

      const q = todaySlot(ev.chatKey)
      if (q.reminded || q.posted > 0 || q.skipped) return

      q.reminded = true
      if (!Array.isArray(ev.hint)) return
      ev.hint.push('[日记:今天还没写空间。想写就调 post_qzone(target, content, images?)，'
        + '每个会话一天只有这一条机会；不想写就调 skip_qzone(target, reason) '
        + '—— 绝对不要把「不写」当正文发出去]')
      bot.log.info('[空间] 今晚还没写日记，已提醒（不是强制）')
    })
  },
}
