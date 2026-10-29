import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDshDriver } from '../kernel/dsh-driver.js'

const deferred = () => {
  let resolve, reject
  const promise = new Promise((yes, no) => { resolve = yes; reject = no })
  return { promise, resolve, reject }
}
const flush = async () => { for (let i = 0; i < 20; i++) await Promise.resolve() }

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-driver-lifecycle-'))
  const listeners = new Map()
  const maintSessionIds = new Set()
  const calls = { cancel: 0, archive: 0, prompt: 0, inspect: 0 }
  const controller = {
    create: async () => ({ sessionId: 'isolated-fixture' }),
    prompt: async () => { calls.prompt++ },
    cancel: async () => { calls.cancel++; return { accepted: true } },
    inspect: async () => {
      calls.inspect++
      return { events: [{ type: 'assistant/message', data: { message: { content: [{ type: 'text', text: 'fixture output' }] } } }] }
    },
    ...overrides,
  }
  const ctx = {
    sessionController: controller,
    get: () => ({ archiveSession: async () => { calls.archive++ } }),
    on(name, fn) {
      listeners.set(name, fn)
      return () => listeners.delete(name)
    },
  }
  const log = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(k => [k, () => {}]))
  const driver = createDshDriver({ ctx, log, sessionsFile: path.join(dir, 'sessions.json'), maintSessionIds })
  t.after(() => {
    driver.close()
    // This directory is the fixture-owned mkdtemp result, not instance data.
    assert.equal(path.dirname(dir), os.tmpdir())
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const end = (reason = 'completed') => listeners.get('session/event')?.({ id: 'isolated-fixture' }, { type: 'turn/end', reason })
  return { driver, controller, calls, maintSessionIds, listeners, end, ctx }
}

test('isolated admission failure releases timer and never causes late rejection', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const h = fixture(t, { prompt: async () => { throw new Error('admission failed') } })
  await assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture', timeoutMs: 30000 }), /admission failed/)
  assert.equal(h.maintSessionIds.size, 0)
  assert.equal(h.calls.archive, 1)
  t.mock.timers.tick(60000)
  await flush()
  h.end()
  assert.equal(h.calls.archive, 1)
  assert.equal(h.calls.cancel, 0)
})

test('isolated success handles end during admission and archives only once', async t => {
  const h = fixture(t)
  h.controller.prompt = async () => { h.end('completed') }
  const result = await h.driver.runIsolatedTask({ prompt: 'fixture' })
  assert.deepEqual(result, { ok: true, sessionId: 'isolated-fixture', text: 'fixture output', reason: 'completed' })
  h.end()
  assert.equal(h.calls.archive, 1)
  assert.equal(h.maintSessionIds.size, 0)
})

for (const fails of [false, true]) {
  test(`timeout retains isolation until late end (cancel fails=${fails})`, async t => {
    t.mock.timers.enable({ apis: ['setTimeout'] })
    const h = fixture(t)
    h.controller.cancel = async () => {
      h.calls.cancel++
      if (fails) throw new Error('cancel unavailable')
      return { accepted: true }
    }
    const work = h.driver.runIsolatedTask({ prompt: 'fixture', timeoutMs: 30000 })
    const rejected = assert.rejects(work, /超时/)
    await flush()
    t.mock.timers.tick(30000)
    await rejected
    assert.equal(h.calls.cancel, 1)
    assert.equal(h.maintSessionIds.size, 1, 'cancel acknowledgement is not completion')
    assert.equal(h.calls.archive, 0)
    assert.equal(h.calls.inspect, 0)
    h.end('cancelled')
    await flush()
    assert.equal(h.maintSessionIds.size, 0)
    assert.equal(h.calls.archive, 1)
    h.end()
    assert.equal(h.calls.archive, 1)
  })
}

