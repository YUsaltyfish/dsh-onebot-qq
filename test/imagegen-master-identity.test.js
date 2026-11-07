import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnContext } from '../contracts.js'
import { createPacing } from '../kernel/pacing.js'
import { ChatState } from '../kernel/state-pipeline.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 一次群聊唤醒 + 若干条"并入当前槽"的非唤醒消息 */
function mergeOne({ wakeMaster = true, mergedMasters = [] } = {}) {
  const pacing = createPacing({ state: new ChatState(), log: quiet })
  pacing.apply({ merge: { enabled: true, waitMs: 1000 } })
  let merged
  const mk = (isMaster, id, wake) => {
    const ev = {
      chatKey: 'group:20001', isGroup: true, groupId: 20001, messageId: id,
      sender: { qq: id + 100, name: 'X', isMaster }, text: '画图', _scratch: {}, hint: [], ...(wake ? { wake } : {}),
    }
    ev.turnCtx = createTurnContext(ev)
    return ev
  }
  pacing.submit(mk(wakeMaster, 1, { kind: 'at' }), (value) => { merged = value })
  mergedMasters.forEach((isMaster, i) => pacing.collect(mk(isMaster, i + 2, null)))
  pacing.flush('group:20001')
  pacing.stop()
  return merged
}

test('合批身份：全主人保留豁免，混合成员不能借唤醒者身份', () => {
  const allMaster = mergeOne({ wakeMaster: true, mergedMasters: [true, true] })
  assert.equal(allMaster.turnCtx.isMaster, true)
  assert.equal(createTurnContext(allMaster).isMaster, true)

  for (const mergedMasters of [[false], [true, false], [false, true]]) {
    const mixed = mergeOne({ wakeMaster: true, mergedMasters })
    assert.equal(mixed.turnCtx.isMaster, false, `合并里含普通成员就不能算主人轮：${mergedMasters}`)
    assert.equal(createTurnContext(mixed).isMaster, false)
  }
})

test('合批身份：唤醒者本人不是主人时，即使并入的全是主人也不算主人轮', () => {
  const merged = mergeOne({ wakeMaster: false, mergedMasters: [true] })
  assert.equal(merged.turnCtx.isMaster, false)
})
