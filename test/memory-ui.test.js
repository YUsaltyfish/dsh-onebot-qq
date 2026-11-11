import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Exercise the model-picker UI with fake React and RPC; no browser, live RPC, or production histories.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const h = (tag, props, ...children) => ({ tag, props, children: children.flat(Infinity) })
function components(react) {
  let api
  const window = { __ModuleLoader__: { load: ({ factory }) => { api = factory(() => ({ createElement: h, ...react })) } } }
  vm.runInNewContext(source.replace('return module.exports', 'return { ConsoleShell, GroupTab, OneBotTab, GroupMemory, MemoryModelPicker }'), { window })
  return api
}
function inspect(tree) {
  const nodes = []
  const visit = (n) => { if (n && typeof n === 'object') { nodes.push(n); (n.children || []).forEach(visit) } }
  visit(tree)
  return { nodes, text: JSON.stringify(tree) }
}
const controls = ['accumulateModelProvider', 'accumulateModel', 'enabled', 'accumulateEnabled', 'accumulateSchedule', 'accumulateDailyTime', 'accumulateTimezone', 'accumulateRecentDays', 'accumulateIntervalHours', 'accumulateMinNewMsgs', 'accumulateKeepDays', 'accumulateKeepRows', 'accumulateRetainRevisions'].map((key) => ({ key: 'group-memory.' + key, value: key === 'accumulateSchedule' ? 'daily' : '', group: 'memory' }))
function render(schedule = 'daily', overrides = {}, ctx = {}) {
  const cfg = controls.map((c) => c.key.endsWith('.accumulateSchedule') ? { ...c, value: schedule } : c)
  const state = [{ groups: [], accumulate: { enabled: false, schedule, timezone: 'Asia/Shanghai', pendingCount: 1, pending: [{ gid: '10001', reason: '预算不足', rows: 3, chars: 42 }], lastResult: { updated: ['10001'], failed: [{ gid: '10002', detail: 'model failed' }], skipped: [], calls: 1 }, ...overrides } }, null, true, cfg, '', false, null]
  const { GroupMemory } = components({ useState: () => [state.shift(), () => {}], useEffect() {}, useCallback: (fn) => fn })
  return inspect(GroupMemory({ ctx }))
}
test('daily controls expose time/timezone and keep legacy thresholds out of view', () => {
  const { nodes, text } = render()
  const keys = nodes.map((n) => n.props?.key).filter((key) => typeof key === 'string' && key.startsWith('group-memory.'))
  assert.ok(keys.includes('group-memory.accumulateDailyTime'))
  assert.ok(keys.includes('group-memory.accumulateTimezone'))
  assert.ok(keys.includes('group-memory.accumulateRetainRevisions'))
  assert.ok(!keys.includes('group-memory.accumulateMinNewMsgs'))
  assert.ok(!keys.includes('group-memory.accumulateIntervalHours'))
  assert.ok(!keys.includes('group-memory.accumulateKeepDays'))
  assert.ok(!keys.includes('group-memory.accumulateKeepRows'))
  for (const expected of ['待办：1', '预算不足', 'model failed', '最近更新会话', '关闭（可手动处理）']) assert.ok(text.includes(expected))
  assert.equal(nodes.find((n) => n.props?.key === 'acc').props.disabled, false)
})
test('dedicated picker replaces both old controls on the main panel and in advanced settings', () => {
  for (const mode of ['daily', 'interval']) {
    const { nodes, text } = render(mode)
    assert.equal(nodes.find((n) => n.props?.key === 'model').tag.name, 'MemoryModelPicker')
    assert.ok(!text.includes('group-memory.accumulateModelProvider'))
    assert.ok(!text.includes('group-memory.accumulateModel'))
  }
})

function renderGroup(group, ctx) {
  const schema = { controls: [{ group: 'OneBot 连接' }, { group: '生图' }] }
  const state = [schema, {}, '', false, null, null, `group:${group}`, {}]
  const { ConsoleShell, GroupTab, OneBotTab } = components({ useState: () => [state.shift(), () => {}], useEffect() {}, useCallback: (fn) => fn })
  const Component = group === 'OneBot 连接' ? OneBotTab : GroupTab
  const tab = inspect(ConsoleShell({ ctx })).nodes.find((n) => n.tag === Component)
  return inspect(Component(tab.props))
}

