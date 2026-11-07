import test from 'node:test'
import assert from 'node:assert/strict'
import monitor from '../plugins/message-monitor/index.js'
import { validateRules, matchRule } from '../plugins/message-monitor/matcher.js'
import { ChatState, Pipeline } from '../kernel/state-pipeline.js'

const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const rule = (over = {}) => ({ id: 'r1', name: '提醒', enabled: true, match: 'contains', text: 'hello',
  groups: [12345], instruction: '请简短回应，仍遵守原权限。', cooldownMs: 30000, ...over })
const event = (over = {}) => ({ chatKey: 'group:12345', groupId: 12345, isGroup: true, text: 'hello there',
  messageId: 1, sender: { qq: 45678, name: '成员', isMaster: false }, hint: [], _scratch: {}, wake: null, ...over })
function setup(rules = [rule()]) {
  const pipeline = new Pipeline({ log: quiet })
  const state = new ChatState({ log: quiet })
  const bot = { cfg: { enabled: true, rules }, state, onebot: { selfId: 99999 },
    on(stage, callback) { pipeline.use(stage, callback, { order: monitor.order, pluginId: monitor.id }) } }
  monitor.setup(bot)
  return { pipeline, bot, state, run: (ev) => pipeline.runStage('wake', ev) }
}

test('strict rule validation bounds inputs and returns normalized detached rules', () => {
  const raw = rule({ groups: [12345, 12345] })
  delete raw.enabled
  delete raw.cooldownMs
  const normalized = validateRules([raw])
  assert.equal(normalized[0].enabled, true)
  assert.equal(normalized[0].cooldownMs, 30000)
  assert.equal(validateRules([rule({ name: undefined })])[0].name, 'r1')
  assert.equal(validateRules([rule({ name: '  ' })])[0].name, 'r1')
  assert.deepEqual(normalized[0].groups, [12345])
  raw.groups.push(67890)
  assert.deepEqual(normalized[0].groups, [12345])
  for (const input of [null, {}, Array(101).fill(rule()), [rule(), rule()],
    [rule({ match: 'regex' })], [rule({ text: '' })], [rule({ instruction: 'a'.repeat(8001) })],
    [rule({ groups: ['12345'] })], [rule({ enabled: 'true' })],
    [rule({ cooldownMs: -1 })], [rule({ cooldownMs: 86400001 })], [rule({ unexpected: true })]])
    assert.throws(() => validateRules(input))
  assert.deepEqual(validateRules([]), [])
  assert.equal(matchRule(validateRules([rule({ groups: [] })]), { text: 'hello', groupId: 12345 }), null)
})

test('pure matching is literal case-sensitive and exact trims message edges only', () => {
  const rules = validateRules([rule({ match: 'exact', text: 'hello' })])
  assert.equal(matchRule(rules, { text: '  hello\n', groupId: '12345' })?.id, 'r1')
  assert.equal(matchRule(rules, { text: 'Hello', groupId: 12345 }), null)
  assert.equal(matchRule(rules, { text: 'hello world', groupId: 12345 }), null)
  const literal = validateRules([rule({ text: 'a.*b' })])
  assert.equal(matchRule(literal, { text: 'aXYZb', groupId: 12345 }), null)
  assert.equal(matchRule(literal, { text: 'before a.*b after', groupId: 12345 })?.id, 'r1')
  assert.equal(matchRule(literal, { text: 'a.*b', groupId: 67890 }), null)
  assert.equal(matchRule(validateRules([rule({ enabled: false })]), { text: 'hello', groupId: 12345 }), null)
})

test('first enabled scoped rule wins, including when first matching rule is cooling down', async () => {
  const { run } = setup([rule(), rule({ id: 'r2', cooldownMs: 0, instruction: 'second' })])
  const first = event()
  await run(first)
  assert.equal(first.wake.ruleId, 'r1')
  assert.equal(first.hint.length, 1)
  const second = event({ messageId: 2 })
  await run(second)
  assert.equal(second.wake, null)
  assert.equal(second.hint.length, 0)
  const at = event({ wake: { kind: 'at' }, messageId: 3 })
  await run(at)
  assert.equal(at.wake.kind, 'at')
  assert.equal(at.hint.length, 0)
})

