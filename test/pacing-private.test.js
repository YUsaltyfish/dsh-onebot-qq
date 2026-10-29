import test from 'node:test'
import assert from 'node:assert/strict'

import { createPacing } from '../kernel/pacing.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 只实现 pacing 需要的方法（get / keys）。seed 用来预先造好"有过对话的会话" */
function fakeState(seed = {}) {
  const map = new Map()
  for (const [k, v] of Object.entries(seed)) {
    map.set(k, { lastSendAt: 0, lastInboundAt: 0, _scratch: Object.create(null), ...v })
  }
  return {
    map,
    get(key) {
      const k = String(key)
      if (!map.has(k)) map.set(k, { lastSendAt: 0, lastInboundAt: 0, _scratch: Object.create(null) })
      return map.get(k)
    },
    keys() { return [...map.keys()] },
  }
}

/** 起一个可控时钟的 pacing（只测私聊主动接话，不装真定时器） */
function setup(opts = {}) {
  const { privateEnabledOn = true, friends = [10001, 10002], friendThrows = false, reply = {}, seed } = opts
  let now = Date.parse('2026-10-29T12:00:00+08:00')
  const fired = []
  const state = fakeState(seed)
  const p = createPacing({ log: quiet, state, clock: () => now })
  p.apply({
    reply: {
      enabled: true,
      groups: {},                       // 群一个都不开，只测私聊
      sensitivity: 0.45,
      silenceEnabled: false,            // 群冷场也关掉，确保只有私聊路径在动
      privateEnabled: privateEnabledOn,
      privateFriendsOnly: true,
      privateColdSilenceMs: 7200000,    // 2 小时
      privateHourlyMax: 1,
      privateMaxPerDay: 3,
      privateMinGapMs: 10800000,        // 3 小时
      ...reply,
    },
  })
  p.start({
    onProactiveTurn: (x) => { fired.push(x); return Promise.resolve() },
    isBusy: () => false,
    friendList: async () => {
      if (friendThrows) throw new Error('协议端超时')
      return friends.map((q) => ({ user_id: q }))
    },
  })
  p.stop()  // 只要回调，不要真定时器
  return { p, fired, state, advance: (ms) => { now += ms }, now: () => now }
}

const flush = () => new Promise((r) => setImmediate(r))
const T0900 = Date.parse('2026-10-29T09:00:00+08:00')

test('私聊主动接话：对方安静够久 → 起一轮（isGroup=false）', async () => {
  const { p, fired, advance } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].chatKey, 'private:10001')
  assert.equal(fired[0].isGroup, false)
  assert.equal(fired[0].reason, 'private-silence')
})

test('私聊主动接话：默认关 → 一次都不开口', async () => {
  const { p, fired, advance } = setup({ privateEnabledOn: false, seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(5 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('私聊主动接话：还没安静够 → 不开口', async () => {
  const { p, fired, advance } = setup({ seed: { 'private:10001': { lastInboundAt: Date.parse('2026-10-29T11:00:00+08:00') } } })
  advance(30 * 60000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('私聊主动接话：不是好友 → 不开口', async () => {
  const { p, fired, advance } = setup({ friends: [20002], seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('私聊主动接话：好友名单取不到（协议端超时）→ 宁可不开口', async () => {
  const { p, fired, advance } = setup({ friendThrows: true, seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('私聊主动接话：白名单写死了 → 只对名单里的人开口', async () => {
  const { p, fired, advance } = setup({
    reply: { privateQqs: ['10002'] },
    seed: { 'private:10001': { lastInboundAt: T0900 }, 'private:10002': { lastInboundAt: T0900 } },
  })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  assert.equal(fired[0].chatKey, 'private:10002')
})

test('私聊主动接话：每小时最多 1 次（同一小时内第二次 tick 不再开口）', async () => {
  const { p, fired, advance } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
})

test('私聊主动接话：每天最多 3 次（滚动 24 小时）', async () => {
  const { p, fired, advance, state } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  for (let i = 0; i < 5; i += 1) {
    advance(4 * 3600000)
    state.get('private:10001').lastSendAt = T0900 + (i + 1) * 4 * 3600000
    p.tickNow()
    await flush()
  }
  assert.ok(fired.length <= 3, '一天之内不该超过 3 次，实际 ' + fired.length)
  assert.ok(fired.length >= 1)
})

test('stats().private 暴露开关与最近记录', async () => {
  const { p, advance } = setup({ seed: { 'private:10001': { lastInboundAt: T0900 } } })
  advance(3 * 3600000)
  p.tickNow()
  await flush()
  const st = p.stats()
  assert.equal(st.private.enabled, true)
  assert.equal(st.private.friendsOnly, true)
  assert.equal(st.private.maxPerDay, 3)
  assert.equal(st.private.recent.length, 1)
  assert.equal(st.private.recent[0].qq, '10001')
})

test('privateAllowed 可单独查（控制台/调试用）', async () => {
  const { p } = setup({ friends: [10001] })
  assert.equal(await p.privateAllowed('10001'), true)
  assert.equal(await p.privateAllowed('99999'), false)
  assert.equal(await p.privateAllowed('abc'), false)
})
test('静默时段：到点也不主动开口（回流自 NAS）', async () => {
  const { p, fired, advance } = setup({
    reply: { quietEnabled: true, quietStart: 0, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: T0900 } },
  })
  // 把时钟拨到凌晨 3 点
  const t = Date.parse('2026-10-29T03:00:00+08:00')
  const st = Date.parse('2026-10-29T12:00:00+08:00')
  advance(t - st)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0, '静默时段内不该开口')
})

test('静默时段：跨零点区间（23 → 7）也算静默', async () => {
  const { p, fired, advance } = setup({
    reply: { quietEnabled: true, quietStart: 23, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: T0900 } },
  })
  const st = Date.parse('2026-10-29T12:00:00+08:00')
  advance(Date.parse('2026-10-29T23:30:00+08:00') - st)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 0)
})

test('静默时段关闭后：凌晨也会主动开口', async () => {
  const { p, fired, advance } = setup({
    reply: { quietEnabled: false, quietStart: 0, quietEnd: 7 },
    seed: { 'private:10001': { lastInboundAt: Date.parse('2026-10-29T00:00:00+08:00') } },
  })
  const st = Date.parse('2026-10-29T12:00:00+08:00')
  advance(Date.parse('2026-10-29T03:00:00+08:00') - st)
  p.tickNow()
  await flush()
  assert.equal(fired.length, 1)
})

test('静默时段状态在 stats 里可见', async () => {
  const { p } = setup({ reply: { quietEnabled: true, quietStart: 0, quietEnd: 7 } })
  const st = p.stats()
  assert.equal(st.quiet.enabled, true)
  assert.equal(st.quiet.start, 0)
  assert.equal(st.quiet.end, 7)
  assert.equal(typeof st.quiet.active, 'boolean')
})
