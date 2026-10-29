import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createAccumulator } from '../plugins/group-memory/accumulate.js'
import { readJsonFile, writeJsonFileSync } from '../platform/atomic.js'
import { bootKernel, emitRaw, waitFor, GROUP_ID, MEMBER_QQ } from './helpers.mjs'

const quiet = { info() {}, warn() {} }
const GROUP = '123456'
function fixture(t, { state, cfg = {}, runner } = {}) {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-memory-watermark-'))
  t.after(() => fs.rmSync(dataDir, { recursive: true, force: true }))
  const archiveDir = path.join(dataDir, 'archive')
  const memoryDir = path.join(dataDir, 'memory')
  fs.mkdirSync(archiveDir)
  if (state) writeJsonFileSync(path.join(dataDir, 'state', 'group-memory.json'), state)
  const prompts = []
  let accumulator
  const build = () => createAccumulator({
    bot: { core: { archive: { dir: archiveDir } }, dsh: { async runIsolatedTask(req) {
      prompts.push(req.prompt)
      if (runner) return runner(req, accumulator)
      for (const match of req.prompt.matchAll(/【群 (\d+)】/g)) accumulator.submit({ group_id: match[1], points: '（无新增）' })
      return { text: '' }
    } } },
    cfg: { accumulateMinNewMsgs: 1, accumulateKeepDays: 0, ...cfg }, log: quiet,
    dataDirOf: () => dataDir, memoryDirOf: () => memoryDir,
    readMemoryOf: () => null, invalidateMemoryOf() {},
  })
  accumulator = build()
  const append = (row, gid = GROUP, suffix = '') => fs.appendFileSync(path.join(archiveDir, `group_${gid}.jsonl${suffix}`), `${JSON.stringify(row)}\n`)
  return { dataDir, archiveDir, prompts, append, run: () => accumulator.sync({ confirm: true }),
    restart() { accumulator = build() }, state: () => readJsonFile(path.join(dataDir, 'state', 'group-memory.json')) }
}
const row = (ts, messageId, text, extra = {}) => ({ ts, messageId, dir: 'in', sender: { name: 'Synthetic', qq: 123456789 }, text, ...extra })

test('same-second arrivals during model work and older out-of-order messages are processed once across restart', async (t) => {
  const ts = Math.floor(Date.now() / 1000) * 1000 - 10000
  let h
  h = fixture(t, { runner: async () => {
    if (h.prompts.length === 1) h.append(row(ts, -2, 'late-same-second'))
    return { text: '（无新增）' }
  } })
  h.append(row(ts, -1, 'first-message'))
  await h.run()
  h.restart()
  await h.run()
  assert.match(h.prompts[1], /late-same-second/)
  assert.doesNotMatch(h.prompts[1], /first-message/)
  h.append(row(ts - 2000, -3, 'older-out-of-order'))
  await h.run()
  assert.match(h.prompts[2], /older-out-of-order/)
  assert.equal(h.state().groups[GROUP].digestedAt, ts, 'late older rows never lower high-water timestamp')
  await h.run()
  assert.equal(h.prompts.length, 3)
})

test('legacy timestamp replays only the boundary once; future timestamps do not advance replay floor', async (t) => {
  const ts = Date.now() - 10000
  const h = fixture(t, { state: { groups: { [GROUP]: { digestedAt: ts } } } })
  h.append(row(ts - 1, 1, 'legacy-older'))
  h.append(row(ts, 2, 'legacy-boundary'))
  await h.run()
  assert.match(h.prompts[0], /legacy-boundary/)
  assert.doesNotMatch(h.prompts[0], /legacy-older/)
  await h.run()
  assert.equal(h.prompts.length, 1)
  h.append(row(Date.now() + 86400000, 3, 'future-clock'))
  await h.run()
  h.append(row(ts + 1, 4, 'normal-after-future'))
  await h.run()
  assert.match(h.prompts[2], /normal-after-future/)
  assert.ok(h.state().groups[GROUP].digestedAt > Date.now())
})

test('rotation duplicate IDs and ID-less records deduplicate without merging distinct groups or directions', async (t) => {
  const h = fixture(t)
  const ts = Date.now() - 1000
  h.append(row(ts, 1, 'duplicate-id'))
  h.append(row(ts, 1, 'duplicate-id'), GROUP, '.1')
  h.append(row(ts, null, 'legacy-no-id'))
  h.append(row(ts, null, 'legacy-no-id'), GROUP, '.1')
  h.append(row(ts, 1, 'outgoing-record', { dir: 'out' }))
  h.append(row(ts, 1, 'another-group'), '234567')
  const result = await h.run()
  assert.equal(result.failed.length, 0)
  assert.equal((h.prompts[0].match(/duplicate-id/g) || []).length, 1)
  assert.equal((h.prompts[0].match(/legacy-no-id/g) || []).length, 1)
  assert.match(h.prompts[0], /outgoing-record/)
  assert.match(h.prompts[0], /another-group/)
  await h.run()
  assert.equal(h.prompts.length, 1)
})

