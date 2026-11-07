/**
 * 回归：引用目标必须绑定到「真正在跑的那一轮 DSH 回合」。
 *
 * 历史 bug：A 聊完一轮后 B/C 唤醒机器人，回复却引用了 A。
 * 根因是锚在 prompt admission 时就被 pop，出站只能回退 activeTurns / 最后一个提交的回合。
 * 现在出站直接取 turn/start 绑定的上下文；不再按队首或超时猜测归属。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'

import { ChatState, Pipeline, currentTurn, turnStore } from '../kernel/state-pipeline.js'
import { createTurnContext } from '../contracts.js'
import { bootKernel, emitRaw, groupAtEvent, waitFor, ADMIN_QQ, GROUP_ID } from './helpers.mjs'

const quiet = { info() {}, debug() {}, warn() {}, error() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function emitTurn(ctx, sessionId, type) {
  ctx.emit('session/event', { id: sessionId }, { type })
}

async function boot(t) {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      outbound: { quoteAfterMsgs: 1 },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('ChatState.consumeTurnAnchor：按 turn/end 消费队首，不误删下一轮', () => {
  const s = new ChatState({ log: quiet })
  s.markTurnAnchor('group:1', 100)
  s.markTurnAnchor('group:1', 200)
  s.countArrival('group:1', 300)

  assert.equal(s.quoteNeed('group:1', 1).triggerId, 100, '队首 = 正在回的那轮')
  s.consumeTurnAnchor('group:1', 100)
  assert.equal(s.quoteNeed('group:1', 1).triggerId, 200, '消费后下一轮成为队首')
  assert.equal(s.quoteNeed('group:1', 1).arrived, 1, '插话计数不串轮')
  s.consumeTurnAnchor('group:1', 200)
  assert.equal(s.quoteNeed('group:1', 1).triggerId, null)
})

test('出站引用跟随 turn/start：A 生成中 B/C 已提交，A 仍引 A；轮末才换人', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  const prompts = []
  h.ctx.setPromptHandler(async (req) => {
    prompts.push({ sid: req.sessionId, text: req.content[0].text })
  })

  // A 唤醒并 admission（注意：不触发 turn/start —— 模拟 DSH 还没开始跑）
  await emitRaw(h.kernel, groupAtEvent({ text: 'A', messageId: 1001 }))
  await waitFor(() => prompts.length >= 1, { label: 'A prompt' })
  const sid = prompts[0].sid

  // A 还没开始跑时，B/C 也提交了（旧实现会把映射覆盖成 C）
  await emitRaw(h.kernel, groupAtEvent({ text: 'B', messageId: 1002 }))
  await emitRaw(h.kernel, groupAtEvent({ text: 'C', messageId: 1003 }))
  await waitFor(() => prompts.length >= 3, { label: 'B/C prompt' })

  // A 的回合真正开始 → 工具执行应认 A
  emitTurn(h.ctx, sid, 'turn/start')
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-A' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1001]'), `A 回复应引 A：${h.sent.at(-1).wire}`)

  // A 轮结束 → 消费 A 锚；B 开始 → B 回复引 B
  emitTurn(h.ctx, sid, 'turn/end')
  emitTurn(h.ctx, sid, 'turn/start')
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-B' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1002]'), `B 回复应引 B：${h.sent.at(-1).wire}`)

  // B 轮结束；C 开始，先来一条 D 插话再回
  emitTurn(h.ctx, sid, 'turn/end')
  emitTurn(h.ctx, sid, 'turn/start')
  await emitRaw(h.kernel, groupAtEvent({ text: 'D', messageId: 1004, at: false }))
  await sleep(20)
  await send.execute({ target: `group:${GROUP_ID}`, text: 'reply-C' }, { agent: { session: { id: sid } } })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=1003]'), `C 回复应引 C：${h.sent.at(-1).wire}`)

  // C 轮结束；之后普通命令/出站没有回合上下文 → 不许再挂旧引用
  emitTurn(h.ctx, sid, 'turn/end')
  await emitRaw(h.kernel, groupAtEvent({ text: '/help', messageId: 1005, at: false }))
  await waitFor(() => h.sent.length >= 4, { label: '/help 回复' })
  assert.equal(h.sent.at(-1).wire.includes('[CQ:reply'), false, `/help 不应引用上一轮：${h.sent.at(-1).wire}`)
})

test('超过五轮排队及长回合：引用只认本轮，不被队列容量或TTL挤掉', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  for (let i = 0; i < 7; i += 1) {
    await emitRaw(h.kernel, groupAtEvent({ text: `消息${i}`, messageId: 3001 + i }))
  }
  await waitFor(() => h.ctx._prompts.length === 7, { label: '七轮准入' })
  const sid = h.ctx._prompts[0].sessionId
  t.mock.timers.enable({ apis: ['setTimeout'] })
  emitTurn(h.ctx, sid, 'turn/start')
  t.mock.timers.tick(6 * 60000)
  await send.execute({ target: `group:${GROUP_ID}`, text: '长回合回复' }, { agent: { session: { id: sid } } })
  assert.match(h.sent.at(-1).wire, /\[CQ:reply,id=3001\]/)
  assert.equal(h.kernel.turnBySession.get(sid).triggerMsgId, 3001)
  emitTurn(h.ctx, sid, 'turn/end')
  assert.equal(h.kernel.turnBySession.has(sid), false)
  emitTurn(h.ctx, sid, 'turn/start')
  await send.execute({ target: `group:${GROUP_ID}`, text: '下一轮回复' }, { agent: { session: { id: sid } } })
  assert.match(h.sent.at(-1).wire, /\[CQ:reply,id=3002\]/)
})

test('未到 turn/start 就失败：不留下永久锚', async (t) => {
  const h = await boot(t)
  h.kernel.onebot.msgById = h.kernel.onebot.msgById || (async () => null)
  // 让 prompt 直接失败（非 session-gone），这一轮不会发生
  h.ctx.setPromptHandler(async () => { throw new Error('boom') })
  await emitRaw(h.kernel, groupAtEvent({ text: '失败', messageId: 2001 }))
  await waitFor(() => h.sent.length >= 1, { label: '错误兜底出站' })
  const q = h.kernel.state.get(`group:${GROUP_ID}`).turnQueue
  assert.equal(q.length, 0, '失败的轮次不应留下锚')
  assert.equal(h.kernel.pendingTurns.size, 0, '失败的轮次不应留在待启动队列')
})

// ─────────────────────────────────────────────────────────────────────────────
// 2026-11-05 回归：ALS 泄漏导致排队轮全部引用第一轮唤醒
// 根因：Pipeline.run 把 terminal 包在 turnStore.run 里 → pacing.submit 在其中排等待槽定时器
//       → Node 定时器 / DSH agent 长期循环继承旧 store → 排队轮的工具认成第一轮。
// ─────────────────────────────────────────────────────────────────────────────

test('Pipeline.run 的 terminal 不在 ALS 里跑（切断等待槽定时器/DSH 循环继承旧上下文）', async () => {
  const pipeline = new Pipeline({ log: quiet })
  const ev = {
    chatKey: 'private:1', isGroup: false, sender: { qq: 1 }, text: 'x',
    wake: { kind: 'private' }, hint: [], _scratch: {}, images: [],
  }
  let seen = 'unset'
  await pipeline.run(ev, () => { seen = currentTurn() })
  assert.equal(seen, null, 'terminal 执行时不应带任何 turnCtx 的 ALS store')
  assert.ok(ev.turnCtx, 'TurnContext 仍要挂到事件上供后续使用')
})

test('排队轮引用：工具执行时残留的旧 ALS 不能抢走本轮身份', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  await emitRaw(h.kernel, groupAtEvent({ text: 'A', messageId: 4001 }))
  await waitFor(() => h.ctx._prompts.length >= 1, { label: 'A prompt' })
  const sid = h.ctx._prompts[0].sessionId
  emitTurn(h.ctx, sid, 'turn/start')
  // 本轮期间群里又插了一句 → 满足自动引用阈值（arrivals ≥ 1）
  await emitRaw(h.kernel, groupAtEvent({ text: '插话', messageId: 4002, at: false }))

  // 模拟 DSH agent 循环里残留的"上一轮"上下文
  const stale = createTurnContext({
    chatKey: `group:${GROUP_ID}`, isGroup: true, messageId: 999,
    wake: { kind: 'at' }, sender: { qq: 1 }, _scratch: {},
  })
  await turnStore.run(stale, () => send.execute(
    { target: `group:${GROUP_ID}`, text: '回复' },
    { agent: { session: { id: sid } } },
  ))
  assert.match(h.sent.at(-1).wire, /\[CQ:reply,id=4001\]/, `应引本轮 4001，实际：${h.sent.at(-1).wire}`)
})

test('等待槽排队：连续多轮各自引用自己的唤醒，不串到第一轮', async (t) => {
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: true, waitMs: 40 } },
      outbound: { quoteAfterMsgs: 1 },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false, quoteEnforce: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  for (const [i, text] of ['第一问', '第二问', '第三问'].entries()) {
    await emitRaw(h.kernel, groupAtEvent({ text, messageId: 5001 + i }))
  }
  await waitFor(() => h.ctx._prompts.length >= 3, { label: '三轮准入' })
  // 三轮之后群里又来一句 → 每轮都比基线多出插话，满足自动引用阈值
  await emitRaw(h.kernel, groupAtEvent({ text: '插一句', messageId: 5004, at: false }))
  const sid = h.ctx._prompts[0].sessionId
  for (let i = 0; i < 3; i += 1) {
    emitTurn(h.ctx, sid, 'turn/start')
    await send.execute({ target: `group:${GROUP_ID}`, text: `回复${i}` }, { agent: { session: { id: sid } } })
    assert.match(
      h.sent.at(-1).wire,
      new RegExp(`\\[CQ:reply,id=${5001 + i}\\]`),
      `第 ${i + 1} 轮应引自己的唤醒，实际：${h.sent.at(-1).wire}`,
    )
    emitTurn(h.ctx, sid, 'turn/end')
  }
})
