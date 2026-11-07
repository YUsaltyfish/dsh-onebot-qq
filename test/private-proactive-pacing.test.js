import test from 'node:test'
import assert from 'node:assert/strict'
import { createPacing, REPLY_DEFAULTS } from '../kernel/pacing.js'

const HOUR = 3600000
const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const settle = () => new Promise((resolve) => setImmediate(resolve))
function setup({ reply = {}, privateState = {}, busy = () => false } = {}) {
  let now = 100 * HOUR
  const states = new Map()
  const calls = []
  const snapshots = []
  const state = { get(key) {
    if (!states.has(key)) states.set(key, { lastInboundAt: 0, lastSendAt: 0 })
    return states.get(key)
  } }
  const p = createPacing({ state, log: quiet, clock: () => now, privateState,
    onPrivateStateChange: (snapshot) => snapshots.push(snapshot) })
  p.apply({ reply: { enabled: true, quietHours: { enabled: false }, privateChats: [12345], ...reply } })
  p.start({ onProactiveTurn: (event) => calls.push(event), isBusy: busy })
  p.stop()
  return { p, calls, snapshots, state, advance: (ms) => { now += ms },
    inbound: (extra = {}) => p.noteInbound({ chatKey: 'private:12345', isGroup: false,
      time: now, sender: { qq: 12345 }, text: 'hello', ...extra }),
    tick: async () => { p.tickNow(); await settle() } }
}

test('private defaults and allowlist normalize; no history waits for startup baseline', async () => {
  assert.deepEqual(REPLY_DEFAULTS.privatePolicy, { coldSilenceMs: 4 * HOUR, minGapMs: 4 * HOUR,
    unansweredGapMs: 12 * HOUR, maxBackoffMs: 24 * HOUR })
  const { p, calls, advance, tick } = setup({ reply: { privateChats: [12345, '12345', '0012345', '1234567890123', 'invalid', -1, null] } })
  assert.deepEqual(p.allowedPrivateIds(), ['12345'])
  await tick()
  assert.equal(calls.length, 0)
  advance(4 * HOUR - 1)
  await tick()
  assert.equal(calls.length, 0)
  advance(1)
  await tick()
  assert.equal(calls.length, 1)
  assert.deepEqual(calls[0], { chatKey: 'private:12345', groupId: null, userId: '12345',
    isGroup: false, reason: 'silence', score: 1, silenceMs: 4 * HOUR, unanswered: 0 })
  assert.equal(p.stats().groups.length, 0)
  assert.equal(p.stats().recent[0].chatKey, 'private:12345')
})

test('total switch, allowlist, hourly limit and silence switch gate private turns', async () => {
  for (const reply of [{ enabled: false }, { privateChats: [] }, { silenceEnabled: false }, { hourlyMax: 0 }]) {
    const { calls, advance, tick } = setup({ reply })
    advance(48 * HOUR)
    await tick()
    assert.equal(calls.length, 0)
  }
})

test('latest real inbound and outbound restart silence, synthetic inbound does not reset unanswered', async () => {
  const { p, advance, tick, calls, inbound } = setup()
  advance(3 * HOUR)
  inbound()
  advance(3 * HOUR)
  await tick()
  assert.equal(calls.length, 0)
  p.noteOutbound('private:12345')
  advance(3 * HOUR)
  await tick()
  assert.equal(calls.length, 0)
  advance(HOUR)
  await tick()
  assert.equal(calls.length, 1)
  p.markProactiveSent('private:12345', {})
  inbound({ wake: { kind: 'proactive' } })
  inbound({ _scratch: { notice: { type: 'notify' } } })
  assert.equal(p.stats().privateChats[0].unanswered, 1)
})

test('candidate not sent consumes opportunity but not unanswered; split sends count once', async () => {
  const { p, advance, tick, calls } = setup()
  advance(4 * HOUR)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(p.stats().privateChats[0].unanswered, 0)
  await tick()
  assert.equal(calls.length, 1)
  advance(4 * HOUR)
  await tick()
  const token = {}
  p.noteOutbound('private:12345')
  p.markProactiveSent('private:12345', token)
  p.noteOutbound('private:12345')
  p.markProactiveSent('private:12345', token)
  p.markProactiveSent('private:12345')
  assert.equal(p.stats().privateChats[0].unanswered, 1)
  assert.equal(p.nextOpportunityAt('private:12345'), 120 * HOUR)
})

