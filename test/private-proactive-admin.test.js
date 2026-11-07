import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import { collectSchema, readValue, writeValue } from '../admin/schema.js'

const PRIVATE_KEY = 'pacing.reply.privateChats'

test('私聊控件沿用主动接话页和总开关，默认名单为空，时间按小时读写', () => {
  const schema = collectSchema({})
  const list = schema.controls.find((c) => c.key === PRIVATE_KEY)
  assert.equal(list.type, 'qq-list')
  assert.equal(list.group, '主动接话')
  assert.deepEqual(list.value, [])
  assert.equal(schema.controls.filter((c) => c.key === 'pacing.reply.enabled').length, 1)
  for (const [field, hours] of Object.entries({ minMs: 1, maxMs: 4, unansweredMinMs: 4, unansweredMaxMs: 10, maxBackoffMs: 24 })) {
    const key = `pacing.reply.interval.${field}`
    const control = schema.controls.find((c) => c.key === key)
    assert.equal(control.group, '主动接话')
    assert.equal(control.section, undefined)
    assert.equal(control.step, 0.5)
    assert.equal(control.unit, '小时')
    assert.equal(control.value, hours)
    const raw = { pacing: { reply: { interval: { minMs: 1800000, unansweredMinMs: 1800000, maxMs: 5400000, unansweredMaxMs: 5400000, maxBackoffMs: 86400000 } } } }
    assert.equal(writeValue({}, key, 1.5, raw).stored, 5400000)
    assert.equal(readValue({}, key, raw), 1.5)
  }
  assert.equal(schema.groups.some((g) => g.name === '私聊'), false)
})

test('免打扰配置同页展示，默认23点至8点上海时间，起止相同明确为全天', () => {
  const schema = collectSchema({})
  for (const [field, value] of Object.entries({ enabled: true, start: '23:00', end: '08:00', timeZone: 'Asia/Shanghai' })) {
    const key = `pacing.reply.quietHours.${field}`
    const control = schema.controls.find((c) => c.key === key)
    assert.equal(control.group, '主动接话')
    assert.equal(control.section, '免打扰')
    assert.equal(control.value, value)
    const raw = {}
    assert.equal(writeValue({}, key, value, raw).stored, value)
    assert.equal(readValue({}, key, raw), value)
  }
  for (const field of ['start', 'end']) {
    const key = `pacing.reply.quietHours.${field}`
    assert.match(schema.controls.find((c) => c.key === key).hint, /相同表示全天免打扰/)
    for (const valid of ['00:00', '23:59', '08:00']) assert.equal(writeValue({}, key, valid).stored, valid)
    for (const invalid of ['', '8:00', '24:00', '23:60', '12:00:00', 'aa:bb', 800, null]) {
      const raw = {}
      assert.throws(() => writeValue({}, key, invalid, raw), /HH:mm/)
      assert.deepEqual(raw, {})
    }
  }
  for (const valid of ['Asia/Shanghai', 'America/New_York', 'UTC']) {
    assert.equal(writeValue({}, 'pacing.reply.quietHours.timeZone', valid).stored, valid)
  }
  for (const invalid of ['', 'Mars/Olympus', '+08:00', null]) {
    assert.throws(() => writeValue({}, 'pacing.reply.quietHours.timeZone', invalid), /时区/)
  }
})

test('随机窗只留一套主控，成对校验拒绝倒置且不修改配置', () => {
  const controls = collectSchema({}).controls
  const byKey = (key) => controls.find((c) => c.key === `pacing.reply.${key}`)
  for (const old of ['hourlyMax', 'minGapMs', 'coldSilenceMs', 'privatePolicy.minGapMs']) {
    assert.equal(byKey(old), undefined)
    assert.throws(() => writeValue({}, `pacing.reply.${old}`, 1), /白名单/)
  }
  for (const [min, max] of [['minMs', 'maxMs'], ['unansweredMinMs', 'unansweredMaxMs']]) {
    const raw = {}
    assert.throws(() => writeValue({}, `pacing.reply.interval.${min}`, 12, raw), /最小值不能大于最大值.*先提高最长/)
    assert.deepEqual(raw, {})
    writeValue({}, `pacing.reply.interval.${max}`, 14, raw)
    writeValue({}, `pacing.reply.interval.${min}`, 12, raw)
    assert.throws(() => writeValue({}, `pacing.reply.interval.${max}`, 11, raw), /最小值不能大于最大值/)
    assert.equal(readValue({}, `pacing.reply.interval.${max}`, raw), 14)
    writeValue({}, `pacing.reply.interval.${min}`, 0.5, raw)
    writeValue({}, `pacing.reply.interval.${max}`, 0.5, raw)
  }
  assert.throws(() => writeValue({}, 'pacing.reply.interval.maxBackoffMs', 5), /退避上限不能小于/)
  assert.throws(() => writeValue({}, 'pacing.reply.interval.maxMs', 25), /先调大退避上限/)
  const silence = byKey('silenceEnabled')
  assert.match(silence.label, /群聊、私聊/)
  assert.match(silence.hint, /私聊主动找话暂停/)
  assert.match(silence.hint, /群里出现新消息.*仍可能接一句/)
})

