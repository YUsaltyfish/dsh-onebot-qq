import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDshDriver } from '../kernel/dsh-driver.js'
const route = { provider: 'opencode-go', model: 'deepseek-v4.1-flash' }
function fixture(t) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'driver-model-'))
 const listeners = new Map(), maint = new Set(), sessions = new Map()
 const calls = { create: [], prompt: [], select: [], resolve: [], archived: [] }
 let deploymentDefault = { provider: 'ordinary', model: 'chat-default' }
 const agents = { get: (id) => sessions.get(id) }
 const registry = { archiveSession: async (id) => { calls.archived.push(id) } }
 const llm = { async resolveCallConfig(selection) { calls.resolve.push(selection); return { ...selection } } }
 const controller = {
  async create(options) {
   calls.create.push(options); const sessionId = `fixture-${calls.create.length}`
   let selected
   sessions.set(sessionId, { model: { select(value) { calls.select.push([sessionId, value]); selected = { ...value } }, current() { return selected || deploymentDefault } } })
   return { sessionId }
  },
  async modelCatalog() { return { groups: [{ id: route.provider, models: [{ id: route.model }] }], failures: [], default: deploymentDefault, routableProviders: [route.provider] } },
  async selectModel() { throw new Error('FORBIDDEN: would save deployment default') },
  async prompt(req) { calls.prompt.push({ ...req, selected: sessions.get(req.sessionId).model.current() }); listeners.get('session/event')?.({ id: req.sessionId }, { type: 'turn/end', reason: 'completed' }) },
  async inspect() { return { events: [] } }, async cancel() {},
 }
 const ctx = { sessionController: controller, get: (key) => ({ agents, llm, workspaceRegistry: registry })[key], on(name, fn) { listeners.set(name, fn); return () => listeners.delete(name) } }
 const log = Object.fromEntries(['debug', 'info', 'warn', 'error'].map((key) => [key, () => {}]))
 const driver = createDshDriver({ ctx, log, sessionsFile: path.join(dir, 'sessions.json'), maintSessionIds: maint, agentPreset: 'qq-chat' })
 t.after(() => { driver.close(); assert.equal(path.dirname(dir), os.tmpdir()); fs.rmSync(dir, { recursive: true, force: true }) })
 return { driver, calls, controller, llm, agents, sessions, maint, listeners, get default() { return deploymentDefault } }
}

test('dedicated isolated route selected through host model primitive before prompt without changing ordinary chat default', async (t) => {
 const h = fixture(t)
 await h.driver.runIsolatedTask({ prompt: 'synthetic memory task', modelSelection: route })
 assert.deepEqual(h.calls.prompt[0].selected, route)
 assert.deepEqual(h.calls.resolve, [route])
 assert.deepEqual(h.calls.select, [['fixture-1', route]])
 assert.deepEqual(h.calls.create[0], { cwd: undefined, agentPreset: 'qq-chat' }, 'no unsupported create modelSelection option')
 assert.deepEqual(h.default, { provider: 'ordinary', model: 'chat-default' })
 const id = await h.driver.ensureSession('group:123456')
 await h.driver.prompt(id, 'ordinary synthetic chat')
 assert.deepEqual(h.calls.prompt[1].selected, h.default)
 assert.equal(h.calls.select.length, 1)
 assert.equal(h.maint.size, 0)
})

test('QQ route applies only to new sessions, once per concurrent creation, independently of maintenance', async (t) => {
  const h = fixture(t)
  const existing = await h.driver.ensureSession('group:123456')
  await h.driver.applyConfig({ chatModelSelection: route })
  const [fresh, same] = await Promise.all([h.driver.ensureSession('private:123456'), h.driver.ensureSession('private:123456')])
  assert.equal(fresh, same)
  assert.equal(await h.driver.ensureSession('group:123456'), existing)
  assert.deepEqual(h.sessions.get(existing).model.current(), h.default)
  await h.driver.prompt(fresh, 'synthetic')
  assert.deepEqual(h.calls.prompt[0].selected, route)
  await h.driver.runIsolatedTask({ prompt: 'synthetic maintenance' })
  assert.deepEqual(h.calls.prompt[1].selected, h.default)
  await h.driver.applyConfig({ chatModelSelection: null })
  const inherited = await h.driver.ensureSession('group:234567')
  assert.deepEqual(h.sessions.get(inherited).model.current(), h.default)
  assert.deepEqual(h.calls.select, [[fresh, route]])
  assert.equal(h.driver.chatModelFallback(), null)
})

for (const changed of [false, true]) test(`QQ new session inherits default after route failure (selection attempted: ${changed})`, async (t) => {
  const h = fixture(t)
  await h.driver.applyConfig({ chatModelSelection: route })
  if (!changed) h.controller.modelCatalog = async () => ({ groups: [] })
  else {
    const create = h.controller.create
    h.controller.create = async (req) => {
      const r = await create(req)
      if (h.calls.create.length === 1) {
        const model = h.sessions.get(r.sessionId).model
        const select = model.select
        model.select = (value) => { select(value); throw new Error('selection partly applied') }
      }
      return r
    }
  }
  const id = await h.driver.ensureSession('group:123456')
  await h.driver.prompt(id, 'synthetic')
  assert.deepEqual(h.calls.prompt[0].selected, h.default)
  assert.deepEqual(h.calls.archived, changed ? ['fixture-1'] : [])
  assert.equal(h.calls.create.length, changed ? 2 : 1)
  const { at, ...failed } = h.driver.chatModelFallback()
  assert.ok(at > 0)
  assert.deepEqual(failed, route)
})