test('failed model output does not commit deduplication state', async (t) => {
  const h = fixture(t, { runner: async () => ({ text: '' }) })
  h.append(row(Date.now() - 1000, 1, 'retry-me'))
  assert.equal((await h.run()).failed.length, 1)
  assert.equal((await h.run()).failed.length, 1)
  assert.equal(h.prompts.length, 2)
  assert.equal(h.state().groups[GROUP]?.digestedAt, undefined)
})

test('archive pruning retains unseen same-second and out-of-order arrivals during model work', async (t) => {
  const ts = Date.now() - 4 * 86400000
  let h
  h = fixture(t, { cfg: { accumulateLookbackHours: 240, accumulateKeepDays: 1 }, runner: async () => {
    if (h.prompts.length === 1) {
      h.append(row(ts, 2, 'same-second-not-fed'))
      h.append(row(ts - 1000, 3, 'older-not-fed'))
    }
    return { text: '（无新增）' }
  } })
  h.append(row(ts, 1, 'already-fed'))
  const result = await h.run()
  assert.equal(result.pruned.removed, 1)
  const retained = fs.readFileSync(path.join(h.archiveDir, `group_${GROUP}.jsonl`), 'utf8')
  assert.match(retained, /same-second-not-fed/)
  assert.match(retained, /older-not-fed/)
  await h.run()
  assert.match(h.prompts[1], /same-second-not-fed/)
  assert.match(h.prompts[1], /older-not-fed/)
})

test('lookback evicts old keys but pruning never treats unseen expired rows as digested', async (t) => {
  const ts = Date.now() - 5000
  const oldKey = 'expired-dedup-key'
  const h = fixture(t, { cfg: { accumulateLookbackHours: 1, accumulateKeepDays: 1 }, state: { groups: {
    [GROUP]: { digestedAt: ts, replayFrom: ts - 86400000, seenMessages: [[oldKey, ts - 86400000]] },
  } } })
  h.append(row(ts - 3 * 86400000, 1, 'never-fed-expired'))
  h.append(row(ts + 1, 2, 'newly-fed'))
  const result = await h.run()
  assert.equal(result.pruned.removed, 0)
  assert.match(fs.readFileSync(path.join(h.archiveDir, `group_${GROUP}.jsonl`), 'utf8'), /never-fed-expired/)
  assert.equal(h.state().groups[GROUP].seenMessages.some(([key]) => key === oldKey), false)
  assert.doesNotMatch(h.prompts[0], /never-fed-expired/)
})

test('same-second windows above ten thousand records keep the complete boundary', async (t) => {
  const h = fixture(t)
  const ts = Date.now() - 1000
  fs.writeFileSync(path.join(h.archiveDir, `group_${GROUP}.jsonl`),
    Array.from({ length: 10001 }, (_, id) => JSON.stringify(row(ts, id, `bulk-${id}`))).join('\n') + '\n')
  const first = await h.run()
  assert.ok(first.sampledOut > 0)
  assert.equal(h.state().groups[GROUP].seenMessages.length, 10001)
  h.append(row(ts, 10002, 'late-after-bulk'))
  await h.run()
  assert.match(h.prompts[1], /late-after-bulk/)
  assert.doesNotMatch(h.prompts[1], /bulk-/)
  await h.run()
  assert.equal(h.prompts.length, 2)
})

test('real normalize -> kernel archive -> accumulate preserves sender name and card precedence', async (t) => {
  const h = await bootKernel({ config: { archive: { enabled: true }, pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  const ts = Math.floor(Date.now() / 1000)
  for (const [id, nick, card] of [[101, 'OnlyNickname', ''], [102, 'IgnoredNickname', 'PreferredCard']]) {
    emitRaw(h.kernel, { post_type: 'message', message_type: 'group', group_id: GROUP_ID,
      user_id: MEMBER_QQ, message_id: id, time: ts, sender: { nickname: nick, card }, message: `contract-${id}` })
  }
  const archiveDir = h.kernel.runtime.archive.dir
  const archiveFile = path.join(archiveDir, `group_${GROUP_ID}.jsonl`)
  await waitFor(() => fs.existsSync(archiveFile) && fs.readFileSync(archiveFile, 'utf8').includes('contract-102'))
  const archived = fs.readFileSync(archiveFile, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(archived[0].sender.name, 'OnlyNickname')
  assert.equal(archived[0].sender.nickname, undefined, 'test must use real normalized sender shape')
  let prompt
  const accumulator = createAccumulator({
    bot: { core: { archive: { dir: archiveDir } }, dsh: { async runIsolatedTask(req) { prompt = req.prompt; return { text: '（无新增）' } } } },
    cfg: { accumulateMinNewMsgs: 1, accumulateKeepDays: 0 }, log: quiet,
    dataDirOf: () => h.dataDir, memoryDirOf: () => path.join(h.dataDir, 'test-memory'),
    readMemoryOf: () => null, invalidateMemoryOf() {},
  })
  await accumulator.sync({ confirm: true })
  assert.match(prompt, new RegExp(`OnlyNickname\\(${MEMBER_QQ}\\)`))
  assert.match(prompt, new RegExp(`PreferredCard\\(${MEMBER_QQ}\\)`))
  assert.doesNotMatch(prompt, /IgnoredNickname/)
})