// Mount the actual picker passed by the page; fake only hooks/rendering and the RPC transport.
function picker(reply, scope) {
  const calls = []
  const ctx = { connection: { rpc: { async call(channel, endpoint, payload) {
    assert.equal(channel, '/qq-console')
    assert.equal(endpoint, 'memory')
    const request = JSON.parse(JSON.stringify(payload))
    calls.push(request)
    return reply(request)
  } } } }
  const tab = scope === 'chat' ? renderGroup('OneBot 连接', ctx) : render('daily', {}, ctx)
  const props = tab.nodes.find((n) => n.props?.key === 'model').props
  const state = []
  let cursor = 0
  let busy = false
  let effect
  const react = {
    useState(initial) {
      const i = cursor++
      if (i === state.length) state.push(initial)
      return [state[i], (value) => { state[i] = value }]
    },
    useEffect(fn) { effect ||= fn },
  }
  const { MemoryModelPicker: Picker } = components(react)
  const view = () => { cursor = 0; return inspect(Picker({ ...props, busy, setBusy: (value) => { busy = value } })) }
  view()
  const by = (name) => {
    const { nodes } = view()
    return nodes.find((n) => n.props?.['aria-label'] === name) || nodes.find((n) => n.children[0] === name)
  }
  return { calls, view, by, mount: async () => { effect(); await new Promise(setImmediate) },
    change: (name, value) => by(name).props.onChange({ target: { value } }),
    save: () => by(scope === 'chat' ? '保存 QQ 新会话模型' : '保存记忆模型').props.onClick(),
  }
}

const inherit = { provider: '', model: '' }
const catalogGroups = [
  { id: 'alpha', name: 'First Provider', models: [{ id: 'same-id', name: 'Fast' }, { id: 'big-id', name: 'Large' }] },
  { id: 'beta', name: 'Second Provider', models: [{ id: 'same-id', name: 'Compact' }] },
]
const envelope = (value) => ({ ok: true, value: { ok: true, ...value } })

test('catalog search groups model routes by provider, then saves a single pair or inherit', async () => {
  const ui = picker(({ op, provider, model }) => op === 'model-catalog'
    ? envelope({ available: true, groups: catalogGroups, selection: inherit })
    : envelope({ selection: { provider, model }, pending: provider === 'beta' }))
  assert.ok(ui.view().text.includes('正在读取模型目录'))
  await ui.mount()
  const groups = () => ui.view().nodes.filter((n) => n.tag === 'optgroup')
  assert.deepEqual(groups().map((n) => n.props.label), ['First Provider（alpha）', 'Second Provider（beta）'])
  assert.ok(!ui.by('提供商 ID'))
  assert.equal(ui.by('保存记忆模型').props.disabled, true)
  ui.change('搜索记忆模型', 'SECOND SAME-id')
  assert.deepEqual(groups().map((n) => n.props.label), ['Second Provider（beta）'])
  const option = ui.by('Compact（same-id）')
  ui.change('记忆整理模型', option.props.value)
  ui.change('搜索记忆模型', 'no matches')
  assert.equal(ui.by('记忆整理模型').props.value, option.props.value)
  assert.ok(ui.view().nodes.some((n) => n.tag === 'option' && n.props.value === option.props.value))
  assert.ok(ui.by('无匹配模型'))
  assert.deepEqual(ui.calls, [{ op: 'model-catalog' }])
  await ui.save()
  assert.deepEqual(ui.calls[1], { op: 'model-select', provider: 'beta', model: 'same-id' })
  assert.ok(ui.view().text.includes('实例待配置'))
  assert.equal(ui.by('保存记忆模型').props.disabled, true)
  ui.change('记忆整理模型', ui.by('继承后台任务默认模型').props.value)
  await ui.save()
  assert.deepEqual(ui.calls[2], { op: 'model-select', ...inherit })
  assert.equal(ui.calls.length, 3)
})

test('OneBot 连接 mounts the shared picker; chat saves a scoped pair or inherit without touching memory', async () => {
  const { nodes } = renderGroup('OneBot 连接', {})
  assert.ok(nodes.some((n) => n.tag.name === 'SwitchGroup'))
  assert.equal(nodes.find((n) => n.tag.name === 'MemoryModelPicker').props.scope, 'chat')
  assert.ok(!renderGroup('生图', {}).nodes.some((n) => n.tag.name === 'MemoryModelPicker'))

  const ui = picker(({ op, provider, model }) => op === 'model-catalog'
    ? envelope({ available: true, groups: catalogGroups, selection: inherit })
    : envelope({ selection: { provider, model } }), 'chat')
  await ui.mount()
  assert.match(ui.view().text, /仅影响新建的 QQ 群聊和私聊会话，已有会话、网页会话和记忆整理模型不变/)
  assert.ok(!ui.view().text.includes('最近一次模型回退'))
  ui.change('搜索 QQ 回话模型', 'beta same-id')
  ui.change('QQ 新会话模型', ui.by('Compact（same-id）').props.value)
  await ui.save()
  ui.change('QQ 新会话模型', ui.by('继承 DSH 默认模型').props.value)
  await ui.save()
  assert.deepEqual(ui.calls, [
    { op: 'model-catalog', scope: 'chat' },
    { op: 'model-select', scope: 'chat', provider: 'beta', model: 'same-id' },
    { op: 'model-select', scope: 'chat', ...inherit },
  ])
})

