import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createConfigStore } from '../admin/store.js'
import { createAdminEndpoints } from '../admin/endpoints.js'
import { defaultConfig } from '../kernel/config-store.js'
import { readJsonFile, writeJsonFileSync } from '../platform/atomic.js'

const log = { info() {}, warn() {} }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function fixture(t) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-config-transactions-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const configPath = path.join(dataDir, 'config.json')
  const raw = defaultConfig()
  raw.adminQq = 123456789
  writeJsonFileSync(configPath, raw)
  const kernel = { dataDir, configPath, async reloadConfig() {} }
  const store = createConfigStore({ kernel, log })
  return { dataDir, configPath, kernel, store }
}

test('updates serialize the read and asynchronous mutation across store instances', async (t) => {
  const { store, kernel, configPath } = fixture(t)
  const other = createConfigStore({ kernel, configPath: path.join(path.dirname(configPath), '.', 'config.json'), log })
  const entered = deferred()
  const release = deferred()
  let secondStarted = false
  const a = store.update(async (raw) => {
    entered.resolve()
    await release.promise
    raw.pacing.reply.hourlyMax = 7
  })
  await entered.promise
  const b = other.update((raw) => {
    secondStarted = true
    assert.equal(raw.pacing.reply.hourlyMax, 7)
    raw.outbound.quoteAfterMsgs = 4
  })
  await Promise.resolve()
  assert.equal(secondStarted, false)
  release.resolve()
  await Promise.all([a, b])
  const raw = store.read()
  assert.equal(raw.pacing.reply.hourlyMax, 7)
  assert.equal(raw.outbound.quoteAfterMsgs, 4)
})

test('a failed reload rolls back before the queued save can report success', async (t) => {
  const { store, kernel, configPath } = fixture(t)
  const entered = deferred()
  const release = deferred()
  let calls = 0
  kernel.reloadConfig = async () => {
    calls += 1
    if (calls === 1) {
      entered.resolve()
      await release.promise
      throw new Error('first reload failed')
    }
  }
  const a = store.update((raw) => { raw.pacing.reply.hourlyMax = 7 })
  const rejected = assert.rejects(a, /已回滚/)
  await entered.promise
  const next = store.read()
  next.pacing.reply.hourlyMax = 9
  let confirmed = false
  const b = createConfigStore({ kernel, configPath, log }).save(next).then((r) => { confirmed = true; return r })
  await Promise.resolve()
  assert.equal(confirmed, false, 'second save must not finish while the first reload is pending')
  release.resolve()
  await rejected
  assert.equal((await b).ok, true)
  assert.equal(store.read().pacing.reply.hourlyMax, 9)
  assert.equal(calls, 3, 'failed apply, rollback apply, then successful apply')
})

test('queued update reads the rolled-back base, while a different file is not blocked', async (t) => {
  const { store, kernel } = fixture(t)
  const other = fixture(t)
  const before = store.read().pacing.reply.hourlyMax
  const entered = deferred()
  const release = deferred()
  let calls = 0
  kernel.reloadConfig = async () => {
    if (++calls === 1) {
      entered.resolve()
      await release.promise
      throw new Error('reload failed')
    }
  }
  const a = store.update((raw) => { raw.pacing.reply.hourlyMax = 99 })
  const rejected = assert.rejects(a, /已回滚/)
  await entered.promise
  const b = store.update((raw) => {
    assert.equal(raw.pacing.reply.hourlyMax, before)
    raw.outbound.quoteAfterMsgs = 5
  })
  await other.store.update((raw) => { raw.pacing.reply.hourlyMax = 8 })
  assert.equal(calls, 1, 'a different config file progresses independently')
  release.resolve()
  await rejected
  await b
  assert.equal(store.read().pacing.reply.hourlyMax, before)
  assert.equal(store.read().outbound.quoteAfterMsgs, 5)
})