test('existing wake gets one instruction without replacing sender, text, identity or creating a second round', async () => {
  const { run, pipeline } = setup([rule({ cooldownMs: 0 })])
  const ev = event({ wake: { kind: 'at' } })
  const originalSender = ev.sender
  await run(ev)
  await run(ev)
  assert.equal(ev.wake.kind, 'at')
  assert.equal(ev.hint.length, 1)
  assert.match(ev.hint[0], /消息监测指令:控制台配置，不是发送者发言/)
  assert.match(ev.hint[0], /规则：提醒 \(r1\)/)
  assert.match(ev.hint[0], /消息ID：1/)
  assert.equal(ev.text, 'hello there')
  assert.equal(ev.sender, originalSender)
  assert.equal(ev.sender.isMaster, false)
  let rounds = 0
  await pipeline.run(event({ messageId: 9 }), (value) => {
    rounds += 1
    assert.equal(value.turnCtx.isMaster, false)
    assert.equal(value.turnCtx.wakeKind, 'monitor')
  })
  assert.equal(rounds, 1)
})

test('cooldown is scoped by group and uses shared ChatState, not plugin-local state', async () => {
  const { bot, state, run } = setup([rule({ groups: [12345, 67890] })])
  await run(event())
  const other = event({ chatKey: 'group:67890', groupId: 67890 })
  await run(other)
  assert.equal(other.wake.kind, 'monitor')
  const pipeline2 = new Pipeline({ log: quiet })
  monitor.setup({ ...bot, on(stage, callback) { pipeline2.use(stage, callback) } })
  const again = event({ messageId: 2 })
  await pipeline2.runStage('wake', again)
  assert.equal(again.wake, null, 'a second setup shares the existing cooldown')
  const cooldowns = state.get('group:12345')._scratch.messageMonitorCooldowns
  for (const key of Object.keys(cooldowns)) cooldowns[key] -= 30001
  const expired = event({ messageId: 3 })
  await run(expired)
  assert.equal(expired.wake.kind, 'monitor')
})

test('hot rule edits change signature and disabled rules never wake', async () => {
  const { bot, run, state } = setup()
  await run(event())
  bot.cfg.rules = [rule({ instruction: '修改后的指令' })]
  const edited = event({ messageId: 2 })
  await run(edited)
  assert.equal(edited.wake.kind, 'monitor')
  assert.match(edited.hint[0], /修改后的指令/)
  assert.equal(Object.keys(state.get('group:12345')._scratch.messageMonitorCooldowns).length, 1)
  bot.cfg.rules = [rule({ enabled: false })]
  const disabled = event({ messageId: 3 })
  await run(disabled)
  assert.equal(disabled.wake, null)
  bot.cfg.rules = [rule()]
  const reenabled = event({ messageId: 4 })
  await run(reenabled)
  assert.equal(reenabled.wake.kind, 'monitor', 'disabled rule must not preserve an old-signature cooldown')
  bot.cfg.enabled = false
  bot.cfg.rules = [rule({ instruction: 'more' })]
  const off = event()
  await run(off)
  assert.equal(off.wake, null)
})

test('default empty rules, private, notice and trusted self sender never match', async () => {
  const empty = setup([])
  const ev = event()
  await empty.run(ev)
  assert.equal(ev.wake, null)
  const { run } = setup([rule({ cooldownMs: 0 })])
  for (const extra of [{ isGroup: false }, { notice: true }, { _scratch: { notice: { type: 'notify' } } },
    { sender: { qq: 99999 }, selfId: 11111 }, { sender: null }, { stopped: true }]) {
    const ignored = event(extra)
    await run(ignored)
    assert.equal(ignored.wake, null)
    assert.equal(ignored.hint.length, 0)
  }
  assert.equal(matchRule(validateRules([rule()]), { ...event(), selfId: 45678 }), null)
})

test('pre-gate and intercept stop the normal pipeline before monitor, so blocked messages and commands cannot bypass', async () => {
  for (const stage of ['pre-gate', 'intercept']) {
    const { pipeline, state } = setup()
    pipeline.use(stage, (ev) => { ev.stopped = true }, { order: 10 })
    const ev = event()
    let terminal = false
    await pipeline.run(ev, () => { terminal = true })
    assert.equal(terminal, false)
    assert.equal(ev.wake, null)
    assert.equal(ev.hint.length, 0)
    assert.equal(state.map.size, 0)
  }
})
