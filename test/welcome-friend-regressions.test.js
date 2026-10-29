import { test } from 'node:test'
import assert from 'node:assert/strict'
import welcome from '../plugins/group-welcome/index.js'
import friendGate from '../plugins/private-friend-gate/index.js'
import { createTurnContext } from '../contracts.js'
import { createDeliver } from '../kernel/state-pipeline.js'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

function harness(plugin, config = {}) {
  const hooks = {}, disposers = [], afterSend = [], sent = [], states = new Map()
  const cfg = Object.fromEntries(Object.entries(plugin.configSchema).map(([k, v]) => [k, v.default]))
  Object.assign(cfg, config)
  const bot = {
    cfg, log: { info() {}, warn() {}, debug() {} },
    state: { get(key) { if (!states.has(key)) states.set(key, { _scratch: {} }); return states.get(key) } },
    onebot: { memberInfo: async () => ({ nickname: 'Newcomer' }), groupList: async () => [] },
    on(stage, fn) { hooks[stage] = fn }, onAfterSend(fn) { afterSend.push(fn) },
    onDispose(fn) { disposers.push(fn) },
    async deliver(target, text) { sent.push({ target, text }) },
    async sendMedia() { sent.push({ media: true }) },
  }
  plugin.setup(bot)
  return { bot, hooks, sent, afterSend, dispose() { disposers.forEach(fn => fn()) } }
}
function notice(qq = 40001) {
  return { chatKey: 'group:20001', groupId: 20001, isGroup: true, hint: [],
    sender: { qq }, _scratch: { notice: { type: 'group_increase', userId: qq } } }
}
function welcomeHarness(t, cfg = {}) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 1_000_000 })
  const h = harness(welcome, { groups: ['*'], delayMs: 0, imageChance: 0, ...cfg })
  t.after(() => h.dispose())
  return h
}
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve() }

test('welcome: dispose cancels fixed-delay and all model fallback timers', async t => {
  const h = welcomeHarness(t, { delayMs: 3 })
  await h.hooks.intercept(notice())
  h.bot.cfg.mode = 'model'
  h.bot.cfg.modelMinGapMs = 0
  await h.hooks.intercept(notice(40002))
  await h.hooks.intercept(notice(40003))
  h.dispose()
  t.mock.timers.tick(100_000)
  await flush()
  assert.deepEqual(h.sent, [])
  assert.equal(h.bot.state.get('group:20001')._scratch['welcome:pending'], undefined)
})

test('welcome: unloaded member lookup cannot resume sending', async t => {
  const h = welcomeHarness(t)
  let resolve
  h.bot.onebot.memberInfo = () => new Promise(r => { resolve = r })
  const work = h.hooks.intercept(notice())
  h.dispose()
  resolve({ nickname: 'Newcomer' })
  await work
  assert.deepEqual(h.sent, [])
})

test('welcome: dispose during fixed text send prevents its follow-up image', async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-welcome-lifecycle-'))
  const image = path.join(dir, 'welcome.png')
  fs.writeFileSync(image, 'test image')
  t.after(() => {
    fs.unlinkSync(image)
    fs.rmdirSync(dir)
  })
  const h = welcomeHarness(t, { imageChance: 100, imageDir: dir })
  let resolve
  h.bot.deliver = () => new Promise(r => { resolve = r })
  const work = h.hooks.intercept(notice())
  await flush()
  assert.equal(typeof resolve, 'function')
  h.dispose()
  resolve({ messageId: 1 })
  await work
  assert.deepEqual(h.sent, [])
})

test('welcome: cooldown is minutes, expires exactly at ten minutes', async t => {
  const h = welcomeHarness(t, { cooldownMs: 10 })
  await h.hooks.intercept(notice())
  t.mock.timers.tick(599_000)
  await h.hooks.intercept(notice())
  assert.equal(h.sent.length, 1)
  t.mock.timers.tick(1_000)
  await h.hooks.intercept(notice())
  assert.equal(h.sent.length, 2)
})

