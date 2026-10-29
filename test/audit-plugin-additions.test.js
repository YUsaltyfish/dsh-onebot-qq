/**
 * test/audit-plugin-additions.test.js — 防刷屏与私聊好友门禁行为测试。
 *
 * 覆盖：
 *   · anti-repeat：指纹归一化 + 同句超限 → 甩一句 + 冷却（冷却期静默）
 *   · private-friend-gate：好友放行 / 陌生人拦下 / 主人永远放行
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import {
  bootKernel, emitRaw, tapInbound, waitFor,
  ADMIN_QQ, MEMBER_QQ, groupAtEvent, privateEvent,
} from './helpers.mjs'
import { fingerprint } from '../plugins/anti-repeat/index.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const mergeOff = { pacing: { merge: { enabled: false } } }

// ── anti-repeat ────────────────────────────────────────────────
test('ANTI-REPEAT 指纹归一化：空白/标点/全角/连续重复字都算同一句', () => {
  assert.equal(fingerprint('好好好！！！'), fingerprint('好'))
  assert.equal(fingerprint('在吗？'), fingerprint('在吗'))
  assert.equal(fingerprint('  ＡＢＣ  '), fingerprint('abc'))
  assert.equal(fingerprint('哈哈哈 哈哈哈'), fingerprint('哈'))
  assert.equal(fingerprint('🎉🎉'), '')
})

test('ANTI-REPEAT 同句超限 → 甩一句 + 整条线冷却；冷却期静默', async (t) => {
  const h = await bootKernel({
    config: {
      ...mergeOff,
      pluginConfig: { 'anti-repeat': { repeatLimit: 2, cooldownMin: 1, notice: '别刷了' } },
    },
  })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  const send = (id) => emitRaw(h.kernel, groupAtEvent({ text: '在吗在吗', messageId: id }))

  await send(1)
  await waitFor(() => h.ctx._prompts.length === 1, { label: '第 1 次进模型' })
  await send(2)
  await waitFor(() => h.ctx._prompts.length === 2, { label: '第 2 次进模型' })
  await send(3) // 第 3 次 > limit(2) → 甩句子 + 冷却
  await waitFor(() => h.sent.some((s) => String(s.wire).includes('别刷了')), { label: '甩句子' })
  assert.equal(tap.last().stopReason, 'anti-repeat:flood')
  assert.equal(h.ctx._prompts.length, 2, '命中后不再进模型')

  await send(4) // 冷却期：静默拦下
  await sleep(60)
  assert.equal(tap.last().stopReason, 'anti-repeat:cooldown')
  assert.equal(h.ctx._prompts.length, 2)
  assert.equal(h.sent.filter((s) => String(s.wire).includes('别刷了')).length, 1, '同窗口只甩一次')
})

// ── private-friend-gate ───────────────────────────────────────
test('PRIVATE-GATE 好友放行；陌生人拦下且不进模型', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  // 好友列表：只有非主人 MEMBER_QQ（主人本来就永远放行，这里单独验证"好友"通道）
  h.kernel.onebot.friendList = async () => [{ user_id: MEMBER_QQ }]

  // 第 1 条非阻塞刷新缓存（pre-gate 此时还不知道 → failOpen 放行）
  await emitRaw(h.kernel, privateEvent({ text: '你好', messageId: 1, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '好友第 1 条进模型' })
  await sleep(120) // 等缓存刷新

  await emitRaw(h.kernel, privateEvent({ text: '再来一句', messageId: 2, userId: 10002 }))
  await waitFor(() => h.ctx._prompts.length === 2, { label: '好友第 2 条进模型' })

  // 换一个不在好友列表里的陌生人
  await emitRaw(h.kernel, privateEvent({ text: '陌生人', messageId: 3, userId: 10003 }))
  await sleep(80)
  assert.equal(tap.last().stopReason, 'private-friend-gate:not-friend')
  assert.equal(h.ctx._prompts.length, 2, '陌生人不应进模型')
})

test('PRIVATE-GATE 主人永远放行（即使好友列表里没有）', async (t) => {
  const h = await bootKernel({ config: mergeOff })
  t.after(() => h.dispose())
  const tap = tapInbound(h.kernel)
  h.kernel.onebot.friendList = async () => [{ user_id: MEMBER_QQ }]
  await emitRaw(h.kernel, privateEvent({ text: '主人', messageId: 1, userId: ADMIN_QQ }))
  await waitFor(() => h.ctx._prompts.length === 1, { label: '主人私聊进模型' })
})
