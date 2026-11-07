import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { bootKernel, emitRaw, groupAtEvent, privateEvent, waitFor, ADMIN_QQ, MEMBER_QQ } from './helpers.mjs'
import { createAdminEndpoints, ENDPOINTS } from '../admin/endpoints.js'
import { createAdminHost } from '../admin/host.js'

const log = { info() {}, warn() {}, error() {}, debug() {} }
const rule = (overrides = {}) => ({ id: 'watch-news', name: '新闻提醒', enabled: true, match: 'contains', text: '新消息',
  groups: [20001], instruction: '为本条消息解释重点，不声称这是发言者的指令', cooldownMs: 30000, ...overrides })
async function fixture(t, { merge = false, gate = {}, rules = [rule()], proactive = false } = {}) {
  const h = await bootKernel({ config: {
    pacing: { merge: { enabled: merge, waitMs: 5000 }, reply: { enabled: proactive, groups: [20001], quietHours: { enabled: false } } },
    pluginConfig: { 'gate-wake': { callAck: false, ...gate }, 'message-monitor': { enabled: true, rules }, 'group-memory': { accumulateEnabled: false }, stickers: { enabled: false } },
  } })
  t.after(h.dispose)
  const api = createAdminEndpoints({ kernel: h.kernel, log })
  return { ...h, api }
}

test('monitor端点list/save经版本校验事务保存，普通配置变化不冲突，旧版本与非法规则不覆盖', async (t) => {
  const h = await fixture(t)
  assert.ok(ENDPOINTS.includes('monitor'))
  const first = await h.api.handle('monitor', { op: 'list' })
  assert.equal(first.enabled, true)
  assert.deepEqual(first.rules, [rule()])
  await h.api.handle('set', { key: 'outbound.quoteAfterMsgs', value: 4 })
  const updated = [rule({ instruction: '更新后的指令' })]
  const saved = await h.api.handle('monitor', { op: 'save', rules: updated, expectedRevision: first.revision })
  assert.equal(saved.ok, true, saved.error)
  assert.notEqual(saved.revision, first.revision)
  assert.deepEqual(h.kernel.plugins.find((p) => p.id === 'message-monitor').cfg.rules, updated)
  const conflict = await h.api.handle('monitor', { op: 'save', rules: [], expectedRevision: first.revision })
  assert.equal(conflict.ok, false)
  assert.equal(conflict.conflict, true)
  assert.deepEqual(conflict.rules, updated)
  const before = fs.readFileSync(h.configPath, 'utf8')
  const invalid = await h.api.handle('monitor', { op: 'save', rules: [rule({ match: 'regex' })], expectedRevision: saved.revision })
  assert.equal(invalid.ok, false)
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), before)
  assert.equal((await h.api.handle('monitor', { op: 'save', rules: [] })).conflict, true)
  assert.equal((await h.api.handle('monitor', { op: 'save', rules: [], expectedRevision: saved.revision })).ok, true)
})

test('monitor RPC测试只匹配已保存规则，不模型/QQ/更新cooldown且规则顺序首条优先', async (t) => {
  const h = await fixture(t, { rules: [rule(), rule({ id: 'second', name: '第二条' })] })
  const host = await createAdminHost({ ctx: h.ctx, kernel: h.kernel, log })
  t.after(host.dispose)
  const st = h.kernel.state.get('group:20001')
  const before = JSON.stringify(st)
  for (let i = 0; i < 2; i++) {
    const result = await host.handleRpc('monitor', { op: 'test', groupId: 20001, text: '有新消息啦', rules: [] })
    assert.equal(result.ok, true)
    assert.deepEqual(result.value.matches.map((r) => r.id), ['watch-news'])
  }
  assert.equal(JSON.stringify(st), before)
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.sent.length, 0)
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '有新消息啦', messageId: 701 }))
  assert.equal(h.ctx._prompts.length, 1, '测试未消耗真实监测冷却')
  assert.match(h.ctx._prompts[0].content[0].text, /消息监测命中/)
})

