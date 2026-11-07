import test from 'node:test'
import assert from 'node:assert/strict'
import { createPacing, quietHoursStatus } from '../kernel/pacing.js'

const HOUR = 3600000
const start = Date.parse('2026-11-07T10:00:00+08:00')
const quiet = { info() {}, error() {}, debug() {}, warn() {} }
const settle = () => new Promise((resolve) => setImmediate(resolve))
function setup({ draws = [0.5], timingState = {}, reply = {} } = {}) {
  let now = start
  let count = 0
  const map = new Map()
  const calls = []
  const snapshots = []
  const state = { get(key) {
    if (!map.has(key)) map.set(key, { lastInboundAt: 0, lastSendAt: 0 })
    return map.get(key)
  } }
  const p = createPacing({ state, log: quiet, clock: () => now, timingState,
    random: () => draws[Math.min(count++, draws.length - 1)],
    onTimingStateChange: (snapshot) => snapshots.push(snapshot) })
  const config = { enabled: true, groups: [12345], privateChats: [54321],
    quietHours: { enabled: false }, ...reply }
  p.apply({ reply: config })
  p.start({ onProactiveTurn: (event) => calls.push(event) })
  p.stop()
  const ev = (isGroup = true, extra = {}) => ({ chatKey: isGroup ? 'group:12345' : 'private:54321',
    isGroup, groupId: isGroup ? '12345' : null, sender: { qq: 99999 }, text: 'a meaningful question?', time: now, ...extra })
  return { p, state, config, calls, snapshots, ev, draws: () => count, now: () => now,
    set: (ts) => { now = ts }, advance: (ms) => { now += ms },
    tick: async () => { p.tickNow(); await settle() } }
}

test('independent per-chat draws stay persisted and stable through ticks/stats/same apply/restart', async () => {
  const h = setup({ draws: [0.25, 0.75] })
  assert.equal(h.p.nextOpportunityAt('group:12345'), start + 1.75 * HOUR)
  assert.equal(h.p.nextOpportunityAt('private:54321'), start + 3.25 * HOUR)
  assert.equal(h.draws(), 2)
  for (let i = 0; i < 4; i++) { h.p.stats(); await h.tick(); h.p.apply({ reply: h.config }); h.p.stop() }
  assert.equal(h.draws(), 2)
  const restored = setup({ timingState: h.p.timingStateSnapshot(), draws: [0] })
  assert.equal(restored.draws(), 0)
  assert.equal(restored.p.nextOpportunityAt('group:12345'), start + 1.75 * HOUR)
  assert.equal(restored.p.nextOpportunityAt('private:54321'), start + 3.25 * HOUR)
  assert.equal(h.p.stats().interval.maxMs, 4 * HOUR)
})

test('normal human reply reschedules once per turn; synthetic/ack/split do not redraw', () => {
  const h = setup()
  h.advance(HOUR)
  const token = { wakeKind: 'at' }
  h.p.noteOutbound('group:12345', token)
  const next = h.p.nextOpportunityAt('group:12345')
  const count = h.draws()
  h.advance(1000)
  h.p.noteOutbound('group:12345', token)
  for (const wakeKind of ['proactive', 'continuation', 'welcome', 'command', 'system'])
    h.p.noteOutbound('group:12345', { wakeKind })
  h.p.noteOutbound('group:12345')
  assert.equal(h.draws(), count)
  assert.equal(h.p.nextOpportunityAt('group:12345'), next)
  assert.equal(next, start + 3.5 * HOUR)
})

test('unanswered random windows widen and stay random at cap for both chat kinds', async () => {
  for (const group of [true, false]) {
    const h = setup({ draws: [0] })
    const key = group ? 'group:12345' : 'private:54321'
    const gaps = []
    for (let i = 0; i < 5; i++) {
      h.set(h.p.nextOpportunityAt(key))
      await h.tick()
      h.p.markProactiveSent(key, { wakeKind: 'proactive' })
      gaps.push(h.p.nextOpportunityAt(key) - h.now())
    }
    assert.deepEqual(gaps, [4, 8, 12, 12, 12].map((hours) => hours * HOUR))
    assert.equal(h.p.timingStateSnapshot()[key].unanswered, 5)
  }
  const upper = setup({ draws: [1] })
  upper.set(upper.p.nextOpportunityAt('private:54321'))
  await upper.tick()
  upper.p.markProactiveSent('private:54321', {})
  assert.equal(upper.p.nextOpportunityAt('private:54321') - upper.now(), 10 * HOUR)
})

