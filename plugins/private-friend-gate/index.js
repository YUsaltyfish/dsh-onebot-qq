/**
 * private-friend-gate — 私聊只回好友（id: 'private-friend-gate', order: 20）
 *
 * 从旧机器人（`bot.py` 的 `private_ok` / 「群聊行为规范.md」§3.6）移植：
 * **私聊只回好友**；陌生人、临时会话一律不回（只记日志，连留档都不写）。
 *
 * 为什么是独立子插件而不是塞进 `gate-wake`：
 *   · 它自己有一份缓存、一条判定链，跟门禁/唤醒没有共享状态，拆开更容易单独开关与升级；
 *   · 这样它是**纯新增目录**，不用改动作者原有的任何文件 —— 方便整包发给作者评审。
 *
 * 两条纪律（写代码时踩过，别改回去）：
 *
 *   ① **`pre-gate` 里只查表，绝不 await 网络**。
 *      `pre-gate` 是 fail-closed 阶段（`kernel/state-pipeline.js:159-163`：插件抛错 = 这条消息被拦下）。
 *      如果在里面 await `napcat.friendList()`，NapCat 一超时就抛错 → **全部私聊被一起静默**，
 *      正是旧版特意避免的事故。所以：`passive-tap`（fail-open）负责刷新，`pre-gate` 只做纯查表。
 *
 *   ② **好友列表为空 = 拉取失败，按"不知道"放行**。
 *      `napcat.friendList()` 在异常时 catch 掉了、返回 `[]`（`kernel/napcat-adapter.js:421-431`），
 *      跟"真的没有好友"分不开。空列表一律不拦人 —— 宁可放过，也不因为 NapCat 抖一下就把所有人拉黑。
 *
 * 已知能力缺口（不是 bug，是内核没透出来）：
 *   旧版第一道闸是私聊事件的 `sub_type !== 'friend'`（临时会话是 `"group"`）。
 *   但 `kernel/format.js:445-459` 建 `ev.sender` 时只带 `qq/name/card/isMaster`，
 *   `ev` 上也没有 `sub_type` → 插件拿不到。所以这里只做"好友列表"这一道
 *   （旧版自己也说：「好友列表才是真凭据」）。
 *   行为差异：**好友从临时会话发来的消息，本插件会放行**（旧版会拦）。
 *   要补这条，需要内核把 `sub_type` 透到 `ev` 上（约 2 行），届时本插件加个判断即可。
 */

/** 好友列表缓存 TTL：与旧机器人一致（10 分钟） */
const CACHE_TTL_MS = 10 * 60 * 1000
/** 拉取失败后的重试间隔：别把 NapCat 接口打爆 */
const RETRY_MS = 60 * 1000
/** 缓存"彻底过期"的上限：超过 3 个 TTL 还没刷新成功，就当不知道（放行） */
const STALE_MS = CACHE_TTL_MS * 3

/**
 * 缓存放 `bot.state`（所有子插件共享的那一个对象），**不开模块级 Map**：
 * 契约纪律是"插件不自己开全局状态"；放 state 上控制台/排障脚本也看得到。
 * 键名带插件前缀，避免跟 gate-wake 的 `runtimeIgnore` 之类撞车。
 */
function cacheOf(bot) {
  const st = bot.state
  if (!st || typeof st !== 'object') return null
  return (st.privateFriendGate ||= { at: 0, ids: new Set(), failedAt: 0 })
}

const toNumList = (v) => {
  if (Array.isArray(v)) return v.map(Number).filter((n) => Number.isInteger(n) && n > 0)
  return String(v ?? '')
    .split(/[,，\s]+/)
    .map((s) => Number(s))
    .filter((n) => Number.isInteger(n) && n > 0)
}

