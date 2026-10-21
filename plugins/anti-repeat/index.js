/**
 * anti-repeat — 重复刷屏冷却（id: 'anti-repeat', order: 15）
 *
 * 从旧机器人（`bot.py` 的 `repeat_check` / `/群聊行为规范.md` §3.2）移植：
 * **同一句话问第 4 次 → 甩一句「怎么一直重复，我不干了！」→ 冷却 10 分钟不理人。**
 *
 * 为什么值得单独一个插件：这台机器人的每一次回话 = 一次真实模型调用（约 1 万 token）。
 * 有人连刷同一句话时，没有这道闸门就是**一路烧钱**，而且群里看起来像复读机。
 *
 * 挂 `wake` 阶段而不是 `intercept`：
 *   · `intercept` 对**没唤醒**的消息也跑，会去计数一堆本来就不打算回的闲聊；
 *   · `wake` 阶段在 gate-wake(10) 之后（本插件 order 15），此时 `ev.wake` 才是"这条真要回"。
 *
 * 三条纪律（改之前先读）：
 *   ① **指纹必须归一化再比**：去空白/标点/符号、转小写、连续同字压成一个（「好好好」「……」「？？？」
 *      都要能认出来）。精确匹配拦不住真刷屏的人。
 *   ② **计数只记"被唤醒的轮次"**：群里没人叫它的消息本来就不回，不该消耗重复额度，
 *      更不该让"大家各说各话重复了一个词"把某人封掉。
 *   ③ **冷却到点自动解**，不做累加惩罚；甩句子的动作**只做一次**（同一冷却窗口内不重复甩）。
 *
 * 状态位置：`bot.state.get(chatKey)._scratch['anti-repeat:...']`（契约纪律：插件不自己开全局 Map）。
 * 每条线（群 / 私聊）各自独立计数 —— 群里有人刷屏不影响私聊。
 */

/** 指纹归一化：旧版 `norm_text` 的等价实现（比旧版多压连续重复字符）。 */
export function fingerprint(text) {
  let t = String(text ?? '')
  // 去掉 ZeroWidth / BOM 之类肉眼不可见的字符（有人靠这个绕过重复检测）
  t = t.replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g, '')
  // 全角 → 半角（数字/字母/标点），省得「ａ」和「a」算两句
  t = t.replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
  t = t.toLowerCase()
  // 标点、符号、emoji、空格全去（\p{P} 标点 \p{S} 符号 \p{Z} 分隔）
  t = t.replace(/[\p{P}\p{S}\p{Z}\s]/gu, '')
  // 连续同字压成一个：「好好好」「哈哈哈」「滚滚滚」都归一到单字
  t = t.replace(/(.)\1+/gu, '$1')
  return t
}

/** 取本线状态槽（懒建；`bot.state` 不可用时退化为本轮内存，不影响聊天）。 */
function scratchOf(bot, chatKey) {
  const st = bot.state?.get?.(chatKey) ?? {}
  return (st._scratch ||= Object.create(null))
}

