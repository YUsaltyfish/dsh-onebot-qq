/**
 * test/audit-voice-spontaneous.test.js — 出站钩子链 / 拆条 / 句池 / 主动接话轮。
 *
 * 迁移自旧 `audit-voice-spontaneous.test.js`：保留行为级断言；删除旧实现顺序快照、站点自检对照。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { pickSplitPoint, splitBubbles } from '../kernel/format.js'
import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent, privateEvent } from './helpers.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function boot(t, { config = {}, pacing = null } = {}) {
  const h = await bootKernel({
    config: {
      pacing: pacing || { merge: { enabled: false }, reply: { quietHours: { enabled: false } } },
      ...config,
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        ...(config.pluginConfig || {}),
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('quoteEnforce：模型引用「刚触发本轮」的消息且插话未达门槛 → 抹掉；引用更早的消息保留', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    // 真机链路：DSH 开一轮 → 工具执行 → 轮结束（turn/start 才绑定本轮上下文）
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/start' })
    await send.execute({ target: `group:${GROUP_ID}`, text: '回复刚来的那条', reply_to: 88 }, { agent: { session: { id: req.sessionId } } })
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end' })
  })
  // 本轮 triggerMsgId 由入站消息（88）决定
  h.kernel.activeTurns.set(`group:${GROUP_ID}`, null)

  await emitRaw(h.kernel, groupAtEvent({ text: '触发', messageId: 88 }))
  await waitFor(() => h.sent.length >= 1, { label: '第一次出站' })
  assert.equal(h.sent.at(-1).wire.includes('[CQ:reply'), false, '引用刚触发消息（零信息量）被抹掉')

  h.ctx.setPromptHandler(async (req) => {
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/start' })
    await send.execute({ target: `group:${GROUP_ID}`, text: '回复更早那条', reply_to: 77 }, { agent: { session: { id: req.sessionId } } })
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end' })
  })
  // 新一轮：消息 89，turnCtx.triggerMsgId=89，显式引用 77 ≠ 触发消息 → 保留
  await emitRaw(h.kernel, groupAtEvent({ text: '触发2', messageId: 89 }))
  await waitFor(() => h.sent.length >= 2, { label: '第二次出站' })
  assert.ok(h.sent.at(-1).wire.includes('[CQ:reply,id=77]'), '引用更早的旧消息应保留')
})

test('拆条：长回复拆成两条、都走唯一出站口；短回复/带 CQ 不拆', async (t) => {
  const h = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 6, splitReplyDelayMs: 0 } } },
  })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: '好呀，这个我知道。今天天气不错，适合出去玩，要不要一起？' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 101 }))
  await waitFor(() => h.sent.length >= 2, { label: '拆成两条' })
  await sleep(80)
  assert.equal(h.sent.length, 2, '拆条 = 两条出站（后面每条走 bot.deliver）')
  assert.ok(h.sent[0].wire && h.sent[1].wire, '两条都有实际内容')

  // 多句 → 按「最多拆几条」发 3 条（默认 3）
  const h3 = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 6, splitReplyDelayMs: 0 } } },
  })
  const send3 = h3.ctx._registeredTools.get('mcp__qq__send_message')
  h3.ctx.setPromptHandler(async (req) => {
    await send3.execute({ target: `group:${GROUP_ID}`, text: '行。东西都留在本机。哪天想接着调再喊咱' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h3.kernel, groupAtEvent({ text: '在吗', messageId: 111 }))
  await waitFor(() => h3.sent.length >= 3, { label: '拆成三条' })
  await sleep(80)
  assert.equal(h3.sent.length, 3, '三句应拆成三条（不是固定两条）')

  // 上限 2：同样三句只拆两条
  const h4 = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 6, splitReplyDelayMs: 0, splitReplyMaxParts: 2 } } },
  })
  const send4 = h4.ctx._registeredTools.get('mcp__qq__send_message')
  h4.ctx.setPromptHandler(async (req) => {
    await send4.execute({ target: `group:${GROUP_ID}`, text: '行。东西都留在本机。哪天想接着调再喊咱' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h4.kernel, groupAtEvent({ text: '在吗', messageId: 112 }))
  await waitFor(() => h4.sent.length >= 2, { label: '上限两条' })
  await sleep(80)
  assert.equal(h4.sent.length, 2, 'splitMaxParts=2 → 只拆两条')

  // 短回复不拆
  const h2 = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 50, splitReplyDelayMs: 0 } } },
  })
  const send2 = h2.ctx._registeredTools.get('mcp__qq__send_message')
  h2.ctx.setPromptHandler(async (req) => {
    await send2.execute({ target: `group:${GROUP_ID}`, text: '好呀' }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h2.kernel, groupAtEvent({ text: '在吗', messageId: 102 }))
  await waitFor(() => h2.sent.length >= 1, { label: '短回复' })
  await sleep(80)
  assert.equal(h2.sent.length, 1, '短于 minLen 不拆')
})

test('主动接话轮硬约束：不 @、不引用、不套长文卡片（代码强制，不靠提示词）', async (t) => {
  const h = await boot(t)
  const turnCtx = { wakeKind: 'proactive', chatKey: `group:${GROUP_ID}`, triggerMsgId: null }
  const r = await h.kernel.deliver(`group:${GROUP_ID}`, '[AT:qq=555555] 随口插一句', { replyTo: 50, turnCtx })
  assert.equal(r.ats.length, 0, '主动接话剥掉 @')
  assert.equal(r.replyTo, null, '主动接话剥掉引用')
  assert.equal(h.sent.at(-1).wire.includes('[CQ:at'), false)
  assert.equal(h.sent.at(-1).wire.includes('[CQ:reply'), false)
})

test('句池三级回落：人设 .lines.txt → _默认.lines.txt → 内置兜底；改文件立刻生效（热读）', async (t) => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-voice-'))
  const personaDir = path.join(dataDir, 'personas')
  fs.mkdirSync(personaDir, { recursive: true })
  fs.writeFileSync(path.join(personaDir, 'tester.lines.txt'), '## poke\n专属戳一戳\n')
  fs.writeFileSync(path.join(personaDir, '_默认.lines.txt'), '## poke\n底池戳\n')

  const h = await bootKernel({
    dataDir,
    config: {
      pacing: { merge: { enabled: false } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { personaDir: 'personas', activePersona: 'tester', splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())
  h.kernel.onebot.poke = async () => false // 回戳不可用 → 用句池回一句

  const poke = (qq, id) => ({
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: GROUP_ID,
    user_id: qq,
    target_id: 999999,
  })
  await emitRaw(h.kernel, poke(50001, 1))
  await waitFor(() => h.sent.length === 1, { label: '人设句池' })
  assert.ok(h.sent[0].wire.includes('专属戳一戳'), `应走人设句池：${h.sent[0].wire}`)

  // 热读：改文件后下一条立刻生效（mtime/size 变化）
  await sleep(20)
  fs.writeFileSync(path.join(personaDir, 'tester.lines.txt'), '## poke\n改过的戳一戳\n')
  await emitRaw(h.kernel, poke(50002, 2))
  await waitFor(() => h.sent.length === 2, { label: '热读后' })
  assert.ok(h.sent[1].wire.includes('改过的戳一戳'), `句池应热读：${h.sent[1].wire}`)

  // 去掉人设句池 → 回落共享底池
  fs.unlinkSync(path.join(personaDir, 'tester.lines.txt'))
  await emitRaw(h.kernel, poke(50003, 3))
  await waitFor(() => h.sent.length === 3, { label: '底池回落' })
  assert.ok(h.sent[2].wire.includes('底池戳'), `人设缺节应回落底池：${h.sent[2].wire}`)
})

test('两条线并发：工具按 DSH 会话 id 认线，target 写错时按会话纠正（不串线）', async (t) => {
  const h = await boot(t)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  const sessions = []
  h.ctx.setPromptHandler(async (req) => {
    sessions.push(req.sessionId)
    // 真机链路：turn/start 绑定本轮（私聊），工具才能按会话纠正 target
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/start' })
    // 模型把 target 写成了群，但本轮其实是私聊会话 → 工具应按会话纠正
    await send.execute({ target: `group:${GROUP_ID}`, text: '我是私聊回复' }, { agent: { session: { id: req.sessionId } } })
    h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/end' })
  })
  await emitRaw(h.kernel, privateEvent({ text: '私聊一句', messageId: 110 }))
  await waitFor(() => h.sent.length >= 1, { label: '私聊出站' })
  assert.equal(h.sent.at(-1).target, `private:${ADMIN_QQ}`, '按会话纠正 target，不串到群里')
})

test('splitBubbles：按自然句拆 2~N 条；无断点/带 CQ → null；超上限合并最短相邻', () => {
  assert.deepEqual(splitBubbles('行。东西都留在本机。哪天想接着调再喊咱'), ['行。', '东西都留在本机。', '哪天想接着调再喊咱'])
  assert.deepEqual(splitBubbles('行。东西都留在本机。哪天想接着调再喊咱', { maxParts: 2 }).length, 2, 'maxParts=2 只拆两条')
  assert.equal(splitBubbles('这一整句没有句末标点所以拆不了'), null, '无自然断点不拆')
  assert.equal(splitBubbles('[CQ:image,file=a.png] 看图'), null, '带 CQ 码不拆')
  assert.equal(splitBubbles('嗯'), null, '单句不拆')
  const p = splitBubbles('好。行。那就这样。明天见。', { maxParts: 3 })
  assert.equal(p.length, 3, '四句按上限收到三条')
  assert.equal(p.join(''), '好。行。那就这样。明天见。', '拆完拼回去不能丢字')
})

test('pickSplitPoint 边界：短开头+正话才拆；首句过长/单句/带 CQ → null（降级单条）', () => {
  const split = pickSplitPoint('好呀，这个我知道。今天天气不错，适合出去玩。')
  assert.ok(Array.isArray(split) && split.length === 2, '有自然断点 → 拆两条')
  assert.equal(split[0] + split[1], '好呀，这个我知道。今天天气不错，适合出去玩。')
  assert.equal(pickSplitPoint('嗯'), null, '单句太短不拆')
  assert.equal(pickSplitPoint('这是一个特别特别特别特别特别特别特别特别特别特别长的句子没有断点'), null, '无自然断点不拆')
  assert.equal(pickSplitPoint('[CQ:image,file=a.png] 看图'), null, '带 CQ 码不拆')
})

test('插件热关：persona-voice.enabled=false → pick() 返回空，调用方回落各自内置兜底句', async (t) => {
  const h = await boot(t, {
    config: {
      pluginConfig: {
        'persona-voice': { enabled: false, splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  h.kernel.onebot.poke = async () => false
  const persona = h.kernel.plugins.find((p) => p.id === 'persona-voice')
  assert.equal(persona.cfg.enabled, false)
  const pick = h.kernel.shared.linesPool?.pick
  assert.equal(typeof pick, 'function', '共享槽仍在（访问器），只是内部禁用')
  assert.equal(pick('poke'), '', '热关后句池不返回内容（插件的裁决）')
  // gate-wake 的入口照旧能回一句：回落到它自己的内置兜底句
  await emitRaw(h.kernel, {
    post_type: 'notice',
    notice_type: 'notify',
    sub_type: 'poke',
    group_id: GROUP_ID,
    user_id: MEMBER_QQ,
    target_id: 999999,
  })
  await waitFor(() => h.sent.length >= 1, { label: 'poke 兜底句' })
  assert.ok(String(h.sent[0].wire).trim().length > 0, '句池关闭不哑火（gate-wake 内置兜底）')
})

test('拆条字数上限：默认 200（120~200 字可拆）、可配置上限生效', async (t) => {
  // 构造 120~200 字、含两个自然句的回复：旧默认 120 会挡掉，新默认 200 应能拆。
  const a = '今天天气不错适合出去玩要不要一起走远一点去山里看看然后回来路上顺便吃点东西'.repeat(2)
  const b = '好吧其实也行反正也没别的安排就这样定了到时候你叫我一声咱就出发别磨蹭'.repeat(2)
  const mid = `${a}。${b}。`
  assert.ok(mid.length > 120 && mid.length < 200, `测试文本长度应在 120~200：${mid.length}`)

  const h = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 6, splitReplyDelayMs: 0 } } },
  })
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.ctx.setPromptHandler(async (req) => {
    await send.execute({ target: `group:${GROUP_ID}`, text: mid }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h.kernel, groupAtEvent({ text: '在吗', messageId: 201 }))
  await waitFor(() => h.sent.length >= 2, { label: '默认上限 200 下应拆条' })
  assert.ok(h.sent[0].wire.length < mid.length, '第一条应是拆出来的短段')

  // 配置上限 100：同样的 150 字应保持单条
  const h2 = await boot(t, {
    config: { pluginConfig: { 'persona-voice': { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyMinLen: 6, splitReplyDelayMs: 0, splitReplyMaxChars: 100 } } },
  })
  const send2 = h2.ctx._registeredTools.get('mcp__qq__send_message')
  h2.ctx.setPromptHandler(async (req) => {
    await send2.execute({ target: `group:${GROUP_ID}`, text: mid }, { agent: { session: { id: req.sessionId } } })
  })
  await emitRaw(h2.kernel, groupAtEvent({ text: '在吗', messageId: 202 }))
  await waitFor(() => h2.sent.length >= 1, { label: '配置上限 100 下照常发送' })
  await sleep(80)
  assert.equal(h2.sent.length, 1, '超过配置上限应保持单条')
})