export default {
  id: 'private-friend-gate',
  title: '私聊只回好友',
  order: 20,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '门禁',
      label: '私聊只回好友',
      hint: '开：私聊只回好友列表里的人，陌生人 / 临时会话一律不回（只记日志，连上下文都不写）。'
        + '关：谁私聊都回。',
    },
    allowList: {
      type: 'group', default: [], group: '门禁',
      label: '额外放行的 QQ（不是好友也让聊）',
      hint: 'QQ 号列表（逗号分隔）。比如自己的小号、还没通过好友验证的人。'
        + '主人私聊本来就永远放行，不用写在这里。',
    },
    failOpen: {
      type: 'bool', default: true, group: '门禁',
      label: '好友列表拉不到时放行',
      hint: '建议保持开。关掉的话，NapCat 一卡住、好友列表拉不到，**所有私聊都会被静默**——'
        + '那是最难排查的故障。',
    },
    cacheMin: {
      type: 'int', default: 10, min: 1, max: 120, step: 1, group: '门禁',
      label: '好友列表缓存（分钟）',
      hint: '隔多久重新拉一次 NapCat 的好友列表。太短会给 NapCat 添压力，太长则刚加的好友要等一会儿才认。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const ttl = () => Math.max(60_000, (Number(cfg().cacheMin) || 10) * 60_000)

    /** 只查缓存，**不发请求**（给 fail-closed 的 pre-gate 用）。 */
    function verdict(qq) {
      const slot = cacheOf(bot)
      if (!slot || !slot.at) return 'unknown'                 // 还没成功拉过 → 不知道
      if (Date.now() - slot.at > Math.max(STALE_MS, ttl() * 3)) return 'unknown'   // 太久没刷新
      return slot.ids.has(Number(qq)) ? 'friend' : 'stranger'
    }

    /**
     * 刷新好友列表（fail-open）。**绝不抛**：失败只记日志 + 负缓存。
     */
    async function refresh() {
      const slot = cacheOf(bot)
      if (!slot) return
      const now = Date.now()
      if (slot.at && now - slot.at < ttl()) return
      if (slot.failedAt && now - slot.failedAt < RETRY_MS) return
      try {
        const list = await bot.napcat?.friendList?.()
        const ids = new Set((Array.isArray(list) ? list : [])
          .map((f) => Number(f?.qq ?? f?.user_id))
          .filter((n) => Number.isInteger(n) && n > 0))
        if (!ids.size) {
          // 空 = 拉取失败（adapter 把异常吞成 []）或真没好友 —— 两种都别拦人
          slot.failedAt = now
          bot.log.debug('[私聊门禁] 好友列表为空（或拉取失败）→ 本轮放行')
          return
        }
        slot.ids = ids
        slot.at = now
        slot.failedAt = 0
        bot.log.debug(`[私聊门禁] 好友列表已刷新：${ids.size} 人`)
      } catch (e) {
        slot.failedAt = now
        bot.log.warn(`[私聊门禁] 好友列表刷新失败（本轮放行）: ${e.message}`)
      }
    }

    // ── ① passive-tap：刷新缓存（fail-open，绝不阻塞主链） ──
    bot.on('passive-tap', (ev) => {
      if (cfg().enabled === false) return
      if (ev.isGroup) return
      refresh().catch(() => {})
    })

    // ── ② pre-gate：纯查表判定（fail-closed 阶段，所以这里不许有 await） ──
    bot.on('pre-gate', (ev) => {
      if (cfg().enabled === false) return
      if (ev.isGroup) return
      if (ev._scratch?.notice) return                  // 通知事件不是"某个人发的消息"
      const qq = Number(ev.sender?.qq)
      if (!Number.isInteger(qq) || qq <= 0) return
      if (ev.sender?.isMaster === true) return          // 主人永远放行
      if (toNumList(cfg().allowList).includes(qq)) return

      const v = verdict(qq)
      if (v === 'friend') return
      if (v === 'unknown') {
        if (cfg().failOpen !== false) {
          bot.log.debug(`[私聊门禁] 好友列表未就绪，${qq} 本轮放行`)
          return
        }
        return stop(ev, `好友列表未就绪，按配置拦下 ${qq}`)
      }
      return stop(ev, `私聊非好友 ${qq}（只回好友）`)
    })

    /** 拦下：不回、不进模型、不写留档（pre-gate 的 stopped 语义） */
    function stop(ev, why) {
      bot.log.info(`[私聊门禁] ${why}`)
      ev.stopped = true
      ev.stopReason = 'private-friend-gate:not-friend'
    }
  },
}