test('QQ名单支持文本或数组，保存为去重数字数组，并可清空', () => {
  for (const input of ['12345, 67890，12345\n23456', [12345, '67890', '12345', '23456']]) {
    const raw = {}
    const result = writeValue({}, PRIVATE_KEY, input, raw)
    assert.deepEqual(result.stored, [12345, 67890, 23456])
    assert.deepEqual(raw.pacing.reply.privateChats, [12345, 67890, 23456])
    assert.deepEqual(readValue({}, PRIVATE_KEY, raw), result.stored)
    assert.deepEqual(writeValue({}, PRIVATE_KEY, '', raw).stored, [])
  }
  for (const invalid of ['*', 'private:12345', '12345,abc', '-1', '0', '1.5', '1e5', '1234567890123', [1234567890123], '9007199254740992', [true], [null], {}, 12345]) {
    const raw = {}
    assert.throws(() => writeValue({}, PRIVATE_KEY, invalid, raw), /QQ/)
    assert.deepEqual(raw, {}, '校验失败不能修改配置')
  }
  assert.deepEqual(writeValue({}, PRIVATE_KEY, '1,999999999999').stored, [1, 999999999999], '接受1位和12位正整数边界')
  assert.deepEqual(writeValue({}, 'pacing.reply.groups', '12345,*').stored, ['12345', '*'], '群列表行为保持不变')
})

function clientInternals() {
  let internals
  let cursor = 0
  const state = []
  const refs = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => {
      const index = cursor++
      if (!(index in state)) state[index] = initial
      return [state[index], (value) => { state[index] = value }]
    },
    useRef: (initial) => {
      const index = cursor++
      if (!(index in refs)) refs[index] = { current: initial }
      return refs[index]
    },
  }
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('return module.exports', 'return { ctrlRow, PrivateChatsEditor, ReplyModeTab, tabDefs }')
  vm.runInNewContext(source, {
    window: { __ModuleLoader__: { load: ({ factory }) => { internals = factory(() => react) } } },
  })
  return { ...internals, renderEditor: (props) => { cursor = 0; return internals.PrivateChatsEditor(props) } }
}

function nodes(tree) {
  if (Array.isArray(tree)) return tree.flatMap(nodes)
  if (!tree || typeof tree !== 'object') return []
  return [tree, ...nodes(tree.children)]
}

function text(tree) {
  if (Array.isArray(tree)) return tree.map(text).join(' ')
  if (!tree || typeof tree !== 'object') return tree == null ? '' : String(tree)
  return text(tree.children)
}

function editorHarness(initial = []) {
  const client = clientInternals()
  const calls = []
  const control = { key: PRIVATE_KEY, type: 'qq-list', label: '私聊 QQ', value: initial }
  const props = {
    control, busy: false,
    // 模拟真实 run：吞错误，不返回 call 的成功结果。
    run: async (_label, fn) => { try { await fn() } catch {} },
    call: async (endpoint, payload) => {
      calls.push({ endpoint, value: Array.from(payload.value) })
      control.value = Array.from(payload.value)
      return { ok: true }
    },
  }
  const render = () => client.renderEditor(props)
  const input = () => nodes(render()).find((n) => n.type === 'input')
  const add = () => nodes(render()).find((n) => n.props['aria-label'] === '添加私聊 QQ')
  const enter = (extra = {}) => input().props.onKeyDown({ key: 'Enter', preventDefault() {}, ...extra })
  const type = (value) => input().props.onChange({ target: { value } })
  return { client, props, calls, render, input, add, enter, type }
}

test('QQ名单渲染专属加号编辑器，点击和回车添加数字数组，不失焦保存', async () => {
  const e = editorHarness([12345])
  assert.equal(e.client.ctrlRow(e.props.control, e.props).type, e.client.PrivateChatsEditor)
  assert.match(text(e.render()), /12345/)
  assert.equal(e.input().props.onBlur, undefined)
  e.type(' 00067890 ')
  await e.add().props.onClick()
  assert.deepEqual(e.calls, [{ endpoint: 'set', value: [12345, 67890] }])
  assert.equal(e.input().props.value, '')
  let prevented = false
  e.type('99999')
  await e.enter({ preventDefault() { prevented = true } })
  assert.equal(prevented, true)
  assert.deepEqual(e.calls[1].value, [12345, 67890, 99999])
})

test('QQ编辑器拒绝重复和无效输入，输入法回车不添加', async () => {
  const e = editorHarness([12345])
  for (const value of ['00012345', '', '0', '-1', '1.2', '1e3', '1234567890123', '123,456', '*']) {
    e.type(value)
    await e.enter()
  }
  assert.equal(e.calls.length, 0)
  e.type('67890')
  await e.enter({ isComposing: true, preventDefault() { assert.fail('IME不阻断') } })
  await e.enter({ nativeEvent: { isComposing: true } })
  await e.enter({ keyCode: 229 })
  assert.equal(e.calls.length, 0)
})