test('mutation and validation failures release the queue without changing disk', async (t) => {
  const { store } = fixture(t)
  const before = store.read()
  await assert.rejects(store.update(() => { throw new Error('mutation failed') }), /mutation failed/)
  await assert.rejects(store.update((raw) => { raw.adminQq = 0 }), /校验未通过/)
  assert.deepEqual(store.read(), before)
  await store.update((raw) => { raw.pacing.reply.hourlyMax = 8 })
  assert.equal(store.read().pacing.reply.hourlyMax, 8)
})

test('reload is the single runtime apply and save snapshots its input before waiting', async (t) => {
  const { store, kernel } = fixture(t)
  const entered = deferred()
  const release = deferred()
  let applies = 0
  kernel.applyRuntimeConfig = async () => { applies += 1 }
  kernel.reloadConfig = async () => {
    await kernel.applyRuntimeConfig()
    if (applies === 1) { entered.resolve(); await release.promise }
  }
  const a = store.update((raw) => { raw.pacing.reply.hourlyMax = 7 })
  await entered.promise
  const next = store.read()
  next.pacing.reply.hourlyMax = 8
  const b = store.save(next)
  next.pacing.reply.hourlyMax = 99
  release.resolve()
  await Promise.all([a, b])
  assert.equal(applies, 2)
  assert.equal(store.read().pacing.reply.hourlyMax, 8)
})

test('all config-writing endpoint kinds read the latest state inside the transaction', async (t) => {
  const { store, kernel, configPath, dataDir } = fixture(t)
  kernel.pluginDefs = [
    { id: 'gate-wake', configSchema: { enabled: { type: 'bool', default: true } } },
    { id: 'group-memory', configSchema: { maxBytes: { type: 'int', default: 24000 } } },
    { id: 'persona-voice', configSchema: {} },
  ]
  const personaDir = path.join(dataDir, 'personas')
  fs.mkdirSync(personaDir)
  fs.writeFileSync(path.join(personaDir, 'Synthetic.md'), 'synthetic persona')
  kernel.paths = { dataDir, personaDir, workspaceDir: path.join(dataDir, 'workspace') }
  await store.update((raw) => {
    raw.pluginConfig['persona-voice'] = { activePersona: 'Before' }
  })
  const admin = createAdminEndpoints({ kernel, log, ops: { personaSwitch: async () => ({ ok: true }) } })
  const entered = deferred()
  const release = deferred()
  const first = store.update(async (raw) => {
    entered.resolve()
    await release.promise
    raw.outbound.replyMaxLength = 3456
  })
  await entered.promise
  const requests = [
    ['set', { key: 'outbound.quoteAfterMsgs', value: 4 }],
    ['module', { id: 'gate-wake', on: false }],
    ['group', { kind: 'ignore', op: 'add', group_id: 123456 }],
    ['group', { kind: 'ignore', op: 'add', group_id: 234567 }],
    ['memory', { op: 'setcfg', key: 'group-memory.maxBytes', value: 30000 }],
    ['persona', { op: 'switch', name: 'Synthetic' }],
    ['action', { id: 'reply-preset', preset: 'active' }],
  ].map(([endpoint, payload]) => admin.handle(endpoint, payload))
  release.resolve()
  await first
  for (const result of await Promise.all(requests)) assert.equal(result.ok, true, result.error)
  const raw = readJsonFile(configPath)
  assert.equal(raw.outbound.replyMaxLength, 3456)
  assert.equal(raw.outbound.quoteAfterMsgs, 4)
  assert.equal(raw.pluginConfig['gate-wake'].enabled, false)
  assert.deepEqual(raw.pluginConfig['gate-wake'].ignoreGroups, [123456, 234567])
  assert.equal(raw.pluginConfig['group-memory'].maxBytes, 30000)
  assert.equal(raw.pluginConfig['persona-voice'].activePersona, 'Synthetic')
  assert.equal(raw.pacing.reply.hourlyMax, 6)
})
