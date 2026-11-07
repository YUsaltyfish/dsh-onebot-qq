import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'

function harness(initialRules = []) {
  let api
  let cursor = 0
  const states = [], refs = [], effects = []
  const react = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => { const i = cursor++; if (!(i in states)) states[i] = initial; return [states[i], (v) => { states[i] = v }] },
    useRef: (initial) => { const i = cursor++; if (!(i in refs)) refs[i] = { current: initial }; return refs[i] },
    useEffect: (fn) => { const i = cursor++; if (!(i in states)) { states[i] = true; effects.push(fn) } },
  }
  vm.runInNewContext(fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8').replace('return module.exports', 'return { MessageMonitor, MonitorRuleCard, tabDefs }'), {
    window: { confirm: () => false, __ModuleLoader__: { load: ({ factory }) => { api = factory(() => react) } } },
  })
  const calls = []
  let draft = { rules: null, revision: null, dirty: false }
  const props = {
    busy: false, setMonitorDraft: (v) => { draft = v },
    call: async (endpoint, payload) => {
      calls.push({ endpoint, payload: JSON.parse(JSON.stringify(payload)) })
      if (payload.op === 'list') return { ok: true, rules: initialRules, revision: 'rev-1', enabled: true }
      if (payload.op === 'save') return { ok: true, rules: payload.rules, revision: 'rev-2' }
      return { ok: true, matches: [], message: '没有命中已保存规则' }
    },
  }
  function render() { cursor = 0; return api.MessageMonitor({ ...props, monitorDraft: draft }) }
  function all(tree) { if (Array.isArray(tree)) return tree.flatMap(all); if (!tree || typeof tree !== 'object') return []; return [tree, ...all(tree.children)] }
  function text(tree) { if (Array.isArray(tree)) return tree.map(text).join(''); return tree && typeof tree === 'object' ? text(tree.children) : tree == null ? '' : String(tree) }
  const button = (label) => all(render()).find((n) => n.type === 'button' && text(n) === label)
  const input = (label) => all(render()).find((n) => n.props['aria-label'] === label)
  const cards = () => all(render()).filter((n) => n.type === api.MonitorRuleCard)
  function cardField(index, label) { const card = cards()[index]; return all(api.MonitorRuleCard(card.props)).find((n) => n.props['aria-label'] === label) }
  const change = (index, label, value) => cardField(index, label).props.onChange({ target: { value } })
  return { api, props, calls, render, text, button, input, cards, cardField, change, draft: () => draft, effects }
}
const rule = { id: 'rule-a', name: 'A', enabled: true, match: 'contains', text: 'hello', groups: [12345], instruction: 'reply', cooldownMs: 30000 }
async function loaded(rules = []) {
  const h = harness(rules)
  h.render(); h.effects.forEach((fn) => fn())
  await new Promise(setImmediate)
  h.render()
  return h
}

test('固定消息监测页不被schema重复创建，初次list后保持独立草稿', async () => {
  const h = await loaded([rule])
  assert.equal(h.api.tabDefs({ controls: [{ group: '消息监测' }] }).filter((t) => t.label === '消息监测').length, 1)
  assert.equal(h.draft().revision, 'rev-1')
  assert.equal(h.cards().length, 1)
  assert.match(h.text(h.render()), /仅监听群消息/)
  h.change(0, '监听内容', 'draft')
  h.props.status = { updated: true }
  h.render(); h.render()
  assert.equal(h.draft().rules[0].text, 'draft')
  assert.equal(h.calls.filter((c) => c.payload.op === 'list').length, 1)
})

