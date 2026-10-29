import { test } from 'node:test'
import assert from 'node:assert/strict'
import { bootKernel, GROUP_ID } from './helpers.mjs'

const execOf = id => ({ agent: { session: { id } } })
const tool = (h, name) => {
  const registered = h.ctx._registeredTools.get(`mcp__qq__${name}`)
  assert.ok(registered, `${name} must be a real registered tool`)
  return registered
}
async function boot(t) {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false } } } })
  t.after(h.dispose)
  return h
}
function track(t, h, name) {
  let calls = 0
  t.mock.method(h.kernel.toolDefs.get(name), 'execute', async () => { calls++; return { ok: true } })
  return () => calls
}

test('current mapped session may call QQ tools, unknown session cannot borrow explicit target', async t => {
  const h = await boot(t)
  const calls = track(t, h, 'send_message')
  const sid = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  const registered = tool(h, 'send_message')
  await registered.execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf(sid))
  assert.equal(calls(), 1)
  await assert.rejects(registered.execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf('unowned-fixture-session')), /不属于当前 QQ 插件/)
  assert.equal(calls(), 1)
  h.kernel.dsh.forgetSession(`group:${GROUP_ID}`)
  await assert.rejects(registered.execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf(sid)), /不属于当前 QQ 插件/)
  assert.equal(calls(), 1)
})

test('maintenance identity is deny-send / allow-append, ordinary mapped identity cannot append', async t => {
  const h = await boot(t)
  const sent = track(t, h, 'send_message')
  const appended = track(t, h, 'memory_append')
  const sid = 'maintenance-fixture'
  h.kernel.maintSessionIds.add(sid)
  await assert.rejects(tool(h, 'send_message').execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf(sid)), /后台任务只允许/)
  await tool(h, 'memory_append').execute({ group_id: String(GROUP_ID), points: '- fixture' }, execOf(sid))
  assert.equal(sent(), 0)
  assert.equal(appended(), 1)
  const ordinary = await h.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  await assert.rejects(tool(h, 'memory_append').execute({ group_id: String(GROUP_ID), points: '- fixture' }, execOf(ordinary)), /只能由后台任务/)
  assert.equal(appended(), 1)
})

test('old closures reject after dispose and new boot rejects old maintenance identity despite disjoint Sets', async t => {
  const old = await boot(t)
  const oldSid = 'old-generation-maintenance-fixture'
  old.kernel.maintSessionIds.add(oldSid)
  const oldSend = tool(old, 'send_message')
  const oldAppend = tool(old, 'memory_append')
  const oldSent = track(t, old, 'send_message')
  const oldAppended = track(t, old, 'memory_append')
  old.dispose()
  assert.equal(old.kernel.maintSessionIds.has(oldSid), true, 'dispose must not revoke unfinished maintenance identity')
  const args = { target: `group:${GROUP_ID}`, text: 'fixture', group_id: String(GROUP_ID), points: '- fixture' }
  for (const registered of [oldSend, oldAppend]) {
    await assert.rejects(registered.execute(args, execOf(oldSid)), /已卸载/)
    await assert.rejects(registered.execute(args, {}), /已卸载/)
  }
  assert.equal(oldSent(), 0)
  assert.equal(oldAppended(), 0)

  const current = await boot(t)
  assert.notEqual(current.kernel.maintSessionIds, old.kernel.maintSessionIds)
  assert.equal(current.kernel.maintSessionIds.has(oldSid), false)
  const currentSent = track(t, current, 'send_message')
  const currentAppended = track(t, current, 'memory_append')
  const currentSid = await current.kernel.dsh.ensureSession(`group:${GROUP_ID}`)
  for (const name of ['send_message', 'memory_append']) {
    await assert.rejects(tool(current, name).execute(args, execOf(oldSid)), /不属于当前 QQ 插件/)
  }
  await tool(current, 'send_message').execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf(currentSid))
  assert.equal(currentSent(), 1)
  assert.equal(currentAppended(), 0)
  // Even a newly legitimate session cannot revive a disposed generation's closure.
  await assert.rejects(oldSend.execute({ target: `group:${GROUP_ID}`, text: 'fixture' }, execOf(currentSid)), /已卸载/)
  assert.equal(oldSent(), 0)
})
