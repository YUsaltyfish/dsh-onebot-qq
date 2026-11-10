import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { bootKernel, emitRaw, groupAtEvent, GROUP_ID } from './helpers.mjs'
import { createPacing } from '../kernel/pacing.js'
import { ChatState } from '../kernel/state-pipeline.js'
import { createTurnContext } from '../contracts.js'

test('memory source archive preserves real inbound quote and successful outbound trigger association', async (t) => {
  const h = await bootKernel({ config: { archive: { enabled: true }, pacing: { merge: { enabled: false } } } })
  t.after(() => h.dispose())
  await emitRaw(h.kernel, groupAtEvent({ messageId: 7101, replyTo: -7010, text: '这个外号不要再叫了' }))
  await h.kernel.deliver(`group:${GROUP_ID}`, '好的，不再这样叫', { turnCtx: { chatKey: `group:${GROUP_ID}`, triggerMsgId: 7101, wakeKind: 'at' } })
  const file = path.join(h.dataDir, 'logs', 'qq_chat', `group_${GROUP_ID}.jsonl`)
  const rows = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(String(rows.find((r) => r.dir === 'in' && r.messageId === 7101).replyTo), '-7010')
  const out = rows.find((r) => r.dir === 'out' && r.text.includes('不再这样叫'))
  assert.equal(out.triggerMsgId, 7101)
  assert.equal(out.wakeKind, 'at')
  const before = rows.length
  h.kernel.onebot.sendMessage = async () => { throw new Error('send failed') }
  await assert.rejects(h.kernel.deliver(`group:${GROUP_ID}`, '不能记为已发送'), /send failed/)
  assert.equal(fs.readFileSync(file, 'utf8').trim().split('\n').length, before)
})

test('merged interaction IDs survive disabled image loading and reach turn context', () => {
  const pacing = createPacing({ state: new ChatState(), log: { info() {}, warn() {}, debug() {}, error() {} } })
  pacing.apply({ merge: { enabled: true, waitMs: 5000, loadImages: false } })
  let merged
  const event = (id) => ({ chatKey: 'private:10001', messageId: id, sender: { qq: 10001 }, text: '消息' + id, wake: { kind: 'private' }, _scratch: {}, hint: [], images: [] })
  pacing.submit(event(101), (value) => { merged = value })
  pacing.collect(event(102))
  pacing.flush('private:10001')
  assert.deepEqual(createTurnContext(merged).interactionMessageIds, [101, 102])
  pacing.stop()
})

test('memory reading strips maintenance metadata without changing the raw document', async (t) => {
  const h = await bootKernel()
  t.after(() => h.dispose())
  const dir = path.join(h.dataDir, 'qq-memory')
  fs.mkdirSync(dir, { recursive: true })
  const raw = '# 对话记忆\n\n- 我接受了一个外号。 <!-- id=m1 -->\n<!-- qq-memory-v1:{"entries":[],"processed":[]} -->\n'
  const file = path.join(dir, `${GROUP_ID}.md`)
  fs.writeFileSync(file, raw)
  const result = await h.ctx._registeredTools.get('mcp__qq__read_memory').execute({ target: `group:${GROUP_ID}` })
  assert.match(result.memory, /接受了一个外号/)
  assert.doesNotMatch(result.memory, /qq-memory-v1|processed|id=m1/)
  assert.equal(fs.readFileSync(file, 'utf8'), raw)
})
