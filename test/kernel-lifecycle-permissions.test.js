import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel, emitRaw, groupAtEvent, ADMIN_QQ, MEMBER_QQ, waitFor } from './helpers.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

test('命令分发统一检查扩展权限：普通成员拒绝、主人放行、未知值关闭', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  const calls = []
  h.kernel.commands.set('extension', { permission: 'master', handler(ev) { calls.push(ev.sender.qq); ev.stopped = true } })
  h.kernel.commands.set('invalid', { permission: 'owner', handler() { calls.push('invalid') } })
  await emitRaw(h.kernel, groupAtEvent({ text: '/extension', userId: MEMBER_QQ }))
  assert.deepEqual(calls, [])
  assert.match(h.sent.at(-1).wire, /只有主人/)
  await emitRaw(h.kernel, groupAtEvent({ text: '/extension', userId: ADMIN_QQ }))
  assert.deepEqual(calls, [ADMIN_QQ])
  await emitRaw(h.kernel, groupAtEvent({ text: '/invalid', userId: ADMIN_QQ }))
  assert.deepEqual(calls, [ADMIN_QQ])
  assert.match(h.sent.at(-1).wire, /权限配置无效/)
  assert.equal(h.ctx._prompts.length, 0)
})

test('卸载丢弃合批，不提交新会话或模型任务', async () => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: true, windowMs: 30, windowActiveMs: 30 } } } })
  await emitRaw(h.kernel, groupAtEvent({ text: '待合批', messageId: 101 }))
  assert.equal(h.ctx._prompts.length, 0)
  h.dispose()
  await sleep(70)
  assert.equal(h.ctx._sessions.size, 0)
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
})

test('建会话期间卸载：异步返回后不再提交 prompt', async () => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  let resume
  const create = h.ctx.sessionController.create
  h.ctx.sessionController.create = async (...args) => {
    await new Promise((resolve) => { resume = resolve })
    return create(...args)
  }
  const incoming = emitRaw(h.kernel, groupAtEvent({ text: '建会话', messageId: 102 }))
  await waitFor(() => resume, { label: '创建已开始' })
  h.dispose()
  resume()
  await incoming
  await sleep(10)
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
})

test('建会话等待期间插话也计入本轮引用', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } }, outbound: { quoteAfterMsgs: 1 } } })
  t.after(() => h.dispose())
  let resume
  const create = h.ctx.sessionController.create
  h.ctx.sessionController.create = async (...args) => {
    await new Promise((resolve) => { resume = resolve })
    return create(...args)
  }
  const incoming = emitRaw(h.kernel, groupAtEvent({ text: '慢创建', messageId: 201 }))
  await waitFor(() => resume, { label: '创建挂起' })
  await emitRaw(h.kernel, groupAtEvent({ text: '期间插话', messageId: 202, at: false }))
  resume()
  await incoming
  const sid = h.ctx._prompts[0].sessionId
  h.ctx.emit('session/event', { id: sid }, { type: 'turn/start' })
  assert.equal(h.kernel.state.get('group:20001').arrivalSequence, 2)
  assert.equal(h.kernel.turnBySession.get(sid).arrivalSequence, 1)
  await h.ctx._registeredTools.get('mcp__qq__send_message').execute({ target: 'group:20001', text: '回复' }, { agent: { session: { id: sid } } })
  assert.match(h.sent.at(-1).wire, /\[CQ:reply,id=201\]/)
})

test('管线异步等待期间卸载：恢复后不重新创建合批定时器', async () => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: true, windowMs: 30 } } } })
  let resume
  h.kernel.pipeline.use('before-turn', async () => { await new Promise((resolve) => { resume = resolve }) }, { order: 999 })
  let submits = 0
  const submit = h.kernel.pacing.submit
  h.kernel.pacing.submit = (...args) => { submits += 1; return submit(...args) }
  const incoming = emitRaw(h.kernel, groupAtEvent({ text: '慢管线', messageId: 203 }))
  await waitFor(() => resume, { label: '管线挂起' })
  h.dispose()
  resume()
  await incoming
  assert.equal(submits, 0)
  assert.equal(h.ctx._prompts.length, 0)
})

test('准入错误详情只留日志，不进入 QQ 回执', async (t) => {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  h.ctx.setPromptHandler(async () => { throw new Error('internal-sensitive-detail') })
  await emitRaw(h.kernel, groupAtEvent({ text: '失败', messageId: 103 }))
  await waitFor(() => h.sent.length, { label: '错误回执' })
  assert.equal(h.sent.some((item) => item.wire?.includes('internal-sensitive-detail')), false)
  assert.match(h.sent.at(-1).wire, /暂时无法处理/)
})
