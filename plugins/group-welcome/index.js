/**
 * group-welcome — 入群欢迎（id: 'group-welcome', order: 55）
 *
 * 设计思路参考 AstrBot 的 group_welcome 插件，用本框架契约重写（不是逐行移植）。
 *
 * 数据流：
 *   OneBot notice group_increase
 *     → normalizeEvent（ev._scratch.notice = { type, subType, userId, targetId }）
 *     → pre-gate：群屏蔽 / 群内用户黑名单照旧拦截（用户级白名单对通知不生效，见 gate-wake）
 *     → intercept（本插件）：
 *         · 固定句池：延迟 N 秒 → 随机句(+随机图) → deliver/sendMedia → ev.stopped=true（零 token）
 *         · 模型定制：设 ev.wake={kind:'welcome'} + hint → 正常回合，模型自己调 send_message 发欢迎语；
 *                     N 秒内没看到出站 → 用句池兜底补一句（可关）
 *
 * 纪律：
 *   · 出站只走 bot.deliver / bot.sendMedia（脱敏 + 留档的唯一口）；@ 走 ats，不手写 [CQ:at] 文本。
 *   · 冷却**发送成功后**才真正生效：固定模式失败会清掉冷却，别让群友被"失败也冷却"卡死（AstrBot 版踩过）。
 *   · 占位符白名单替换：{name} {qq} {group}；未知占位符原样保留（AstrBot 版一遇未知变量整条模板报废）。
 *   · 跨轮状态一律放 ChatState._scratch（冷却 / 上次句 / 模型模式间隔 / 待兜底记录），不另开全局状态 Map。
 *   · 配置每次现读 bot.cfg（控制台热改立即生效）。单位口径 = 控制台的"人话单位"：
 *     delayMs / cooldownMs / modelFallbackMs / modelMinGapMs 存**秒**，imageChance 存**百分数**（0-100）。
 *     旧配置的 ms / 分数由 config-store 的 import-legacy 迁移层换算成同一口径。
 *
 * 平台边界：图片池目录相对 dataDir（内核解析成绝对路径）；附图走 `platform/cq-file.js` 的 `cqImage()`。
 */

import fs from 'node:fs'
import path from 'node:path'
import { cqImage } from '../../platform/cq-file.js'

/** 内置默认句池（配置里 lines 为空时用） */
const DEFAULT_LINES = [
  '🎉 欢迎 {name} 加入本群～有什么想聊的直接说！',
  '欢迎新朋友 {name}！先看看群公告，别害羞～',
  '{name} 来啦，群友+1，气氛+100 ✨',
]
/** 模型模式默认风格要求（配置里 modelPrompt 为空时用） */
const DEFAULT_MODEL_PROMPT = '用你平时在群里说话的口吻，写一句欢迎语：短一点、带点情绪，别像客服模板。'
/** 图片池只认这些后缀（按扩展名筛；协议端发本地图用绝对路径） */
const IMAGE_EXTS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp'])
/** 群名缓存 TTL（取不到也退避这么久，别每条通知都打 API） */
const GROUP_NAME_TTL_MS = 5 * 60 * 1000
/** 冷却表最多保留多少条（超过就丢最老的，防无限增长） */
const MAX_COOLDOWN_ENTRIES = 500