test('chat fallback appears as a separate status with route and time, not a changed selection', async () => {
  const at = Date.UTC(2026, 10, 10, 10)
  const fallback = { provider: 'retired-provider', model: 'retired-model', at }
  const saved = { provider: 'beta', model: 'same-id' }
  const reply = () => envelope({ available: true, groups: catalogGroups, selection: saved, fallback })
  const ui = picker(reply, 'chat')
  await ui.mount()
  const notice = ui.view().nodes.find((n) => n.props?.role === 'status' && n.children[0]?.includes('最近一次模型回退'))
  assert.ok(notice)
  for (const text of [new Date(at).toLocaleString('zh-CN'), 'retired-provider / retired-model', '改用 DSH 默认模型']) {
    assert.ok(notice.children[0].includes(text))
  }
  assert.equal(ui.by('QQ 新会话模型').props.value, JSON.stringify(['beta', 'same-id']))
  assert.equal(ui.by('保存 QQ 新会话模型').props.disabled, true)
  const memory = picker(reply)
  await memory.mount()
  assert.ok(!memory.view().text.includes('最近一次模型回退'))
})

test('empty available catalog keeps an unlisted saved pair without enabling manual entry', async () => {
  const selection = { provider: 'former', model: 'retired' }
  const ui = picker(({ op }) => op === 'model-catalog'
    ? envelope({ available: true, groups: [], selection }) : envelope({ selection: inherit }))
  await ui.mount()
  const unavailable = ui.by('当前配置不可用：former / retired')
  assert.equal(ui.by('记忆整理模型').props.value, unavailable.props.value)
  assert.ok(ui.by('目录没有可选模型'))
  assert.ok(!ui.by('提供商 ID'))
  assert.ok(!ui.by('模型 ID'))
  ui.change('记忆整理模型', '')
  ui.change('记忆整理模型', unavailable.props.value)
  assert.equal(ui.by('保存记忆模型').props.disabled, true)
  await ui.save()
  assert.deepEqual(ui.calls, [{ op: 'model-catalog' }])
})

test('explicit unavailable catalog accepts a complete manual pair and keeps the draft on save failure', async () => {
  let reject = true
  const ui = picker(({ op, provider, model }) => {
    if (op === 'model-catalog') return envelope({ available: false, groups: [], selection: inherit })
    return reject ? { ok: true, value: { ok: false, error: 'not saved' } } : envelope({ selection: { provider, model } })
  })
  await ui.mount()
  assert.ok(!ui.by('搜索记忆模型'))
  ui.change('提供商 ID', ' manual/provider ')
  assert.equal(ui.by('保存记忆模型').props.disabled, true)
  await ui.save()
  assert.equal(ui.calls.length, 1)
  ui.change('模型 ID', 'manual/model ')
  await ui.save()
  const expected = { op: 'model-select', provider: 'manual/provider', model: 'manual/model', manual: true }
  assert.deepEqual(ui.calls[1], expected)
  assert.ok(ui.by('保存模型失败：not saved'))
  assert.equal(ui.by('模型 ID').props.value, 'manual/model ')
  reject = false
  await ui.save()
  assert.deepEqual(ui.calls[2], expected)
  ui.by('改为继承默认模型').props.onClick()
  await ui.save()
  assert.deepEqual(ui.calls[3], { op: 'model-select', ...inherit })
})

test('failed catalog RPC does not enable manual entry and can be retried', async () => {
  let reject = true
  const ui = picker(() => reject ? { ok: false, error: 'offline' } : envelope({ available: true, groups: [], selection: inherit }))
  await ui.mount()
  assert.ok(ui.by('读取模型目录失败：offline'))
  assert.ok(!ui.by('提供商 ID'))
  assert.ok(!ui.by('保存记忆模型'))
  reject = false
  await ui.by('重试').props.onClick()
  assert.ok(ui.by('继承后台任务默认模型'))
  assert.deepEqual(ui.calls, [{ op: 'model-catalog' }, { op: 'model-catalog' }])
})
test('invalid configured timezone does not hide configuration or status', () => {
  const { text } = render('daily', { timezone: 'Invalid/Zone', lastRunAt: 1, nextDueAt: 60000, lastError: 'Invalid time zone' })
  assert.ok(text.includes('1970-01-01'))
  assert.ok(text.includes('Invalid time zone'))
})
test('interval mode retains legacy controls; a running round disables duplicate manual work', () => {
  const { nodes } = render('interval', { running: true })
  const keys = nodes.map((n) => n.props?.key).filter((key) => typeof key === 'string' && key.startsWith('group-memory.'))
  assert.ok(keys.includes('group-memory.accumulateIntervalHours'))
  assert.ok(keys.includes('group-memory.accumulateMinNewMsgs'))
  assert.ok(!keys.includes('group-memory.accumulateDailyTime'))
  assert.equal(nodes.find((n) => n.props?.key === 'acc').props.disabled, true)
})
