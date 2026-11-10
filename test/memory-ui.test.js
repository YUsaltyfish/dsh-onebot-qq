import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

// Exercise only the memory component; no browser, live RPC, or production histories.
const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
const component = source.slice(source.indexOf('\t\tfunction GroupMemory(props)'), source.indexOf('\n\t\tfunction apply(ctx)'))
const controls = ['accumulateModelProvider', 'accumulateModel', 'enabled', 'accumulateEnabled', 'accumulateSchedule', 'accumulateDailyTime', 'accumulateTimezone', 'accumulateRecentDays', 'accumulateIntervalHours', 'accumulateMinNewMsgs', 'accumulateKeepDays', 'accumulateKeepRows', 'accumulateRetainRevisions'].map((key) => ({ key: 'group-memory.' + key, value: key === 'accumulateSchedule' ? 'daily' : '', group: 'memory' }))
function render(schedule = 'daily', overrides = {}) {
  const cfg = controls.map((c) => c.key.endsWith('.accumulateSchedule') ? { ...c, value: schedule } : c)
  const state = [{ groups: [], accumulate: { enabled: false, schedule, timezone: 'Asia/Shanghai', pendingCount: 1, pending: [{ gid: '10001', reason: '预算不足', rows: 3, chars: 42 }], lastResult: { updated: ['10001'], failed: [{ gid: '10002', detail: 'model failed' }], skipped: [], calls: 1 }, ...overrides } }, null, true, cfg, '', false, null]
  const h = (tag, props, ...children) => ({ tag, props, children: children.flat(Infinity) })
  const sandbox = { react: { useState: () => [state.shift(), () => {}], useEffect() {}, useCallback: (fn) => fn }, h, S: {}, SM: { item() {} }, ctrlRow: (c) => h('control', { key: c.key }), CHANNEL: 'test' }
  const tree = vm.runInNewContext(component + '\nGroupMemory({ctx:{}})', sandbox)
  const nodes = []
  const visit = (n) => { if (n && typeof n === 'object') { nodes.push(n); (n.children || []).forEach(visit) } }
  visit(tree)
  return { nodes, text: JSON.stringify(tree) }
}
test('daily controls expose time/timezone and keep legacy thresholds out of view', () => {
  const { nodes, text } = render()
  const keys = nodes.filter((n) => n.tag === 'control').map((n) => n.props.key)
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
test('dedicated memory model pair stays on main panel in both schedule modes', () => {
  for (const mode of ['daily', 'interval']) {
    const { nodes, text } = render(mode)
    const model = nodes.find((n) => n.props?.key === 'model')
    assert.ok(model)
    const fields = model.children.filter((n) => n?.tag === 'control').map((n) => n.props.key)
    assert.deepEqual(fields, ['group-memory.accumulateModelProvider', 'group-memory.accumulateModel'])
    const advanced = nodes.find((n) => n.props?.key === 'cfg')
    assert.ok(!JSON.stringify(advanced).includes('group-memory.accumulateModelProvider'))
    for (const hint of ['不改变 QQ 聊天模型', '同时留空', '必须成对填写', '不会静默换用其他模型']) assert.ok(text.includes(hint))
    assert.ok(!text.includes('opencode-go'))
  }
})
test('invalid configured timezone does not hide configuration or status', () => {
  const { text } = render('daily', { timezone: 'Invalid/Zone', lastRunAt: 1, nextDueAt: 60000, lastError: 'Invalid time zone' })
  assert.ok(text.includes('1970-01-01'))
  assert.ok(text.includes('Invalid time zone'))
})
test('interval mode retains legacy controls; a running round disables duplicate manual work', () => {
  const { nodes } = render('interval', { running: true })
  const keys = nodes.filter((n) => n.tag === 'control').map((n) => n.props.key)
  assert.ok(keys.includes('group-memory.accumulateIntervalHours'))
  assert.ok(keys.includes('group-memory.accumulateMinNewMsgs'))
  assert.ok(!keys.includes('group-memory.accumulateDailyTime'))
  assert.equal(nodes.find((n) => n.props?.key === 'acc').props.disabled, true)
})
