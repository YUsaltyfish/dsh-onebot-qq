import test from 'node:test'
import assert from 'node:assert/strict'
import { createPacing, quietHoursStatus, REPLY_DEFAULTS } from '../kernel/pacing.js'

const HOUR = 3600000
const at = (local) => Date.parse(`${local}+08:00`)
const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const settle = () => new Promise((resolve) => setImmediate(resolve))

function setup(local = '2026-11-06T22:00:00', reply = {}) {
  let now = at(local)
  const map = new Map()
  const calls = []
  const snapshots = []
  const state = { get(key) {
    if (!map.has(key)) map.set(key, { lastInboundAt: now - 24 * HOUR, lastSendAt: 0 })
    return map.get(key)
  } }
  const p = createPacing({ state, log: quiet, clock: () => now, random: () => 0,
    privateState: { 'private:12345': { baselineAt: now - 24 * HOUR, nextAt: now - HOUR } },
    onPrivateStateChange: (snapshot) => snapshots.push(snapshot) })
  const config = { enabled: true, groups: [54321], privateChats: [12345],
    interval: { minMs: HOUR, maxMs: HOUR }, topicMinMsgs: 1, weights: { intercept: 100 }, ...reply }
  p.apply({ reply: config })
  p.start({ onProactiveTurn: (event) => calls.push(event) })
  p.stop()
  return { p, config, calls, snapshots, set: (localTime) => { now = at(localTime) },
    tick: async () => { p.tickNow(); await settle() },
    event: () => ({ chatKey: 'group:54321', isGroup: true, groupId: '54321',
      sender: { qq: 11111 }, text: 'a meaningful message?', time: now }) }
}

test('default Shanghai overnight boundaries are start-inclusive/end-exclusive', () => {
  assert.deepEqual(REPLY_DEFAULTS.quietHours,
    { enabled: true, start: '23:00', end: '08:00', timeZone: 'Asia/Shanghai' })
  for (const [local, active] of [
    ['2026-11-06T22:59:59', false], ['2026-11-06T23:00:00', true],
    ['2026-11-07T00:00:00', true], ['2026-11-07T07:59:59', true], ['2026-11-07T08:00:00', false],
  ]) assert.equal(quietHoursStatus({}, at(local)).active, active, local)
  assert.equal(quietHoursStatus({}, at('2026-11-06T23:00:00')).endAt, at('2026-11-07T08:00:00'))
  assert.equal(quietHoursStatus({}, at('2026-11-07T07:59:59')).endAt, at('2026-11-07T08:00:00'))
})

test('disabled, daytime, all-day and custom timezone policies use one pure check', () => {
  assert.equal(quietHoursStatus({ enabled: false }, at('2026-11-07T00:00:00')).active, false)
  const daytime = { start: '09:00', end: '17:00', timeZone: 'Asia/Shanghai' }
  assert.equal(quietHoursStatus(daytime, at('2026-11-07T09:00:00')).active, true)
  assert.equal(quietHoursStatus(daytime, at('2026-11-07T17:00:00')).active, false)
  assert.equal(quietHoursStatus({ start: '08:00', end: '08:00' }, at('2026-11-07T12:00:00')).active, true)
  assert.equal(quietHoursStatus({ timeZone: 'UTC' }, Date.parse('2026-11-06T23:00:00Z')).active, true)
  assert.equal(quietHoursStatus({ timeZone: 'America/New_York' }, Date.parse('2026-11-07T04:00:00Z')).active, true)
  const fallback = quietHoursStatus({ start: 'bad', end: '25:00', timeZone: 'Mars/Olympus' }, at('2026-11-07T00:00:00'))
  assert.equal(fallback.active, true)
  assert.equal(fallback.timeZone, 'Asia/Shanghai')
})

test('endAt honors timezone daylight-saving offset changes', () => {
  const status = quietHoursStatus({ timeZone: 'America/New_York' }, Date.parse('2026-11-01T03:30:00Z'))
  assert.equal(status.active, true)
  assert.equal(status.endAt, Date.parse('2026-11-01T13:00:00Z'))
})

test('night group/private cold opportunities defer beyond morning by their own gap and persist', async () => {
  const { p, set, tick, calls } = setup('2026-11-06T23:30:00')
  await tick()
  assert.equal(p.isQuietTime(), true)
  assert.equal(calls.length, 0)
  assert.equal(p.nextOpportunityAt('group:54321'), at('2026-11-07T09:00:00'))
  assert.equal(p.nextOpportunityAt('private:12345'), at('2026-11-07T09:00:00'))
  assert.equal(p.privateStateSnapshot()['private:12345'].nextAt, at('2026-11-07T09:00:00'))
  assert.equal(p.stats().quietHours.active, true)
  set('2026-11-07T08:00:00')
  await tick()
  assert.equal(calls.length, 0)
  set('2026-11-07T09:00:00')
  await tick()
  assert.equal(calls.length, 2)
  assert.equal(calls.filter((call) => !call.isGroup).length, 1)
})

test('overdue opportunity from a skipped night tick is not replayed at 08:00', async () => {
  const { p, set, tick, calls, config } = setup('2026-11-06T22:00:00')
  // A regular reply at 22:30 schedules a private opportunity at 23:30.
  set('2026-11-06T22:30:00')
  p.noteOutbound('private:12345', { wakeKind: 'private' })
  p.apply({ reply: config })
  set('2026-11-07T08:00:00')
  await tick()
  assert.equal(calls.filter((call) => !call.isGroup).length, 0)
  assert.equal(p.nextOpportunityAt('private:12345'), at('2026-11-07T09:00:00'))
})

test('topic path stops at night even with silence disabled; regular submit still runs', async () => {
  const { p, set, event, calls, tick } = setup('2026-11-06T22:00:00', { silenceEnabled: false })
  p.consider(event())
  set('2026-11-06T23:30:00')
  p.noteInbound(event())
  p.consider(event())
  await settle()
  assert.equal(calls.length, 0)
  let replies = 0
  p.submit({ ...event(), wake: { kind: 'at' } }, () => { replies += 1 })
  p.flush('group:54321')
  assert.equal(replies, 1)
  set('2026-11-07T08:00:00')
  p.noteInbound(event())
  p.consider(event())
  await tick()
  assert.equal(calls.length, 0)
})

test('continuation chain is discarded overnight; normal replies remain unaffected', async () => {
  const { p, set, tick, event, calls } = setup('2026-11-06T22:59:00', {
    continuation: { enabled: true, delayMs: 120000, bonus: 100, minGapMs: 0 },
  })
  p.noteWake({ ...event(), wake: { kind: 'at' } })
  p.noteReplySent('group:54321', { wakeKind: 'at' })
  set('2026-11-06T23:00:00')
  p.noteInbound(event())
  await tick()
  assert.equal(calls.length, 0)
  assert.equal(p.stats().continuation.pending, 0)
  set('2026-11-07T08:00:00')
  await tick()
  assert.equal(calls.length, 0)
})

test('disabling quiet hours explicitly allows private opportunity at night', async () => {
  const { p, tick, calls } = setup('2026-11-06T23:30:00', { quietHours: { enabled: false } })
  assert.equal(p.config.reply.quietHours.start, '23:00')
  assert.equal(p.isQuietTime(), false)
  await tick()
  assert.equal(calls.filter((call) => !call.isGroup).length, 1)
})
