import test from 'node:test'
import assert from 'node:assert/strict'

import { createPacing } from '../kernel/pacing.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 只实现 pacing 需要的那一个方法（state.get） */
function fakeState() {
  const map = new Map()
  return {
    get(key) {
      const k = String(key)
      if (!map.has(k)) map.set(k, { lastSendAt: 0, lastInboundAt: 0, _scratch: Object.create(null) })
      return map.get(k)
    },
  }
}

/** 起一个可控时钟的 pacing，返回 { p, fired, advance, ev } */
function setup({ enabled = true, bonus = 1.5, groups = { 100: true } } = {}) {
  let now = Date.now()
  const fired = []
  const p = createPacing({ log: quiet, state: fakeState(), clock: () => now })
  p.apply({
    reply: {
      enabled: true,
      groups,
      sensitivity: 0.45,
      continuation: { enabled, delayMs: 120000, bonus, hourlyMax: 5, minGapMs: 300000, maxPerChain: 1, requireNewMessage: true },
    },
  })
  p.start({ onProactiveTurn: (x) => { fired.push(x); return Promise.resolve() }, isBusy: () => false })
  p.stop() // 只要回调，不要真定时器
  const ev = (over = {}) => ({
    chatKey: 'group:100', isGroup: true, groupId: '100', messageId: 1,
    text: '你们说的那个我也在看', mentionedSelf: false, time: now, ...over,
  })
  return {
    p, fired,
    advance: (ms) => { now += ms },
    ev,
  }
}

test('关闭时：真人唤醒 + 回复 + 有人说话，也不会起续聊', () => {
  const { p, fired, advance, ev } = setup({ enabled: false })
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'at' })
  advance(130000)
  p.noteInbound(ev({ text: '后来又说了一句' }))
  p.tickNow()
  assert.equal(fired.length, 0)
})

test('正常：回完话 2 分钟后有人说话 → 起一次续聊', async () => {
  const { p, fired, advance, ev } = setup()
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'at' })
  advance(121000)
  p.noteInbound(ev({ text: '后来又说了一句' }))
  p.tickNow()
  await new Promise((r) => setImmediate(r)) // 起回合是 Promise 微任务，等一拍再断言
  assert.equal(fired.length, 1)
  assert.equal(fired[0].reason, 'continuation')
  assert.ok(fired[0].humanMsgs >= 1)
})

test('没人接话：不检查（requireNewMessage）', () => {
  const { p, fired, advance, ev } = setup()
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'at' })
  advance(130000)
  p.tickNow()
  assert.equal(fired.length, 0)
})

test('一次唤醒只检查一次（maxPerChain=1），之后不会自己转', async () => {
  const { p, fired, advance, ev } = setup()
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'at' })
  advance(121000)
  p.noteInbound(ev({ text: '第一句我记下了' }))
  p.tickNow()
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 1)
  // 再来几条 + 再过 10 分钟：链已经结束，不会再起
  for (let i = 0; i < 3; i += 1) { advance(60000); p.noteInbound(ev({ text: `后续消息第 ${i} 条` })) }
  advance(600000)
  p.tickNow()
  await new Promise((r) => setImmediate(r))
  assert.equal(fired.length, 1)
})

test('合成轮（proactive/continuation）不会登记续聊链', async () => {
  const { p, fired, advance, ev } = setup()
  const e = ev({ wake: { kind: 'proactive' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'proactive' })
  advance(121000)
  p.noteInbound(ev({ text: '后来又说了一句' }))
  p.tickNow()
  assert.equal(fired.length, 0)
})

test('情境加分不够时不补（复用权重 + bonus）', () => {
  const { p, fired, advance, ev } = setup({ bonus: 0.2 })
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  p.noteReplySent('group:100', { wakeKind: 'at' })
  advance(121000)
  p.noteInbound(ev({ text: '你们说的那个我也在看' }))
  p.tickNow()
  assert.equal(fired.length, 0)
})

test('没回过话就不进检查', () => {
  const { p, fired, advance, ev } = setup()
  const e = ev({ wake: { kind: 'at' } })
  p.noteInbound(e)
  p.noteWake(e)
  advance(121000)
  p.noteInbound(ev({ text: '后来又说了一句' }))
  p.tickNow()
  assert.equal(fired.length, 0)
})
