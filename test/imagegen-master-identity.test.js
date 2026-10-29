import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnContext } from '../contracts.js'
import { createPacing } from '../kernel/pacing.js'
import { ChatState } from '../kernel/state-pipeline.js'

test('合批身份：全主人保留豁免，混合成员不能借最后主人身份', () => {
  const quiet = { info() {}, warn() {}, error() {} }
  for (const members of [[true, true], [false, true], [true, false]]) {
    const pacing = createPacing({ state: new ChatState(), log: quiet })
    pacing.apply({ merge: { enabled: true, windowMs: 1000 } })
    let merged
    for (const [i, isMaster] of members.entries()) {
      const ev = { chatKey: 'group:20001', isGroup: true, messageId: i + 1, sender: { isMaster }, text: '画图', wake: { kind: 'at' }, _scratch: {}, hint: [] }
      ev.turnCtx = createTurnContext(ev)
      pacing.submit(ev, (value) => { merged = value })
    }
    pacing.flush('group:20001')
    assert.equal(merged.turnCtx.isMaster, members.every(Boolean))
    assert.equal(createTurnContext(merged).isMaster, members.every(Boolean))
    pacing.stop()
  }
})