test('unanswered backs off 12h then 24h, stays capped without permanently stopping; real reply resets', async () => {
  const { p, advance, tick, calls, inbound } = setup()
  advance(4 * HOUR)
  await tick()
  p.markProactiveSent('private:12345', {})
  advance(12 * HOUR - 1)
  await tick()
  assert.equal(calls.length, 1)
  advance(1)
  await tick()
  assert.equal(calls[1].unanswered, 1)
  p.markProactiveSent('private:12345', {})
  for (let i = 0; i < 3; i++) {
    advance(24 * HOUR)
    await tick()
    assert.equal(calls.length, 3 + i)
    p.markProactiveSent('private:12345', {})
  }
  assert.equal(p.stats().privateChats[0].unanswered, 5)
  inbound()
  assert.equal(p.stats().privateChats[0].unanswered, 0)
  advance(4 * HOUR)
  await tick()
  assert.equal(calls.at(-1).unanswered, 0)
})

test('busy host and merge waiting slots defer opportunity rather than consume it', async () => {
  let busy = true
  const { p, advance, tick, calls } = setup({ busy: () => busy })
  advance(4 * HOUR)
  await tick()
  assert.equal(calls.length, 0)
  busy = false
  p.submit({ chatKey: 'private:12345', isGroup: false, text: 'queued', wake: { kind: 'private' } }, () => {})
  await tick()
  assert.equal(calls.length, 0)
  p.flush('private:12345')
  await tick()
  assert.equal(calls.length, 1)
  p.stop()
})

test('persisted metadata is detached, content-free, and restores backoff and next opportunity', async () => {
  const original = setup()
  original.advance(4 * HOUR)
  await original.tick()
  original.p.noteOutbound('private:12345')
  original.p.markProactiveSent('private:12345', {})
  const saved = original.p.privateStateSnapshot()
  assert.deepEqual(Object.keys(saved['private:12345']).sort(),
    ['baselineAt', 'lastInboundAt', 'lastOutboundAt', 'nextAt', 'unanswered'].sort())
  saved['private:12345'].extraText = 'must not survive'
  const restored = setup({ privateState: saved })
  assert.equal(restored.p.stats().privateChats[0].unanswered, 1)
  assert.equal(restored.p.nextOpportunityAt('private:12345'), 116 * HOUR)
  restored.advance(16 * HOUR - 1)
  await restored.tick()
  assert.equal(restored.calls.length, 0)
  restored.advance(1)
  await restored.tick()
  assert.equal(restored.calls.length, 1)
  assert.equal(restored.calls[0].unanswered, 1)
  assert.equal(restored.p.privateStateSnapshot()['private:12345'].extraText, undefined)
  saved['private:12345'].unanswered = 999
  assert.equal(original.p.privateStateSnapshot()['private:12345'].unanswered, 1)
  assert.ok(original.snapshots.length > 0)
})

test('hourly gap and hot policy increases apply immediately without persisting unlisted friends', async () => {
  const { p, advance, tick, calls, inbound } = setup({ reply: { hourlyMax: 0.1 } })
  assert.equal(p.nextOpportunityAt('private:12345'), 110 * HOUR)
  inbound({ chatKey: 'private:99999', sender: { qq: 99999 } })
  p.noteOutbound('private:99999')
  assert.equal(p.privateStateSnapshot()['private:99999'], undefined)
  p.apply({ reply: { enabled: true, quietHours: { enabled: false }, privateChats: [12345], privatePolicy: { coldSilenceMs: 6 * HOUR, minGapMs: 12 * HOUR } } })
  assert.equal(p.stats().privateChats[0].nextAt, 112 * HOUR)
  advance(10 * HOUR)
  await tick()
  assert.equal(calls.length, 0)
  advance(2 * HOUR)
  await tick()
  assert.equal(calls.length, 1)
  p.apply({ reply: { enabled: true, hourlyMax: 0, privateChats: [12345] } })
  assert.equal(p.proactiveEnabled(), false)
  assert.ok(Number.isFinite(p.privateStateSnapshot()['private:12345'].nextAt))
  p.stop()
})

test('group cold-silence shares the same fire path and respects waiting slots', async () => {
  const { p, state, advance, tick, calls } = setup({ reply: { groups: [54321], privateChats: [],
    hourlyMax: 3600, minGapMs: 1000, coldSilenceMs: 1000 } })
  state.get('group:54321').lastInboundAt = 100 * HOUR
  p.submit({ chatKey: 'group:54321', groupId: '54321', isGroup: true, text: 'queued', wake: { kind: 'at' } }, () => {})
  advance(1000)
  await tick() // waiting slot suppresses both opportunity initialization and firing
  assert.equal(calls.length, 0)
  p.flush('group:54321')
  await tick() // lazy group opportunity initialized here
  advance(1000)
  await tick()
  assert.equal(calls.length, 1)
  assert.equal(calls[0].isGroup, true)
  assert.equal(calls[0].groupId, '54321')
  p.stop()
})