test('welcome: only successful same-target same-turn sends cancel their own fallback', async t => {
  const h = welcomeHarness(t, { mode: 'model', modelMinGapMs: 0, modelFallbackMs: 45 })
  const first = notice(), second = notice(40002)
  await h.hooks.intercept(first)
  await h.hooks.intercept(second)
  const turn = createTurnContext(first)
  h.afterSend[0]({ target: 'group:20002', turnCtx: turn })
  h.afterSend[0]({ target: first.chatKey, turnCtx: { wakeKind: 'welcome' } })
  const deliver = createDeliver({ onebot: { async sendMessage() { return 123 } }, log: h.bot.log })
  deliver.onAfterSend(h.afterSend[0])
  await deliver(first.chatKey, 'Model welcome', { turnCtx: turn })
  t.mock.timers.tick(45_000)
  await flush()
  assert.equal(h.sent.length, 1, 'second fallback survives first turn success')
  assert.match(h.sent[0].text, /Newcomer/)
  h.afterSend[0]({ target: second.chatKey, turnCtx: createTurnContext(second) })
  h.dispose()
  h.afterSend[0]({ target: first.chatKey, turnCtx: turn })
})

test('welcome: failed model transmission leaves fallback armed; fixed failure permits retry', async t => {
  const h = welcomeHarness(t, { mode: 'model', modelFallbackMs: 45 })
  const ev = notice()
  await h.hooks.intercept(ev)
  const deliver = createDeliver({
    onebot: { async sendMessage() { throw new Error('transport failed') } }, log: h.bot.log,
  })
  deliver.onAfterSend(h.afterSend[0])
  await assert.rejects(deliver(ev.chatKey, 'Model welcome', { turnCtx: createTurnContext(ev) }), /transport failed/)
  t.mock.timers.tick(45_000)
  await flush()
  assert.equal(h.sent.length, 1)
  h.bot.cfg.mode = 'fixed'
  h.bot.deliver = async () => { throw new Error('transport failed') }
  await h.hooks.intercept(notice(40002))
  h.bot.deliver = async (target, text) => { h.sent.push({ target, text }) }
  await h.hooks.intercept(notice(40002))
  assert.equal(h.sent.length, 2)
})

function privateEvent(qq = 40001) { return { sender: { qq }, _scratch: {}, isGroup: false } }
test('friend gate: strict cold start stays closed, single flight refresh unlocks friend only', async t => {
  const h = harness(friendGate, { failOpen: false })
  t.after(() => h.dispose())
  let resolve, calls = 0
  h.bot.onebot.friendList = () => { calls++; return new Promise(r => { resolve = r }) }
  const first = privateEvent(), next = privateEvent()
  h.hooks['pre-gate'](first)
  h.hooks['pre-gate'](next)
  assert.equal(first.stopped, true)
  assert.equal(next.stopped, true)
  assert.equal(calls, 1)
  resolve([{ qq: 40001 }])
  await flush()
  const friend = privateEvent(), stranger = privateEvent(40002)
  h.hooks['pre-gate'](friend)
  h.hooks['pre-gate'](stranger)
  assert.equal(friend.stopped, undefined)
  assert.equal(stranger.stopped, true)
})

test('friend gate: strict stale cache recovers after failure retry; disposal ignores late response', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 })
  const h = harness(friendGate, { failOpen: false })
  t.after(() => h.dispose())
  h.bot.state.privateFriendGate = { at: 1, ids: new Set([40001]), failedAt: 0 }
  let calls = 0
  h.bot.onebot.friendList = async () => { calls++; return [] }
  // Advance beyond the maximum stale age.
  t.mock.timers.setTime(3_000_000)
  const stale = privateEvent()
  h.hooks['pre-gate'](stale)
  assert.equal(stale.stopped, true)
  await flush()
  h.hooks['pre-gate'](privateEvent())
  assert.equal(calls, 1)
  t.mock.timers.setTime(3_060_000)
  h.bot.onebot.friendList = async () => [{ user_id: 40001 }]
  h.hooks['pre-gate'](privateEvent())
  await flush()
  const recovered = privateEvent()
  h.hooks['pre-gate'](recovered)
  assert.equal(recovered.stopped, undefined)
  t.mock.timers.setTime(5_000_000)
  let resolve
  h.bot.onebot.friendList = () => new Promise(r => { resolve = r })
  h.hooks['pre-gate'](privateEvent())
  h.dispose()
  resolve([{ qq: 40002 }])
  await flush()
  assert.equal(h.bot.state.privateFriendGate.ids.has(40001), true)
  assert.equal(h.bot.state.privateFriendGate.ids.has(40002), false)
})
