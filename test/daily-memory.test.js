import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDailyAccumulator } from '../plugins/group-memory/daily.js'
import { memoryModelSelection } from '../plugins/group-memory/model.js'
import { nextDailyAt, selectInteractions, sourceId, applyOperations } from '../plugins/group-memory/daily.js'

test('memory model selection inherits blank and rejects incomplete pairs', () => {
  assert.equal(memoryModelSelection({}), undefined)
  assert.throws(() => memoryModelSelection({ accumulateModelProvider: 'opencode-go' }), /同时填写/)
  assert.throws(() => memoryModelSelection({ accumulateModel: 'deepseek-v4.1-flash' }), /同时填写/)
  assert.deepEqual(memoryModelSelection({ accumulateModelProvider: ' opencode-go ', accumulateModel: 'deepseek-v4.1-flash' }), { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
})

test('daily task passes dedicated route and retries same sources after model failure', async (t) => {
  let fail = true
  const h = fixture(t, async (req, acc) => {
    assert.deepEqual(req.modelSelection, { provider: 'opencode-go', model: 'deepseek-v4.1-flash' })
    if (fail) throw new Error('model unavailable')
    acc.submit({ target: 'group:123456', operations: '[]' })
    return {}
  }, { accumulateModelProvider: 'opencode-go', accumulateModel: 'deepseek-v4.1-flash' })
  const ts = h.acc.status().baselineAt + 1
  h.append([row(ts, 1, 'hello'), row(ts + 1, 2, 'reply', { dir: 'out', triggerMsgId: 1 })])
  assert.equal((await h.run()).failed.length, 1)
  fail = false
  assert.equal((await h.run()).calls, 1)
  assert.equal((await h.run()).calls, 0)
})

test('daily schedule uses explicit timezone, next fixed time, DST and rejects invalid input', () => {
  assert.equal(new Date(nextDailyAt(Date.parse('2026-11-10T20:01:00Z'))).toISOString(), '2026-11-11T20:00:00.000Z')
  assert.equal(new Date(nextDailyAt(Date.parse('2026-11-10T19:59:00Z'))).toISOString(), '2026-11-10T20:00:00.000Z')
  assert.throws(() => nextDailyAt(Date.now(), '25:00'))
  assert.throws(() => nextDailyAt(Date.now(), '04:00', 'invalid'))
  assert.ok(nextDailyAt(Date.parse('2026-03-08T06:00:00Z'), '02:30', 'America/New_York') > Date.parse('2026-03-08T06:00:00Z'))
})
const row = (ts, messageId, text, extra = {}) => ({ ts, messageId, text, dir: 'in', ...extra })
function fixture(t, runner, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daily-memory-'))
  t.after(() => { assert.ok(dir.startsWith(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }) })
  const archive = path.join(dir, 'archive'), memory = path.join(dir, 'memory')
  fs.mkdirSync(archive)
  let acc
  const prompts = []
  const build = () => createDailyAccumulator({ bot: { core: { archive: { dir: archive } }, dsh: { async runIsolatedTask(req) { prompts.push(req.prompt); return runner(req, { submit: (args) => acc.submit({ batchId: /batchId="([^"]+)"/.exec(req.prompt)[1], ...args }) }) } } }, cfg, log: { warn() {} }, dataDirOf: () => dir, memoryDirOf: () => memory, invalidateMemoryOf() {} })
  acc = build()
  return { dir, archive, memory, prompts, get acc() { return acc }, restart() { acc = build() }, run: () => acc.sync({ confirm: true }), append(rows, id = '123456') { fs.appendFileSync(path.join(archive, `group_${id}.jsonl`), rows.map(JSON.stringify).join('\n') + '\n') } }
}
function sourceFromPrompt(prompt) { return [...prompt.matchAll(/"sourceId":"([a-f0-9]+)"/g)].map((m) => m[1]) }

test('only bot-linked interactions and direct quote ancestors, never background whole group', () => {
  const rows = [row(1, 1, 'background'), row(2, 2, 'quoted'), row(3, 3, 'wake', { replyTo: 2 }), row(4, 4, 'noise'), row(5, 5, 'answer', { dir: 'out', triggerMsgId: 3 })]
  assert.deepEqual(selectInteractions(rows).map((r) => r.messageId), [2, 3, 5])
  assert.deepEqual(selectInteractions(rows, true).map((r) => r.messageId), [2, 3, 5])
})

test('first run baseline avoids old history; singleton task per chat, source IDs/timestamps, no-new idempotent restart', async (t) => {
  const h = fixture(t, async ({ prompt }, acc) => {
    const target = /本任务仅属于 ([^，]+)/.exec(prompt)[1]
    assert.equal((prompt.match(/本任务仅属于/g) || []).length, 1)
    acc.submit({ target, operations: '[]' })
    return { text: '' }
  })
  const baseline = h.acc.status().baselineAt
  h.append([row(baseline - 1000, 1, 'OLD'), row(baseline - 500, 2, 'old answer', { dir: 'out', triggerMsgId: 1 })])
  assert.equal((await h.run()).calls, 0)
  for (const [id, text] of [['123456', 'chatA'], ['234567', 'chatB']]) h.append([row(baseline + 1, 3, text), row(baseline + 2, 4, 'answer', { dir: 'out', triggerMsgId: 3 })], id)
  assert.equal((await h.run()).calls, 2)
  const chatAPrompt = h.prompts.find((prompt) => prompt.includes('本任务仅属于 group:123456'))
  assert.doesNotMatch(chatAPrompt, /OLD|chatB/)
  assert.match(chatAPrompt, /timestamp/)
  assert.equal(sourceFromPrompt(chatAPrompt).length, 2)
  h.restart()
  assert.equal((await h.run()).calls, 0)
})

test('oversize remains pending without any progress or sampling; can retry with increased budget', async (t) => {
  const cfg = { accumulateMaxChars: 20 }
  const h = fixture(t, async ({ prompt }, acc) => { acc.submit({ target: 'group:123456', operations: '[]' }); return {} }, cfg)
  const ts = h.acc.status().baselineAt + 1
  h.append([row(ts, 1, 'long'.repeat(100)), row(ts + 1, 2, 'reply', { dir: 'out', triggerMsgId: 1 })])
  const first = await h.run()
  assert.equal(first.calls, 0)
  assert.equal(first.pending.length, 1)
  assert.equal(first.sampledOut, 0)
  assert.equal(fs.existsSync(path.join(h.memory, '123456.md')), false)
  cfg.accumulateMaxChars = 5000
  assert.equal((await h.run()).calls, 1)
})

test('manual write during model run is retained and does not acknowledge sources', async (t) => {
  let interfere = true
  const h = fixture(t, async (_, acc) => {
    if (interfere) { fs.mkdirSync(h.memory, { recursive: true }); fs.writeFileSync(path.join(h.memory, '123456.md'), '# manual edit\n') }
    acc.submit({ target: 'group:123456', operations: '[]' }); return {}
  })
  const ts = h.acc.status().baselineAt + 1
  h.append([row(ts, 1, 'wake'), row(ts + 1, 2, 'answer', { dir: 'out', triggerMsgId: 1 })])
  assert.match((await h.run()).failed[0].detail, /revision changed/)
  assert.equal(fs.readFileSync(path.join(h.memory, '123456.md'), 'utf8'), '# manual edit\n')
  interfere = false
  assert.equal((await h.run()).failed.length, 0)
  assert.match(fs.readFileSync(path.join(h.memory, '123456.md'), 'utf8'), /manual edit/)
})

test('operations validate sources and IDs, update/remove stable entries, expire recent not promises', () => {
  const now = Date.now(), sources = new Set(['s'])
  let doc = { entries: [], processed: [], legacy: '' }
  assert.throws(() => applyOperations(doc, [{ op: 'add', text: 'x', section: 'stable', sourceIds: ['foreign'] }], sources, now))
  doc = applyOperations(doc, [{ op: 'add', id: 'stable1', text: 'likes tea', section: 'stable', sourceIds: ['s'] }, { op: 'add', id: 'recent1', text: 'travelling', section: 'recent', sourceIds: ['s'] }, { op: 'add', id: 'promise1', text: 'send guide', section: 'promises', sourceIds: ['s'] }], sources, now)
  doc = applyOperations(doc, [{ op: 'update', id: 'stable1', text: 'likes coffee', section: 'stable', sourceIds: ['s'] }], sources, now)
  assert.equal(doc.entries[0].text, 'likes coffee')
  doc = applyOperations(doc, [], sources, now + 15 * 86400000)
  assert.deepEqual(doc.entries.map((e) => e.id), ['stable1', 'promise1'])
  doc = applyOperations(doc, [{ op: 'remove', id: 'promise1', sourceIds: ['s'] }], sources, now)
  assert.deepEqual(doc.entries.map((e) => e.id), ['stable1'])
})

test('new entries get short numeric IDs that are never reused after removal', () => {
  const now = Date.now(), sources = new Set(['s'])
  let doc = { entries: [], processed: [], legacy: '' }
  doc = applyOperations(doc, [{ op: 'add', text: 'first', section: 'stable', sourceIds: ['s'] }, { op: 'add', text: 'second', section: 'recent', sourceIds: ['s'] }], sources, now)
  assert.deepEqual(doc.entries.map((e) => e.id), ['1', '2'])
  doc = applyOperations(doc, [{ op: 'remove', id: '1', sourceIds: ['s'] }], sources, now)
  doc = applyOperations(doc, [{ op: 'add', text: 'third', section: 'stable', sourceIds: ['s'] }], sources, now)
  assert.deepEqual(doc.entries.map((e) => e.id), ['2', '3'], 'deleted IDs must not be reused')
  assert.ok(Number(doc.nextId) >= 4)
})

test('crash-safe receipt in memory survives missing state checkpoint and no-new is successful', async (t) => {
  const h = fixture(t, async ({ prompt }, acc) => {
    acc.submit({ target: 'group:123456', operations: JSON.stringify([{ op: 'add', id: 'm1', section: 'stable', text: 'prefers concise', sourceIds: [sourceFromPrompt(prompt)[0]] }]) }); return {}
  })
  const ts = h.acc.status().baselineAt + 1
  h.append([row(ts, 1, 'wake'), row(ts + 1, 2, 'answer', { dir: 'out', triggerMsgId: 1 })])
  assert.equal((await h.run()).updated.length, 1)
  const stateFile = path.join(h.dir, 'state', 'group-memory-daily.json')
  const state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); state.groups = {}; state.nextDueAt = Date.now() - 3600000
  fs.writeFileSync(stateFile, JSON.stringify(state))
  h.restart()
  assert.ok(h.acc.status().nextDueAt < Date.now(), 'missed persisted schedule remains due')
  assert.equal((await h.run()).calls, 0)
  assert.equal(sourceId(row(ts, 1, 'wake')).length, 64)
})