test('QQ编辑器最后一个标签可删除为空数组', async () => {
  const e = editorHarness([12345])
  const remove = nodes(e.render()).find((n) => n.props['aria-label'] === '移除私聊 QQ 12345')
  await remove.props.onClick()
  assert.deepEqual(e.calls, [{ endpoint: 'set', value: [] }])
})

test('QQ编辑器失败保留输入，busy和本地saving阻止重复写入', async () => {
  const e = editorHarness([12345])
  e.type('67890')
  for (const failure of [async () => { throw new Error('offline') }, async () => ({ ok: false, error: 'denied' }), async () => undefined]) {
    e.props.call = failure
    await e.add().props.onClick()
    assert.equal(e.input().props.value, '67890')
  }
  e.props.busy = true
  e.props.call = async () => { assert.fail('busy不能写入') }
  await e.enter()
  await nodes(e.render()).find((n) => n.props['aria-label'] === '移除私聊 QQ 12345').props.onClick()
  assert.equal(e.add().props.disabled, true)
  e.props.busy = false
  let resolve
  let count = 0
  e.props.call = () => { count++; return new Promise((done) => { resolve = done }) }
  const staleButton = e.add()
  const pending = staleButton.props.onClick()
  await staleButton.props.onClick()
  await e.enter()
  assert.equal(count, 1)
  assert.equal(e.input().props.disabled, true)
  resolve({ ok: true })
  await pending
  assert.equal(e.input().props.value, '')
})

test('同页展示私聊状态与私聊recent；旧后端缺privateChats仍可渲染', () => {
  const { ReplyModeTab, tabDefs } = clientInternals()
  const schema = collectSchema({})
  const reply = {
    enabled: true,
    groups: [{ chatKey: 'group:88888', groupId: '88888', unanswered: 3, nextAt: Date.now() + 3600000 }],
    privateChats: [{ chatKey: 'private:12345', userId: '12345', unanswered: 2, nextAt: Date.now() + 43200000, lastAt: Date.now(), lastSent: false }],
    recent: [{ at: Date.now(), chatKey: 'private:12345', isGroup: false, userId: '12345', groupId: null, sent: false }],
  }
  const rendered = text(ReplyModeTab({ schema, status: { reply } }))
  assert.match(rendered, /群 88888/)
  assert.match(rendered, /连续未回复 3 次/)
  assert.doesNotMatch(rendered, /本小时|快速档位|每小时最多|undefined 次/)
  assert.match(rendered, /刷新页面不会重抽/)
  const customized = text(ReplyModeTab({ schema, status: { reply: { ...reply, interval: { minMs: 1800000, maxMs: 7200000, unansweredMinMs: 7200000, unansweredMaxMs: 21600000, maxBackoffMs: 43200000 } } } }))
  assert.match(customized, /正常 0.5–2 小时，未回复 2–6 小时，持续未回复退避上限 12 小时/)
  assert.match(rendered, /私聊 QQ 12345/)
  assert.match(rendered, /连续未回复 2 次/)
  assert.match(rendered, /下次机会/)
  assert.match(rendered, /未发送/)
  assert.doesNotMatch(rendered, /模型判断没发/)
  const pausedSchema = collectSchema({}, { pacing: { reply: { silenceEnabled: false } } })
  assert.match(text(ReplyModeTab({ schema: pausedSchema, status: { reply } })), /下次机会 冷场找话已暂停/)
  assert.match(text(ReplyModeTab({ schema, status: { reply: { ...reply, enabled: false } } })), /下次机会 总开关已关闭/)
  const quietRendered = text(ReplyModeTab({ schema, status: { reply: { ...reply, quietHours: { active: true, enabled: true } } } }))
  assert.match(quietRendered, /当前免打扰：群聊主动接话、群聊续聊和私聊找话已暂停/)
  assert.match(quietRendered, /正常回复不受影响/)
  assert.match(quietRendered, /下次机会 免打扰中/)
  assert.match(text(ReplyModeTab({ schema, status: { reply: { ...reply, quietHours: { active: false, enabled: true } } } })), /当前不在免打扰时段/)
  assert.match(text(ReplyModeTab({ schema, status: { reply: { ...reply, quietHours: { active: false, enabled: false } } } })), /主动接话免打扰已关闭/)
  assert.match(rendered, /私聊12345/)
  assert.doesNotMatch(rendered, /群null|群undefined/)
  assert.match(text(ReplyModeTab({ schema, status: { reply: { groups: [] } } })), /还没有允许主动找话的私聊/)
  assert.equal(tabDefs(schema).filter((t) => t.label === '主动接话').length, 1)
  assert.equal(tabDefs(schema).some((t) => t.label === '私聊'), false)
})