for (const scenario of ['catalog unavailable', 'route missing', 'auth resolution failed', 'host capability absent', 'selection failed', 'selection ignored']) {
 test(`dedicated route fails closed and archives unprompted session: ${scenario}`, async (t) => {
  const h = fixture(t)
  if (scenario === 'catalog unavailable') h.controller.modelCatalog = undefined
  if (scenario === 'route missing') h.controller.modelCatalog = async () => ({ groups: [] })
  if (scenario === 'auth resolution failed') h.llm.resolveCallConfig = async () => { throw new Error('synthetic auth failure') }
  if (scenario === 'host capability absent') h.agents.get = undefined
  if (scenario === 'selection failed' || scenario === 'selection ignored') {
   const create = h.controller.create
   h.controller.create = async (req) => { const result = await create(req); h.sessions.get(result.sessionId).model.select = () => { if (scenario === 'selection failed') throw new Error('synthetic select failure') }; return result }
  }
  await assert.rejects(h.driver.runIsolatedTask({ prompt: 'synthetic task', modelSelection: route }))
  assert.equal(h.calls.prompt.length, 0)
  assert.equal(h.maint.size, 0)
  assert.deepEqual(h.calls.archived, ['fixture-1'])
  assert.deepEqual(h.default, { provider: 'ordinary', model: 'chat-default' })
 })
}

test('partial explicit modelSelection is rejected before creating any session; omitted route preserves legacy task behavior', async (t) => {
 const h = fixture(t)
 await assert.rejects(h.driver.runIsolatedTask({ prompt: 'synthetic', modelSelection: { provider: route.provider } }), /provider 和 model/)
 assert.equal(h.calls.create.length, 0)
 await h.driver.runIsolatedTask({ prompt: 'synthetic legacy task' })
 assert.deepEqual(h.calls.prompt[0].selected, h.default)
 assert.equal(h.calls.resolve.length, 0)
 assert.equal(h.calls.select.length, 0)
})

test('installed events API returns exact isolated session assistant output and nested turn end reason', async (t) => {
 const h = fixture(t)
 h.controller.events = async (request, signal) => {
  assert.deepEqual(request, { address: { kind: 'session', sessionId: 'fixture-1' }, maxMessages: 20 })
  assert.ok(signal instanceof AbortSignal)
  return { records: [
   { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'old synthetic reply' }] } } } },
   { type: 'event', event: { type: 'assistant/message', data: { message: { content: [{ type: 'thinking', text: 'not output' }, { type: 'text', text: 'probe route OK' }] } } } },
   { type: 'event', event: { type: 'turn/end', data: { reason: 'completed' } } },
  ] }
 }
 h.controller.inspect = async () => { throw new Error('must not call obsolete inspect') }
 h.controller.prompt = async (req) => h.listeners.get('session/event')({ id: req.sessionId }, { type: 'turn/end', data: { reason: 'completed' } })
 const result = await h.driver.runIsolatedTask({ prompt: 'synthetic exact address probe', modelSelection: route })
 assert.equal(result.text, 'probe route OK')
 assert.equal(result.ok, true)
 assert.equal(result.reason, 'completed')
})

test('native structured turn-end failure reason retains diagnostic details', async (t) => {
 const h = fixture(t)
 const reason = { kind: 'error', error: { code: 'provider-failure', message: 'synthetic provider rejected request' } }
 h.controller.events = async () => ({ records: [] })
 h.controller.prompt = async (req) => h.listeners.get('session/event')({ id: req.sessionId }, { type: 'turn/end', data: { reason } })
 const result = await h.driver.runIsolatedTask({ prompt: 'synthetic failure diagnostics', modelSelection: route })
 assert.equal(result.ok, false)
 assert.deepEqual(JSON.parse(result.reason), reason)
})

test('driver close while model auth is resolving never submits and cleans up', async (t) => {
 const h = fixture(t)
 let entered, release
 const ready = new Promise((resolve) => { entered = resolve })
 h.llm.resolveCallConfig = async () => { entered(); await new Promise((resolve) => { release = resolve }) }
 const work = h.driver.runIsolatedTask({ prompt: 'synthetic', modelSelection: route })
 const rejected = assert.rejects(work, /已关闭/)
 await ready; h.driver.close(); await rejected
 release()
 for (let i = 0; i < 30; i++) await Promise.resolve()
 assert.equal(h.calls.prompt.length, 0)
 assert.equal(h.calls.select.length, 0)
 assert.equal(h.maint.size, 0)
 assert.deepEqual(h.calls.archived, ['fixture-1'])
})