test('group noise neither resets backoff nor redraws nor writes; explicit wake and private human reset', async () => {
  const h = setup({ draws: [0] })
  h.advance(HOUR)
  await h.tick()
  h.p.markProactiveSent('group:12345', {})
  h.p.markProactiveSent('private:54321', {})
  const next = h.p.nextOpportunityAt('group:12345')
  const draws = h.draws()
  const saves = h.snapshots.length
  h.advance(1000)
  h.p.noteInbound(h.ev())
  assert.equal(h.p.timingStateSnapshot()['group:12345'].unanswered, 1)
  assert.equal(h.p.nextOpportunityAt('group:12345'), next)
  assert.equal(h.draws(), draws)
  assert.equal(h.snapshots.length, saves)
  h.p.noteWake(h.ev(true, { wake: { kind: 'at' } }))
  h.p.noteInbound(h.ev(false))
  assert.equal(h.p.timingStateSnapshot()['group:12345'].unanswered, 0)
  assert.equal(h.p.timingStateSnapshot()['private:54321'].unanswered, 0)
  assert.equal(h.p.nextOpportunityAt('group:12345'), h.now() + HOUR)
  assert.equal(h.p.nextOpportunityAt('private:54321'), h.now() + HOUR)
})

test('actual split sends count once and human inbound during a candidate prevents stale unanswered', async () => {
  const h = setup({ draws: [0] })
  h.advance(HOUR)
  await h.tick()
  const token = { wakeKind: 'proactive' }
  h.advance(1000)
  h.p.noteInbound(h.ev(false))
  h.p.noteOutbound('private:54321', token)
  h.p.markProactiveSent('private:54321', token)
  const count = h.draws()
  h.p.noteOutbound('private:54321', token)
  h.p.markProactiveSent('private:54321', token)
  assert.equal(h.p.timingStateSnapshot()['private:54321'].unanswered, 0)
  assert.equal(h.draws(), count)
})

test('busy group waits for topic context while due topic still uses scoring and no-send consumes', async () => {
  const h = setup({ draws: [0], reply: { topicMinMsgs: 1, weights: { intercept: 100 } } })
  h.advance(HOUR)
  h.p.noteInbound(h.ev())
  await h.tick()
  assert.equal(h.calls.filter((call) => call.isGroup).length, 0)
  h.p.consider(h.ev())
  await settle()
  assert.equal(h.calls.filter((call) => call.isGroup).length, 1)
  assert.equal(h.p.timingStateSnapshot()['group:12345'].unanswered, 0)
  assert.equal(h.p.nextOpportunityAt('group:12345'), h.now() + HOUR)
})

test('nighttime targets project into daylight once; repeated ticks do not delay forever; all-day suppresses', async () => {
  const h = setup({ draws: [1], reply: { groups: [], quietHours: { enabled: true } } })
  h.set(Date.parse('2026-11-07T22:30:00+08:00'))
  h.p.noteOutbound('private:54321', { wakeKind: 'private' })
  const next = h.p.nextOpportunityAt('private:54321')
  assert.equal(quietHoursStatus({}, next).active, false)
  const draws = h.draws()
  for (let i = 0; i < 4; i++) { await h.tick(); h.p.stats() }
  assert.equal(h.p.nextOpportunityAt('private:54321'), next)
  assert.equal(h.draws(), draws)
  h.p.apply({ reply: { ...h.config, quietHours: { enabled: true, start: '08:00', end: '08:00' } } })
  h.p.stop()
  assert.equal(h.p.nextOpportunityAt('private:54321'), null)
  const allDayDraws = h.draws()
  h.advance(100 * HOUR)
  await h.tick()
  assert.equal(h.p.nextOpportunityAt('private:54321'), null)
  assert.equal(h.draws(), allDayDraws)
})

test('legacy knobs do not constrain scheduling; interval change resamples once', () => {
  const h = setup({ draws: [0], reply: { hourlyMax: 0, minGapMs: 99 * HOUR,
    coldSilenceMs: 99 * HOUR, privatePolicy: { minGapMs: 99 * HOUR } } })
  assert.equal(h.p.proactiveEnabled(), true)
  assert.equal(h.p.nextOpportunityAt('group:12345'), start + HOUR)
  assert.equal(h.p.config.reply.privatePolicy, undefined)
  const count = h.draws()
  h.p.apply({ reply: { ...h.config, interval: { minMs: 2 * HOUR, maxMs: 3 * HOUR } } })
  h.p.stop()
  assert.equal(h.draws(), count + 2)
  assert.equal(h.p.nextOpportunityAt('group:12345'), start + 2 * HOUR)
})