test('规则添加删除、上下移动、匹配方式与整体保存payload', async () => {
  const h = await loaded([rule])
  h.button('添加规则').props.onClick()
  const newId = h.draft().rules[1].id
  h.change(1, '规则名称（可选）', 'B')
  h.change(1, '匹配方式', 'exact')
  h.change(1, '监听内容', 'world')
  h.change(1, '生效群号（逗号分隔，空＝不生效）', '23456, 34567,23456')
  h.change(1, '触发后指令', 'instruction')
  h.change(1, '冷却（秒）', '45')
  h.cards()[1].props.move(-1)
  assert.equal(h.draft().rules[0].id, newId)
  await h.button('保存全部规则').props.onClick()
  const saved = h.calls.find((c) => c.payload.op === 'save')
  assert.equal(saved.endpoint, 'monitor')
  assert.equal(saved.payload.expectedRevision, 'rev-1')
  assert.deepEqual(saved.payload.rules[0], { id: newId, name: 'B', enabled: true, match: 'exact', text: 'world', groups: [23456, 34567], instruction: 'instruction', cooldownMs: 45000 })
  assert.equal(h.draft().revision, 'rev-2')
  assert.equal(h.draft().dirty, false)
  h.cards()[0].props.remove(); h.cards()[0].props.remove()
  await h.button('保存全部规则').props.onClick()
  assert.deepEqual(h.calls.filter((c) => c.payload.op === 'save').at(-1).payload.rules, [])
})

test('保存失败或revision冲突保留草稿；忙碌不覆盖，空群列表保存[]', async () => {
  const h = await loaded([rule])
  h.change(0, '监听内容', 'keep-me')
  h.change(0, '生效群号（逗号分隔，空＝不生效）', '')
  for (const failure of [async () => { throw new Error('offline') }, async () => ({ ok: false, conflict: true, rules: [], revision: 'other' })]) {
    h.props.call = failure
    await h.button('保存全部规则').props.onClick()
    assert.equal(h.draft().rules[0].text, 'keep-me')
    assert.equal(h.draft().revision, 'rev-1')
    assert.equal(h.draft().dirty, true)
  }
  h.props.busy = true
  h.props.call = async () => { assert.fail('busy时不能写') }
  await h.button('保存全部规则').props.onClick()
  h.props.busy = false
  let value
  h.props.call = async (_endpoint, payload) => { value = payload; return { ok: true, rules: payload.rules, revision: 'rev-3' } }
  await h.button('保存全部规则').props.onClick()
  assert.deepEqual(Array.from(value.rules[0].groups), [])
})

test('总开关经set保存但不替换规则草稿，规则enabled独立编辑', async () => {
  const h = await loaded([rule])
  h.change(0, '监听内容', 'draft')
  h.cardField(0, '启用规则').props.onChange({ target: { checked: false } })
  await h.input('启用消息监测').props.onChange({ target: { checked: false } })
  assert.deepEqual(h.calls.at(-1), { endpoint: 'set', payload: { key: 'message-monitor.enabled', value: false } })
  assert.equal(h.draft().rules[0].text, 'draft')
  assert.equal(h.draft().rules[0].enabled, false)
  assert.equal(h.draft().enabled, false)
  assert.equal(h.draft().dirty, true)
})

test('测试只调用monitor/test且不带未保存rules，不保存不触发action', async () => {
  const h = await loaded([rule])
  h.change(0, '监听内容', 'unsaved')
  h.input('测试群号').props.onChange({ target: { value: '12345' } })
  h.input('测试消息').props.onChange({ target: { value: 'hello' } })
  await h.button('测试已保存规则').props.onClick()
  assert.deepEqual(h.calls.at(-1), { endpoint: 'monitor', payload: { op: 'test', group_id: 12345, text: 'hello' } })
  assert.equal(h.draft().rules[0].text, 'unsaved')
  assert.equal(h.draft().dirty, true)
  assert.equal(h.calls.some((c) => c.endpoint === 'action' || c.payload.op === 'save'), false)
  h.props.call = async () => ({ ok: true, message: '测试命中', matches: [{ ...rule, instruction: '第一行指令\n第二行指令' }] })
  await h.button('测试已保存规则').props.onClick()
  const displayed = h.text(h.render())
  assert.match(displayed, /测试命中/)
  assert.match(displayed, /命中规则：A（rule-a）/)
  assert.match(displayed, /匹配：包含/)
  assert.match(displayed, /监听内容：hello/)
  assert.match(displayed, /附加指令：\n第一行指令\n第二行指令/)
})