/** 本插件开关表（控制台「入群欢迎」页据此渲染） */
const configSchema = {
  enabled: { type: 'bool', default: true, group: '入群欢迎', label: '入群欢迎', hint: '开：新人入群时按这里配置打招呼；关：不欢迎。' },
  mode: {
    type: 'enum', default: 'fixed', group: '入群欢迎', label: '欢迎语模式',
    options: [{ value: 'fixed', label: '固定句池' }, { value: 'model', label: '模型定制（每次入群烧一个回合）' }],
    hint: '固定句池零 token、文案可控；模型定制由模型按新人昵称现写，有兜底句池。',
  },
  groups: {
    type: 'group', default: [], group: '入群欢迎', label: '欢迎群（空 = 不欢迎任何群；* = 所有未被屏蔽群）',
    hint: '推荐在「群聊」页每张群卡片上勾「允许入群欢迎」；整群屏蔽沿用群屏蔽（ignoreGroups），不另存黑名单。',
  },
  lines: {
    type: 'text', default: DEFAULT_LINES.join('\n'), group: '入群欢迎', label: '固定句池（一行一句）',
    hint: '随机挑一句（不会连续重复）；支持 {name} 昵称、{qq} 号码、{group} 群名；未知占位符原样保留。',
  },
  modelPrompt: {
    type: 'text', default: '', group: '入群欢迎', label: '模型模式 · 风格要求',
    hint: '留空用内置提示；支持 {name} {qq} {group}。',
  },
  atNewcomer: { type: 'bool', default: true, group: '入群欢迎', label: '固定句池 @ 新人', hint: '开：欢迎语里 @ 新人（更显眼）；关：只发欢迎语、不 @。' },
  delayMs: {
    type: 'int', default: 3, unit: '秒', scale: 1000, min: 0, max: 120, step: 1,
    group: '入群欢迎', label: '延迟欢迎', hint: '入群后等几秒再发，避免"秒回"感。',
  },
  cooldownMs: {
    type: 'int', default: 10, unit: '分钟', scale: 60000, min: 0, max: 1440, step: 1,
    group: '入群欢迎', label: '同人防重复冷却', hint: '同一人同群这段时间内再入群不重复欢迎（内存记录，重启清空）。',
  },
  imageChance: {
    type: 'int', default: 100, unit: '%', scale: 0.01, min: 0, max: 100, step: 5,
    group: '入群欢迎', label: '附图概率', hint: '图片池目录里随机挑一张，作为第二条消息发；0 = 不附图。',
  },
  imageDir: {
    type: 'str', default: 'qq-welcome-images', group: '入群欢迎', label: '图片池目录',
    hint: '相对路径由内核按数据目录解析；把 png/jpg/jpeg/gif/webp 放进去即可，控制台「入群欢迎」页能看到列表。',
  },
  modelFallback: {
    type: 'bool', default: true, group: '入群欢迎', label: '模型没发话时句池兜底',
    hint: '模型模式等 modelFallbackMs 还没看到出站 → 补一句固定句池（模型回合失败时也不会哑火）。',
  },
  modelFallbackMs: {
    type: 'int', default: 45, unit: '秒', scale: 1000, min: 10, max: 300, step: 5,
    group: '入群欢迎', label: '模型兜底等待',
    hint: '模型模式下，等模型生成欢迎语最多等多久；超时就用固定句池补一句，别让新人晾着。',
  },
  modelMinGapMs: {
    type: 'int', default: 60, unit: '秒', scale: 1000, min: 0, max: 3600, step: 5, group: '入群欢迎',
    label: '模型模式同群最小间隔',
    hint: '同一群两次模型欢迎的最小间隔；太密的入群自动降级成固定句池（防批量入群烧 token）。',
  },
}