export default {
  id: 'anti-repeat',
  title: '重复刷屏冷却',
  order: 15,

  configSchema: {
    enabled: {
      type: 'bool', default: true, group: '唤醒',
      label: '重复刷屏冷却',
      hint: '开：同一个人在同一会话里连续问同一句话，超过次数就请他先停一会儿；关：不拦。'
        + '这条主要防的是"一次刷屏烧掉几十次模型调用"。',
    },
    repeatLimit: {
      type: 'int', default: 3, min: 1, max: 50, step: 1, group: '唤醒',
      label: '同一句话问几次算刷屏',
      hint: '旧机器人是 3：第 4 次（>3）才算刷屏。改小更容易拦，但也更容易误伤正常重复。',
    },
    windowMin: {
      type: 'int', default: 10, min: 1, max: 1440, step: 1, group: '唤醒',
      label: '计数窗口（分钟）',
      hint: '只统计这段时间内的重复。窗口外的老记录不算，不会"昨天说过一次今天就被拦"。',
    },
    cooldownMin: {
      type: 'int', default: 10, min: 1, max: 1440, step: 1, group: '唤醒',
      label: '刷屏后冷却（分钟）',
      hint: '命中刷屏后这段时间内不再回话（默认 10 分钟）。'
        + '别设太长：一直不回他，他会以为机器人坏了 —— 罚一下、让他冷静一下就够了。'
        + '旧机器人是 30 分钟，这里按实际体感调短了。',
    },
    notice: {
      type: 'text',
      default: '哇，怎么一直重复，我不干了！',
      group: '唤醒',
      label: '命中时甩的句子',
      hint: '命中后发这一句然后冷却（零 token，不走模型）。留空 = 干脆不吭声，直接冷却。',
    },
    silent: {
      type: 'bool', default: false, group: '唤醒',
      label: '只冷却、不吭声',
      hint: '开：命中后一句话都不发，安静地不理他（防"回一句反而帮他刷屏"）。',
    },
  },

  setup(bot) {
    const cfg = () => bot.cfg || {}
    const msOf = (min) => Math.max(60_000, (Number(min) || 1) * 60_000)

    bot.on('wake', async (ev) => {
      const c = cfg()
      if (c.enabled === false) return
      // 只处理"真要被唤醒的那一轮"；gate-wake 已决定不回的消息不计数、不打扰
      if (!ev.wake) return
      const qq = Number(ev.sender?.qq)
      if (!Number.isInteger(qq) || qq <= 0) return

      const fp = fingerprint(ev.text)
      if (!fp) return                                  // 纯图/纯表情/纯符号：不算"同一句话"
      if (fp.length < 2) return                        // 「？？」「嗯」这种单字不拦（太容易误伤）

      const now = Date.now()
      const scratch = scratchOf(bot, ev.chatKey)
      const limit = Math.max(1, Number(c.repeatLimit) || 3)
      const windowMs = msOf(c.windowMin)
      const cooldownMs = msOf(c.cooldownMin)

      // ── ① 冷却中：一句话都不回，连计数都不做（别给刷屏的人送反馈） ──
      const cd = scratch['anti-repeat:cooldown']
      if (cd && Number(cd.until) > now) {
        ev.stopped = true
        ev.stopReason = 'anti-repeat:cooldown'
        return
      }

      // ── ② 计数（按"同一个人的同一句话"）──
      const key = `${qq}\u0000${fp}`
      const table = (scratch['anti-repeat:hits'] ||= new Map())
      const hit = table.get(key)
      const count = hit && now - Number(hit.firstAt) < windowMs ? Number(hit.count) + 1 : 1
      table.set(key, { count, firstAt: hit && now - Number(hit.firstAt) < windowMs ? hit.firstAt : now, lastAt: now })
      // 顺手清掉过期条目，别让 Map 无限长（100 人群会一直有人说话）
      if (table.size > 200) {
        for (const [k, v] of table) if (now - Number(v.lastAt) > windowMs) table.delete(k)
      }

      if (count <= limit) return

      // ── ③ 超限：记冷却 → 甩一句 → 不再进模型 ──
      table.delete(key)
      scratch['anti-repeat:cooldown'] = { until: now + cooldownMs, at: now }
      bot.log.info(`[防刷屏] ${ev.chatKey} user=${qq} 同句第 ${count} 次 → 冷却 ${Math.round(cooldownMs / 60000)} 分钟`)

      if (c.silent !== true) {
        const line = String(c.notice ?? '').trim()
        if (line) {
          // 出站走唯一出口（脱敏 + 留档）；turnCtx 还没建，传 null 是 deliver 明确允许的
          try { await bot.deliver(ev.chatKey, line, { turnCtx: null }) }
          catch (e) { bot.log.warn(`[防刷屏] 甩句子失败（不影响冷却）: ${e.message}`) }
        }
      }
      ev.stopped = true
      ev.stopReason = 'anti-repeat:flood'
    })
  },
}