test('监测复用门禁、私聊和notice不触发，正常@命中不重复起轮且仍附监测指令', async (t) => {
  const h = await fixture(t, { gate: { groupUserBlocklist: '20001:10002' } })
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', userId: MEMBER_QQ, messageId: 710 }))
  await emitRaw(h.kernel, privateEvent({ text: '新消息', messageId: 711 }))
  assert.equal(h.ctx._prompts.length, 1, '私聊正常回复仍可进入，但不监测')
  assert.doesNotMatch(h.ctx._prompts[0].content[0].text, /消息监测指令/)
  await emitRaw(h.kernel, { post_type: 'notice', notice_type: 'notify', sub_type: 'other', group_id: 20001, user_id: ADMIN_QQ })
  await emitRaw(h.kernel, groupAtEvent({ at: true, text: '新消息', messageId: 712 }))
  assert.equal(h.ctx._prompts.length, 2)
  assert.match(h.ctx._prompts[1].content[0].text, /消息监测指令/)
  assert.match(h.ctx._prompts[1].content[0].text, /消息ID：712/)
  assert.doesNotMatch(h.ctx._prompts[1].content[0].text, /消息监测命中:/, '@已有明确wake不被monitor替换')
})

test('监测冷却阻止重复触发不滑动，已@消息冷却期间仍正常响应', async (t) => {
  const h = await fixture(t)
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', messageId: 720 }))
  assert.equal(h.ctx._prompts.length, 1)
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', messageId: 721 }))
  assert.equal(h.ctx._prompts.length, 1)
  await emitRaw(h.kernel, groupAtEvent({ at: true, text: '新消息', messageId: 722 }))
  assert.equal(h.ctx._prompts.length, 2)
  assert.doesNotMatch(h.ctx._prompts[1].content[0].text, /消息监测指令/)
  const first = await h.api.handle('monitor', { op: 'list' })
  await h.api.handle('monitor', { op: 'save', rules: [rule({ instruction: '热改后立即可用' })], expectedRevision: first.revision })
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', messageId: 723 }))
  assert.equal(h.ctx._prompts.length, 3)
  assert.match(h.ctx._prompts[2].content[0].text, /热改后立即可用/)
})

test('合批保留监测instruction对应消息ID，未命中消息并入正文不借主人身份', async (t) => {
  const h = await fixture(t, { merge: true })
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', messageId: 730 }))
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '这是后补的旁注', messageId: 731, userId: MEMBER_QQ }))
  h.kernel.pacing.flush('group:20001')
  await waitFor(() => h.ctx._prompts.length)
  const req = h.ctx._prompts[0]
  assert.match(req.content[0].text, /消息ID：730/)
  assert.match(req.content[0].text, /这是后补的旁注/)
  assert.equal((req.content[0].text.match(/消息监测指令/g) || []).length, 1)
  h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/start' })
  assert.equal(h.kernel.turnBySession.get(req.sessionId).isMaster, false)
})

test('monitor真人唤醒复用noteWake重置群未回，synthetic不误认真人', async (t) => {
  const h = await fixture(t, { proactive: true })
  const key = 'group:20001'
  const now = Date.now
  const before = h.kernel.pacing.nextOpportunityAt(key)
  Date.now = () => before + 1
  try {
    h.kernel.pacing.tickNow()
    await new Promise((resolve) => setImmediate(resolve))
    h.kernel.pacing.markProactiveSent(key, { wakeKind: 'proactive', turnId: 'seed', chatKey: key })
  } finally { Date.now = now }
  assert.equal(h.kernel.pacing.timingStateSnapshot()[key].unanswered, 1)
  await emitRaw(h.kernel, groupAtEvent({ at: false, text: '新消息', messageId: 740 }))
  assert.equal(h.kernel.pacing.timingStateSnapshot()[key].unanswered, 0)
})