export default {
  id: 'group-welcome',
  title: '入群欢迎',
  order: 55,
  configSchema,

  setup(bot) {
    const log = bot.log
    /** 配置每次现读：控制台热改是就地改 bot.cfg，这里不能在 setup 顶部算死 */
    const cfgNow = () => bot.cfg || {}
    /** "秒"→毫秒；配置缺省/非法时用 d */
    const msOfSec = (v, d) => {
      const n = Number(v)
      return Number.isFinite(n) && n >= 0 ? Math.round(n * 1000) : d
    }

    // ── 跨轮状态：ChatState._scratch（按 chatKey 天然隔离） ───────────────
    function scratchOf(chatKey) {
      try {
        const st = bot.state?.get?.(chatKey)
        if (!st) return null
        return (st._scratch ||= Object.create(null))
      } catch {
        return null
      }
    }

    // ── 群名缓存（仅用于占位符 / 模型提示；失败静默） ─────────────────────
    let groupCache = { at: 0, map: new Map() }
    async function groupNameOf(gid) {
      const key = String(gid)
      const now = Date.now()
      if (now - groupCache.at > GROUP_NAME_TTL_MS) {
        try {
          const list = await bot.napcat?.groupList?.()
          if (Array.isArray(list) && list.length) {
            groupCache = { at: now, map: new Map(list.map((g) => [String(g.id), String(g.name || '')])) }
          } else {
            groupCache.at = now // 拿不到也退避，别每条通知都打 API
          }
        } catch (e) {
          groupCache.at = now
          log.debug(`[入群欢迎] 取群列表失败: ${e.message}`)
        }
      }
      return groupCache.map.get(key) || ''
    }

    // ── 图片池：目录 mtime 缓存（目录没变就不重复 readdir） ───────────────
    let imageCache = { dir: '', stamp: '', files: [] }
    function imageFiles() {
      const dir = String(cfgNow().imageDir || '').trim()
      if (!dir) return []
      try {
        const st = fs.statSync(dir)
        if (imageCache.dir === dir && imageCache.stamp === String(st.mtimeMs)) return imageCache.files
        const files = fs.readdirSync(dir)
          .filter((n) => IMAGE_EXTS.has(path.extname(n).toLowerCase()))
          .sort()
          .map((n) => path.join(dir, n))
        imageCache = { dir, stamp: String(st.mtimeMs), files }
        return files
      } catch (e) {
        if (e.code !== 'ENOENT') log.debug(`[入群欢迎] 图片池读取失败 ${dir}: ${e.message}`)
        return []
      }
    }
    const pickOne = (arr) => arr[Math.floor(Math.random() * arr.length)]

    // ── 文本渲染 / 选句 ───────────────────────────────────────────────────
    function render(tpl, vars) {
      return String(tpl ?? '').replace(/\{(name|qq|group)\}/g, (m, k) => (vars[k] == null ? m : String(vars[k])))
    }
    function linesOf() {
      const raw = String(cfgNow().lines ?? '')
      const lines = raw.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)
      return lines.length ? lines : DEFAULT_LINES
    }
    /** 随机挑一句并渲染；尽量不连续重复同一句（只有一句时不强求） */
    function pickLine(scratch, vars) {
      const lines = linesOf()
      const last = (scratch && scratch['welcome:lastText']) || ''
      let text = ''
      for (let i = 0; i < 6; i += 1) {
        text = render(pickOne(lines), vars)
        if (text !== last || lines.length === 1) break
      }
      if (scratch) scratch['welcome:lastText'] = text
      const unknown = text.match(/\{[a-zA-Z][a-zA-Z0-9_]*\}/g)
      if (unknown) log.debug(`[入群欢迎] 句子里有未知占位符（原样保留）: ${[...new Set(unknown)].join(' ')}`)
      return text
    }

    // ── 冷却表（scratch['welcome:cooldowns'] = { qq: ts }） ────────────────
    function cooldownsOf(scratch) {
      if (!scratch) return null
      if (!scratch['welcome:cooldowns'] || typeof scratch['welcome:cooldowns'] !== 'object') {
        scratch['welcome:cooldowns'] = Object.create(null)
      }
      return scratch['welcome:cooldowns']
    }
    function inCooldown(scratch, qq, cdMs) {
      const map = cooldownsOf(scratch)
      if (!map || !(cdMs > 0)) return false
      const k = String(qq)
      const ts = Number(map[k] || 0)
      if (!ts) return false
      if (Date.now() - ts >= cdMs) { delete map[k]; return false }
      return true
    }
    function markCooldown(scratch, qq) {
      const map = cooldownsOf(scratch)
      if (!map) return
      map[String(qq)] = Date.now()
      const keys = Object.keys(map)
      if (keys.length > MAX_COOLDOWN_ENTRIES) {
        for (const k of keys.slice(0, keys.length - MAX_COOLDOWN_ENTRIES)) delete map[k]
      }
    }
    function clearCooldown(scratch, qq) {
      const map = cooldownsOf(scratch)
      if (map) delete map[String(qq)]
    }

    // ── 固定句池发送（文字 + 可选 @ + 可选附图） ──────────────────────────
    /**
     * @returns {Promise<boolean>} true = 文字发出去了（附图失败不算失败）
     */
    async function sendFixedWelcome({ chatKey, gid, qq, name, groupName, scratch, reason }) {
      const cfg = cfgNow()
      const text = pickLine(scratch, { name: name || String(qq), qq, group: groupName || gid })
      const ats = cfg.atNewcomer !== false ? [Number(qq)] : []
      let sent = false
      try {
        await bot.deliver(chatKey, text, ats.length ? { ats } : {})
        sent = true
        log.info(`[入群欢迎] 已发固定欢迎 ${chatKey} ← ${name || qq}${reason ? `（${reason}）` : ''}`)
      } catch (e) {
        log.warn(`[入群欢迎] 固定欢迎发送失败 ${chatKey}: ${e.message}`)
      }
      // 图片单独一条：图失败只丢图，不连累文字和 @（AstrBot 版同条消息图一挂全丢）
      if (sent) {
        const pct = Math.max(0, Math.min(100, Number(cfg.imageChance) || 0))
        if (pct > 0) {
          const files = imageFiles()
          if (files.length && Math.random() * 100 < pct) {
            const file = pickOne(files)
            try {
              const r = await bot.sendMedia(chatKey, cqImage(file), '')
              log.info(`[入群欢迎] 附图 ${path.basename(file)} → ${chatKey}（${r?.messageId ?? 'ok'}）`)
            } catch (e) {
              log.warn(`[入群欢迎] 附图发送失败（已忽略）${path.basename(file)}: ${e.message}`)
            }
          }
        }
      }
      return sent
    }

    // ── 模型模式：出站观测 + 兜底定时器 ───────────────────────────────────
    /** 出站钩子：欢迎轮只要有任何一条出站，就算模型"发了"，撤掉兜底 */
    bot.onOutbound((out) => {
      if (!out || out.turnCtx?.wakeKind !== 'welcome') return
      const scratch = scratchOf(out.target)
      const pending = scratch?.['welcome:pending']
      if (!pending) return
      if (pending.timer) clearTimeout(pending.timer)
      pending.delivered = true
      delete scratch['welcome:pending']
      log.info(`[入群欢迎] 模型模式已出站 ${out.target}（${out.mode || 'text'}）`)
    })

    function scheduleModelFallback({ chatKey, gid, qq, name, groupName, scratch }) {
      if (!scratch) return
      const waitMs = msOfSec(cfgNow().modelFallbackMs, 45000)
      const pending = { at: Date.now(), qq, name, delivered: false, timer: null }
      pending.timer = setTimeout(async () => {
        const cur = scratch['welcome:pending']
        if (cur !== pending) return // 已被出站钩子清掉 / 被新事件覆盖
        delete scratch['welcome:pending']
        if (cfgNow().enabled === false || cfgNow().modelFallback === false) {
          log.warn(`[入群欢迎] 模型模式 ${waitMs}ms 内没有欢迎出站，兜底已关（${chatKey}）`)
          return
        }
        log.warn(`[入群欢迎] 模型模式 ${waitMs}ms 内没有欢迎出站 → 句池兜底（${chatKey}）`)
        try {
          await sendFixedWelcome({ chatKey, gid, qq, name, groupName, scratch, reason: '模型未发话兜底' })
        } catch (e) {
          log.warn(`[入群欢迎] 兜底发送失败 ${chatKey}: ${e.message}`)
        }
      }, waitMs)
      pending.timer.unref?.()
      scratch['welcome:pending'] = pending
    }

    // ── 入群通知拦截：固定模式零 token / 模型模式合成 welcome 回合 ─────────
    bot.on('intercept', async (ev) => {
      if (ev.stopped) return
      const notice = ev._scratch?.notice
      if (!notice || notice.type !== 'group_increase') return

      const cfg = cfgNow()
      if (cfg.enabled === false) return
      if (!ev.isGroup) return
      const gid = String(ev.groupId || '')
      if (!gid) return

      // 欢迎白名单：只欢迎 groups 里勾过的群（空 = 不欢迎，显式勾选才生效，防一上线全群欢迎）；
      // '*' = 所有未被屏蔽的群（pre-gate 已挡掉群屏蔽 / 群内用户黑名单）。
      const groups = Array.isArray(cfg.groups) ? cfg.groups.map(String) : []
      if (!groups.includes(gid) && !groups.includes('*')) return

      const qq = Number(notice.userId ?? ev.sender?.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      // 自己入群：normalizeEvent 已经滤过 self，这里双保险
      if (String(qq) === String(bot.napcat?.selfId ?? '')) return

      const scratch = scratchOf(ev.chatKey)
      // 冷却：同群同人；先占位，固定模式发送失败会清掉（别让失败也吃冷却）
      if (inCooldown(scratch, qq, msOfSec(cfg.cooldownMs, 600000))) {
        log.debug(`[入群欢迎] 冷却中，跳过 ${ev.chatKey} ← ${qq}`)
        return
      }
      markCooldown(scratch, qq)

      // 昵称 / 群名查询失败都不能挡住欢迎
      let name = String(qq)
      try {
        const info = await bot.napcat?.memberInfo?.(gid, qq)
        name = String(info?.card || info?.nickname || name)
      } catch (e) {
        log.debug(`[入群欢迎] 取昵称失败 ${gid}/${qq}: ${e.message}`)
      }
      const groupName = await groupNameOf(gid)

      // ── 模式分流：模型模式下同群过密 → 本群降级固定句池（防批量入群烧 token） ──
      const gapMs = msOfSec(cfg.modelMinGapMs, 60000)
      const lastModelAt = Number(scratch?.['welcome:modelAt'] || 0)
      const wantModel = cfg.mode === 'model' && (gapMs <= 0 || Date.now() - lastModelAt >= gapMs)
      if (cfg.mode === 'model' && !wantModel) {
        log.info(`[入群欢迎] 模型模式同群最小间隔未到 → 本群改发固定句池（${ev.chatKey}）`)
      }

      if (!wantModel) {
        ev.stopped = true
        ev.stopReason = 'group-welcome:fixed'
        const delayMs = msOfSec(cfg.delayMs, 3000)
        const fire = async () => {
          if (cfgNow().enabled === false) return
          const ok = await sendFixedWelcome({ chatKey: ev.chatKey, gid, qq, name, groupName, scratch })
          if (!ok) clearCooldown(scratch, qq) // 失败不占冷却
        }
        if (delayMs > 0) {
          const t = setTimeout(() => {
            fire().catch((e) => log.warn(`[入群欢迎] 延迟发送失败: ${e.message}`))
          }, delayMs)
          t.unref?.()
        } else {
          await fire()
        }
        return
      }

      // ── 模型模式：合成一轮 welcome 回合（内核 pacing 免合批、prompt 有专用标记） ──
      if (scratch) scratch['welcome:modelAt'] = Date.now()
      ev.wake = { kind: 'welcome' }
      ev._scratch.silentFailure = true // runTurn 失败时不往群里发"出错了"，由兜底句池补
      ev.hint.push(`[入群事件:新成员「${name}」(QQ:${qq}) 加入了本群${groupName ? `（${groupName}）` : ''}]`)
      ev.hint.push(`[入群欢迎任务:调 send_message 发到 ${ev.chatKey}，写一句欢迎语；可以 @ ${qq}（at_qq）；只发一次，别提问、别调其他工具、别发表情包]`)
      const style = String(cfg.modelPrompt || '').trim() || DEFAULT_MODEL_PROMPT
      ev.hint.push(`[欢迎风格:${render(style, { name, qq, group: groupName || gid })}]`)
      log.info(`[入群欢迎] 触发模型欢迎 ${ev.chatKey} ← ${name}(${qq})`)
      if (cfg.modelFallback !== false) {
        scheduleModelFallback({ chatKey: ev.chatKey, gid, qq, name, groupName, scratch })
      }
    }, { order: 55 })
  },
}
