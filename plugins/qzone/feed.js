/**
 * feed.js — 读「自己空间里已经发过的说说」（qzone 插件内部模块）
 *
 * 为什么要读：主人希望它写之前能想起**前几天写过什么**（别天天同一个调子）。
 * 状态文件里只存得到「本系统发过的」，而空间里还有更早的（测试贴、手机上发的）。
 *
 * 做法（2026-10-28 实测可用）：
 *   ① 协议端 `get_cookies` 拿机器人自己账号的 qzone cookie（NapCat 4.18 支持）；
 *   ② 用 p_skey 算 g_tk（hash33），请求 H5 的 `emotion_cgi_msglist_v6` 取说说列表；
 *   ③ 只保留最近 N 天，正文去标签、压成一行。
 *
 * 纪律：**读不到就当没有**。任何一步失败都返回空列表 + 原因，绝不让写日记这件事因此失败。
 */

const FEED_URL = 'https://h5.qzone.qq.com/proxy/domain/taotao.qq.com/cgi-bin/emotion_cgi_msglist_v6'

/** 腾讯那套 g_tk：h = 5381; h += (h<<5) + charCode; 取低 31 位 */
export function gtkOf(skey) {
  const s = String(skey || '').replace(/^@/, '')
  let h = 5381
  for (let i = 0; i < s.length; i += 1) h += (h << 5) + s.charCodeAt(i)
  return h & 0x7fffffff
}

/** cookie 串 → 键值表（同名取第一个） */
export function parseCookieHeader(header) {
  const map = {}
  for (const part of String(header || '').split(';')) {
    const i = part.indexOf('=')
    if (i <= 0) continue
    const k = part.slice(0, i).trim()
    const v = part.slice(i + 1).trim()
    if (k && !(k in map)) map[k] = v
  }
  return map
}

const stripTags = (s) => String(s || '')
  .replace(/<br\s*\/?>/gi, ' ')
  .replace(/<[^>]+>/g, '')
  .replace(/&nbsp;/g, ' ')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .replace(/&amp;/g, '&')
  .replace(/\s+/g, ' ')
  .trim()

const oneLine = (s, max) => {
  const t = stripTags(s)
  return t.length > max ? t.slice(0, max) + '…' : t
}

/** JSONP（`_Callback({...});`）→ 对象；不是 JSONP 就直接 JSON.parse */
export function parseJsonp(text) {
  const raw = String(text || '').trim()
  const a = raw.indexOf('(')
  const b = raw.lastIndexOf(')')
  const body = a >= 0 && b > a ? raw.slice(a + 1, b) : raw
  return JSON.parse(body)
}

/**
 * 取自己空间最近 `days` 天的说说。
 * @param {{onebot:object, days?:number, count?:number, log?:object, timeoutMs?:number}} opts
 * @returns {Promise<{ok:boolean, items:Array<{ts:number,text:string,pics:number,tid:string}>, reason:string}>}
 */
export async function readOwnFeed({ onebot, days = 30, count = 40, log = null, timeoutMs = 15000 } = {}) {
  const fail = (reason) => ({ ok: false, items: [], reason })
  try {
    if (typeof onebot?.callApi !== 'function') return fail('协议端不支持 callApi（读不到 cookie）')
    const res = await onebot.callApi('get_cookies', { domain: 'user.qzone.qq.com' }, timeoutMs)
    const cookies = String(res?.data?.cookies || '')
    if (!cookies) return fail('没拿到 qzone cookie（协议端未登录？）')
    const map = parseCookieHeader(cookies)
    const uin = String(map.uin || map.p_uin || '').replace(/^o/, '')
    if (!uin) return fail('cookie 里没有 uin')
    const gtk = gtkOf(map.p_skey || map.skey || '')
    const url = FEED_URL + '?uin=' + uin + '&ftype=0&sort=0&pos=0&num=' + Math.max(1, Math.min(60, Number(count) || 40))
      + '&replynum=0&g_tk=' + gtk
    const resp = await fetch(url, { headers: { Cookie: cookies, Referer: 'https://user.qzone.qq.com/' } })
    if (!resp.ok) return fail('说说接口 HTTP ' + resp.status)
    const parsed = parseJsonp(await resp.text())
    if (Number(parsed?.code) !== 0) return fail('说说接口 code=' + String(parsed?.code))
    const since = Date.now() - Math.max(1, Number(days) || 30) * 86400 * 1000
    const items = []
    for (const m of Array.isArray(parsed?.msglist) ? parsed.msglist : []) {
      const ts = Number(m?.created_time || 0) * 1000
      if (!ts || ts < since) continue
      items.push({ ts, text: oneLine(m?.content, 160), pics: Array.isArray(m?.pic) ? m.pic.length : 0, tid: String(m?.tid || '') })
    }
    items.sort((a, b) => b.ts - a.ts)
    return { ok: true, items, reason: '' }
  } catch (e) {
    try { log?.warn?.('[空间] 读自己说说失败：' + e.message) } catch { /* ignore */ }
    return fail(String(e?.message || e))
  }
}