test('timeout while admission pending cancels only after admission and keeps late failure handled', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const h = fixture(t, { prompt: () => gate.promise })
  const work = h.driver.runIsolatedTask({ prompt: 'fixture', timeoutMs: 30000 })
  const rejected = assert.rejects(work, /超时/)
  await flush()
  t.mock.timers.tick(30000)
  await rejected
  assert.equal(h.calls.cancel, 0)
  assert.equal(h.maintSessionIds.size, 1)
  gate.resolve()
  await flush()
  assert.equal(h.calls.cancel, 1)
  h.end()
  await flush()
  assert.equal(h.calls.archive, 1)
})

test('late admission rejection after timeout releases isolation without extra unhandled promise', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const gate = deferred()
  const h = fixture(t, { prompt: () => gate.promise })
  const rejected = assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture', timeoutMs: 30000 }), /超时/)
  await flush()
  t.mock.timers.tick(30000)
  await rejected
  gate.reject(new Error('late admission failed'))
  await flush()
  assert.equal(h.maintSessionIds.size, 0)
  assert.equal(h.calls.archive, 1)
})

test('archive failure does not retain identity after confirmed end', async t => {
  const h = fixture(t)
  h.ctx.get = () => ({ archiveSession: async () => { h.calls.archive++; throw new Error('archive failed') } })
  const work = h.driver.runIsolatedTask({ prompt: 'fixture' })
  await flush()
  h.end()
  assert.equal((await work).ok, true)
  assert.equal(h.calls.archive, 1)
  assert.equal(h.maintSessionIds.size, 0)
})

test('close rejects waiter, requests cancel once, keeps late end listener and denies new tasks', async t => {
  const h = fixture(t)
  const rejected = assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture' }), /已关闭/)
  await flush()
  h.driver.close()
  h.driver.close()
  await rejected
  assert.equal(h.calls.cancel, 1)
  assert.equal(h.maintSessionIds.size, 1)
  assert.ok(h.listeners.has('session/event'))
  await assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture' }), /已关闭/)
  await assert.rejects(h.driver.ensureSession('group:123456789'), /已关闭/)
  await assert.rejects(h.driver.prompt('isolated-fixture', 'fixture'), /已关闭/)
  h.end('cancelled')
  await flush()
  assert.equal(h.calls.archive, 1)
  assert.equal(h.maintSessionIds.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('close during prompt admission cancels once after accepted and preserves identity until end', async t => {
  const gate = deferred()
  const h = fixture(t, { prompt: () => gate.promise })
  const rejected = assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture' }), /已关闭/)
  await flush()
  h.driver.close()
  await rejected
  assert.equal(h.calls.cancel, 0)
  assert.equal(h.maintSessionIds.size, 1)
  gate.resolve({ accepted: true })
  await flush()
  assert.equal(h.calls.cancel, 1)
  assert.equal(h.maintSessionIds.size, 1)
  h.end('cancelled')
  await flush()
  assert.equal(h.maintSessionIds.size, 0)
  assert.equal(h.listeners.size, 0)
})

test('close during ordinary session creation leaves no mapping or later prompt', async t => {
  const gate = deferred()
  const h = fixture(t, { create: () => gate.promise })
  const rejected = assert.rejects(h.driver.ensureSession('group:123456789'), /已关闭/)
  h.driver.close()
  gate.resolve({ sessionId: 'ordinary-fixture' })
  await rejected
  assert.equal(h.driver.sessionOf('group:123456789'), '')
  assert.equal(h.calls.archive, 1)
  assert.equal(h.calls.prompt, 0)
})

test('close during create prevents later admission and cleans created session', async t => {
  const gate = deferred()
  const h = fixture(t, { create: () => gate.promise })
  const rejected = assert.rejects(h.driver.runIsolatedTask({ prompt: 'fixture' }), /已关闭/)
  h.driver.close()
  gate.resolve({ sessionId: 'isolated-fixture' })
  await rejected
  assert.equal(h.calls.prompt, 0)
  assert.equal(h.calls.cancel, 0)
  assert.equal(h.calls.archive, 1)
  assert.equal(h.maintSessionIds.size, 0)
})
