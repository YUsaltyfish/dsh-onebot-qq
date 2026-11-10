import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createDailyAccumulator } from '../plugins/group-memory/daily.js'
function setup(t, runner, cfg = {}) {
 const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-safety-')); t.after(() => { assert.ok(dir.startsWith(os.tmpdir())); fs.rmSync(dir, { recursive: true, force: true }) })
 const archive = path.join(dir, 'archive'), memory = path.join(dir, 'memory'); fs.mkdirSync(archive)
 let acc
 const build = () => createDailyAccumulator({ bot: { core: { archive: { dir: archive } }, dsh: { runIsolatedTask: (req) => runner(req, acc) } }, cfg, dataDirOf: () => dir, memoryDirOf: () => memory, invalidateMemoryOf() {} })
 acc = build()
 const append = (id = 1, chat = '123456') => { const ts = acc.status().baselineAt + id; fs.appendFileSync(path.join(archive, `group_${chat}.jsonl`), JSON.stringify({ ts, dir: 'in', messageId: id, text: 'prefers tea' }) + '\n' + JSON.stringify({ ts: ts + 1, dir: 'out', messageId: -id, text: 'yes', triggerMsgId: id }) + '\n') }
 return { dir, memory, archive, get acc() { return acc }, append, restart() { acc = build() }, run: () => acc.sync({ confirm: true }) }
}
const token = (req) => /batchId="([^"]+)"/.exec(req.prompt)[1]

test('daily rejects stale/missing batch tokens, duplicate idempotent, stopped instance cannot resurrect', async (t) => {
 let oldToken, count = 0
 const h = setup(t, async (req, acc) => {
  const batchId = token(req); count++
  assert.throws(() => acc.submit({ target: 'group:123456', operations: '[]' }), /batchId/)
  if (oldToken) assert.throws(() => acc.submit({ target: 'group:123456', operations: '[]', batchId: oldToken }), /batchId/)
  oldToken = batchId
  acc.submit({ target: 'group:123456', operations: '[]', batchId })
  assert.equal(acc.submit({ target: 'group:123456', operations: '[]', batchId }).duplicate, true)
 })
 h.append(); await h.run(); h.append(10); await h.run(); assert.equal(count, 2)
 h.acc.stop(); assert.equal((await h.run()).cancelled, true)
})

test('invalid schedule is fail-soft; malformed chat does not poison another chat', async (t) => {
 const cfg = { accumulateDailyTime: '99:99' }
 const h = setup(t, async (req, acc) => acc.submit({ target: 'group:234567', operations: '[]', batchId: token(req) }), cfg)
 assert.match(h.acc.status().lastError, /HH:mm/)
 assert.equal(h.acc.status().nextDueAt, 0)
 fs.writeFileSync(path.join(h.archive, 'group_123456.jsonl'), '{broken\n')
 h.append(1, '234567')
 const result = await h.run(); assert.equal(result.failed.length, 1); assert.equal(result.calls, 1)
})

test('manual stable ID edits reconcile, missing metadata fails closed without loss', async (t) => {
 let add = true
 const h = setup(t, async (req, acc) => {
  const source = /"sourceId":"([^"]+)"/.exec(req.prompt)[1]
  acc.submit({ target: 'group:123456', batchId: token(req), operations: JSON.stringify(add ? [{ op: 'add', id: 'tea', section: 'stable', text: 'likes tea', sourceIds: [source] }] : []) })
 })
 h.append(); await h.run(); add = false
 const file = path.join(h.memory, '123456.md')
 fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('likes tea', 'likes coffee'))
 h.append(10); assert.equal((await h.run()).failed.length, 0)
 assert.match(fs.readFileSync(file, 'utf8'), /likes coffee/)
 const text = fs.readFileSync(file, 'utf8').replace(/\n<!-- qq-memory-v1:.* -->\n/, '\n')
 fs.writeFileSync(file, text); h.append(20)
 assert.match((await h.run()).failed[0].detail, /metadata missing/)
 assert.equal(fs.readFileSync(file, 'utf8'), text)
})

test('stopped old instance never overwrites replacement state after delayed model completion', async (t) => {
 let release, entered
 const ready = new Promise((resolve) => { entered = resolve })
 const h = setup(t, async () => { entered(); await new Promise((resolve) => { release = resolve }) })
 h.append()
 const run = h.run(); await ready
 h.acc.stop()
 const file = path.join(h.dir, 'state', 'group-memory-daily.json')
 const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')); snapshot.replacementMarker = 'new-instance'
 fs.writeFileSync(file, JSON.stringify(snapshot)); const exact = fs.readFileSync(file, 'utf8')
 release(); assert.equal((await run).cancelled, true)
 assert.equal(fs.readFileSync(file, 'utf8'), exact)
})

test('corrupt persisted state refuses baseline reset and preserves bytes', async (t) => {
 const h = setup(t, async () => {})
 const file = path.join(h.dir, 'state', 'group-memory-daily.json')
 fs.writeFileSync(file, 'broken'); h.restart()
 assert.match(h.acc.status().lastError, /refusing baseline reset/)
 await assert.rejects(h.run(), /refusing baseline reset/)
 assert.equal(fs.readFileSync(file, 'utf8'), 'broken')
})
