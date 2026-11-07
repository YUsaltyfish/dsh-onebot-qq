import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { apply } from '../index.js'
import { createFakeOneBot } from './fake-onebot.mjs'
import { createMockCtx, tmpDir, writeInstanceConfig, waitFor, ADMIN_QQ, MEMBER_QQ } from './helpers.mjs'
import { readJsonFile, writeJsonFileSync } from '../platform/atomic.js'
import { Pipeline, createDeliver, turnStore } from '../kernel/state-pipeline.js'
import { createEvent } from '../contracts.js'

const settle = () => new Promise((resolve) => setImmediate(resolve))

async function fixture(t, { qq = ADMIN_QQ, gate = {}, saved = true } = {}) {
  const fake = createFakeOneBot()
  await fake.start()
  const dataDir = tmpDir('private-proactive')
  const stateFile = path.join(dataDir, 'state', 'private-proactive.json')
  const key = `private:${qq}`
  if (saved) writeJsonFileSync(stateFile, { [key]: { baselineAt: 1, lastInboundAt: 0, lastOutboundAt: 0, unanswered: 2, nextAt: 1 } })
  fs.mkdirSync(path.join(dataDir, 'qq-memory', 'private'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'qq-memory', 'private', `${qq}.md`), '- 私聊偏好：自然分享，不催回复')
  fs.mkdirSync(path.join(dataDir, 'qq-stickers'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'qq-stickers', 'one.png'), 'fake sticker')
  writeJsonFileSync(path.join(dataDir, 'qq-stickers', 'index.json'), { nextId: 2, items: [{ id: 1, file: 'one.png', tags: ['开心'], tagged: true }] })
  writeInstanceConfig(dataDir, {
    onebot: fake.url,
    pacing: { merge: { enabled: false }, reply: {
      enabled: true, hourlyMax: 3600, minGapMs: 1, privateChats: [qq], quietHours: { enabled: false },
      privatePolicy: { coldSilenceMs: 1, minGapMs: 1, unansweredGapMs: 1, maxBackoffMs: 1 },
      style: { splitEnabled: false, stickerProbability: 1 },
    } },
    pluginConfig: { 'gate-wake': gate, 'group-memory': { accumulateEnabled: false }, stickers: { offerCooldownMs: 0 } },
  })
  const ctx = createMockCtx({ workspacePath: path.join(dataDir, 'workspace') })
  await apply(ctx, { dataDir, autoConnect: false })
  const kernel = ctx.get('qqBot').kernel
  t.after(async () => { for (const fn of ctx._effects) fn(); await fake.close() })
  await kernel.onebot.connect()
  await waitFor(() => kernel.onebot.health().qqLoggedIn === true)
  return { fake, kernel, ctx, stateFile, key, dataDir }
}

function started(h) {
  const sid = h.ctx._prompts.at(-1).sessionId
  h.ctx.emit('session/event', { id: sid }, { type: 'turn/start' })
  return { sid, turn: h.kernel.turnBySession.get(sid), exec: { agent: { session: { id: sid } } } }
}

test('私聊主动轮真实协议：身份、记忆/表情初始化、不拉群上文、成功送达按轮计数并持久化', async (t) => {
  const h = await fixture(t)
  let synthetic
  h.kernel.pipeline.use('before-turn', (ev) => { synthetic = ev }, { order: 999 })
  h.kernel.pacing.tickNow()
  await waitFor(() => h.ctx._prompts.length)
  const text = h.ctx._prompts[0].content[0].text
  assert.match(text, /私聊主动候选/)
  assert.match(text, /不是对方发言/)
  assert.match(text, /silenceMs=\d+/)
  assert.match(text, /unanswered=2/)
  assert.match(text, /本私聊记忆/)
  assert.match(text, /\[表情:/)
  assert.doesNotMatch(text, /群里正聊着|\[群聊上文\]/)
  assert.equal(synthetic.sender.qq, ADMIN_QQ)
  assert.equal(synthetic.sender.isMaster, true)
  assert.equal(synthetic.messageId, null)
  assert.equal(synthetic.isGroup, false)
  assert.equal(h.fake.calls.some((c) => c.action === 'get_group_msg_history'), false)
  assert.equal(h.kernel.state.get(h.key).lastInboundAt, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
  const { sid, turn, exec } = started(h)
  assert.equal(turn.isMaster, true)
  assert.ok(turn.stickerOffer)
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  await send.execute({ target: 'group:20001', text: '突然想到一件开心的事', reply_to: 123 }, exec)
  await send.execute({ target: h.key, text: '也想顺便告诉你' }, exec)
  assert.equal(h.fake.sent.length, 2)
  assert.ok(h.fake.sent.every((s) => s.action === 'send_private_msg' && Number(s.params.user_id) === ADMIN_QQ))
  assert.ok(h.fake.sent.every((s) => !String(s.params.message).includes('CQ:reply')))
  const timing = readJsonFile(h.stateFile)[h.key]
  assert.equal(timing.unanswered, 3)
  assert.ok(timing.lastOutboundAt > 1)
  assert.deepEqual(Object.keys(timing).sort(), ['baselineAt', 'lastInboundAt', 'lastOutboundAt', 'nextAt', 'unanswered'].sort())
  if (process.platform !== 'win32') assert.equal(fs.statSync(h.stateFile).mode & 0o777, 0o600)
  h.ctx.emit('session/event', { id: sid }, { type: 'turn/end' })
  assert.equal(h.kernel.activeTurns.size, 0)
})

test('私聊非主人目标不借主人身份，pre-gate阻止名单外目标且不进wake/passive-tap', async (t) => {
  const h = await fixture(t, { qq: MEMBER_QQ, gate: { allowedUsers: [ADMIN_QQ] } })
  let wake = 0
  let passive = 0
  let identity
  h.kernel.pipeline.use('pre-gate', (ev) => { identity = ev.sender }, { order: 0 })
  h.kernel.pipeline.use('wake', () => { wake++ })
  h.kernel.pipeline.use('passive-tap', () => { passive++ })
  h.kernel.pacing.tickNow()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(identity.qq, MEMBER_QQ)
  assert.equal(identity.isMaster, false)
  assert.equal(wake, 0)
  assert.equal(passive, 0)
  assert.equal(h.fake.sent.length, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
})

test('私聊主动门禁异常fail-closed；未知登录不误判掉线但明确掉线阻止', async (t) => {
  const h = await fixture(t)
  h.kernel.onebot.loginOk = false
  h.kernel.pacing.tickNow()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  h.kernel.onebot.loginOk = true
  h.kernel.pipeline.use('pre-gate', () => { throw new Error('gate failed') }, { order: 0 })
  // 直接验证公共门禁的异常语义，且绝不触发wake。
  const ev = createEvent({ chatKey: h.key, sender: { qq: ADMIN_QQ } })
  assert.equal(await h.kernel.pipeline.checkGate(ev), false)
  assert.match(ev.stopReason, /pre-gate 插件异常/)
  assert.equal(h.fake.sent.length, 0)
})

test('before-turn等待时热移除私聊目标，恢复后不得建会话或提交模型', async (t) => {
  const h = await fixture(t)
  let resume
  h.kernel.pipeline.use('before-turn', async () => { await new Promise((resolve) => { resume = resolve }) }, { order: 0 })
  h.kernel.pacing.tickNow()
  await waitFor(() => resume)
  h.kernel.pacing.apply({ reply: { enabled: true, privateChats: [] } })
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._sessions.size, 0)
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
})

test('主动准入失败静默清pending且不污染activeTurns', async (t) => {
  const h = await fixture(t)
  h.ctx.setPromptHandler(async () => { throw new Error('private admission failed') })
  h.kernel.pacing.tickNow()
  await waitFor(() => h.ctx._prompts.length)
  await settle(); await settle()
  assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
  assert.equal(h.fake.sent.length, 0)
})

test('首次配置私聊目标在pacing构造阶段即可保存基线（无kernel/dsh TDZ）', async (t) => {
  const h = await fixture(t, { saved: false })
  const timing = readJsonFile(h.stateFile)[h.key]
  assert.ok(timing.baselineAt > 0)
  assert.equal(timing.unanswered, 0)
  assert.equal(h.ctx._prompts.length, 0)
})

test('已知非好友仍走原私聊门禁拦截（不复制好友规则）', async (t) => {
  const h = await fixture(t, { qq: MEMBER_QQ })
  h.kernel.state.privateFriendGate = { at: Date.now(), ids: new Set([ADMIN_QQ]), failedAt: 0 }
  h.kernel.pacing.tickNow()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.fake.sent.length, 0)
})

test('建会话等待期间名单变化，提交前再次拦住；不留下pending/active', async (t) => {
  const h = await fixture(t)
  let resume
  const create = h.ctx.sessionController.create
  h.ctx.sessionController.create = async (...args) => {
    await new Promise((resolve) => { resume = resolve })
    return create(...args)
  }
  h.kernel.pacing.tickNow()
  await waitFor(() => resume)
  h.kernel.pacing.apply({ reply: { enabled: true, privateChats: [] } })
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
})

test('私聊主动before-turn等待期间卸载，恢复后不创建会话', async (t) => {
  const h = await fixture(t)
  let resume
  h.kernel.pipeline.use('before-turn', async () => { await new Promise((resolve) => { resume = resolve }) }, { order: 0 })
  h.kernel.pacing.tickNow()
  await waitFor(() => resume)
  for (const fn of h.ctx._effects) fn()
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._sessions.size, 0)
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
  assert.equal(h.kernel.activeTurns.size, 0)
})

test('私聊计时重启恢复，不重置unanswered或已保留的未来机会', async (t) => {
  const h = await fixture(t)
  h.kernel.pacing.tickNow()
  await waitFor(() => h.ctx._prompts.length)
  const { exec } = started(h)
  await h.ctx._registeredTools.get('mcp__qq__send_message').execute({ target: h.key, text: '分享一个小念头' }, exec)
  const before = readJsonFile(h.stateFile)[h.key]
  for (const fn of h.ctx._effects) fn()
  const ctx = createMockCtx({ workspacePath: path.join(h.dataDir, 'workspace') })
  await apply(ctx, { dataDir: h.dataDir, autoConnect: false })
  t.after(() => { for (const fn of ctx._effects) fn() })
  const kernel = ctx.get('qqBot').kernel
  assert.deepEqual(kernel.pacing.privateStateSnapshot()[h.key], before)
  kernel.pacing.tickNow()
  await settle(); await settle()
  assert.equal(ctx._prompts.length, 0)
})

test('候选初始化期间真人私聊到达：只提交正常回复，静默放弃旧主动候选', async (t) => {
  const h = await fixture(t)
  let resume
  h.kernel.pipeline.use('before-turn', async (ev) => {
    if (ev.wake?.kind === 'proactive') await new Promise((resolve) => { resume = resolve })
  }, { order: 0 })
  h.kernel.pacing.tickNow()
  await waitFor(() => resume)
  h.fake.pushEvent(h.fake.privateMessage({ text: '刚才想起一件事' }))
  await waitFor(() => h.ctx._prompts.length === 1)
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 1)
  assert.match(h.ctx._prompts[0].content[0].text, /刚才想起一件事/)
  assert.doesNotMatch(h.ctx._prompts[0].content[0].text, /私聊主动候选/)
  assert.equal(readJsonFile(h.stateFile)[h.key].unanswered, 0)
})

test('跨入免打扰：私聊候选等待建会话时取消准入，普通私聊仍可回复', async (t) => {
  const h = await fixture(t)
  let quiet = false
  h.kernel.pacing.isQuietTime = () => quiet
  let resume
  const create = h.ctx.sessionController.create
  h.ctx.sessionController.create = async (...args) => {
    await new Promise((resolve) => { resume = resolve })
    return create(...args)
  }
  h.kernel.pacing.tickNow()
  await waitFor(() => resume)
  quiet = true
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
  h.fake.pushEvent(h.fake.privateMessage({ text: '现在可以正常回话吗' }))
  await waitFor(() => h.ctx._prompts.length === 1)
  const { exec } = started(h)
  await h.ctx._registeredTools.get('mcp__qq__send_message').execute({ target: h.key, text: '当然可以正常回复' }, exec)
  assert.equal(h.fake.sent.length, 1)
})

test('跨入免打扰：主动/续聊正文与媒体停止，普通轮正文媒体不受影响', async (t) => {
  const h = await fixture(t)
  let quiet = false
  h.kernel.pacing.isQuietTime = () => quiet
  const send = h.ctx._registeredTools.get('mcp__qq__send_message')
  h.kernel.pacing.tickNow()
  await waitFor(() => h.ctx._prompts.length)
  const { exec, turn } = started(h)
  await send.execute({ target: h.key, text: '时段之前可以发' }, exec)
  quiet = true
  for (const kind of ['proactive', 'continuation']) {
    turn.wakeKind = kind
    await assert.rejects(send.execute({ target: h.key, text: '时段之后不能主动发' }, exec), /免打扰/)
    await assert.rejects(turnStore.run(turn, () => h.kernel.sendMedia(h.key, '[CQ:image,file=fake.png]')), /免打扰/)
  }
  assert.equal(h.fake.sent.length, 1)
  turn.wakeKind = 'private'
  await send.execute({ target: h.key, text: '真人正常回复' }, exec)
  await turnStore.run(turn, () => h.kernel.sendMedia(h.key, '[CQ:image,file=fake.png]'))
  assert.equal(h.fake.sent.length, 3)
})

test('群主动/续聊候选跨入免打扰：异步历史完成后不再提交', async (t) => {
  const h = await fixture(t)
  let quiet = false
  h.kernel.pacing.isQuietTime = () => quiet
  const cfg = h.kernel.pacing.config
  h.kernel.pacing.apply({ ...cfg, reply: { ...cfg.reply, groups: [20001], privateChats: [], quietHours: { enabled: false }, coldSilenceMs: 1 } })
  h.kernel.pacing.stop()
  // 用真实机会时间配合Date.now推进，不修改调度实现。
  let resume
  h.kernel.dsh.fetchGroupContext = async () => { await new Promise((resolve) => { resume = resolve }); return '' }
  const now = Date.now
  let advanced = 0
  Date.now = () => now() + advanced
  try {
    h.kernel.pacing.tickNow() // 建立该群第一次机会
    advanced = 7200000
    h.kernel.pacing.tickNow()
    await waitFor(() => resume)
  } finally { Date.now = now }
  quiet = true
  resume()
  await settle(); await settle()
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.kernel.pendingTurns.size, 0)
})

test('主动拆条第一条后跨入免打扰，延迟尾条重过最终守卫不再发送', async (t) => {
  const h = await fixture(t)
  let quiet = false
  h.kernel.pacing.isQuietTime = () => quiet
  const voice = h.kernel.plugins.find((p) => p.id === 'persona-voice').cfg
  Object.assign(voice, { splitReplyEnabled: true, splitReplyProbability: 100, splitReplyDelayMs: 0, splitReplyMinLen: 1 })
  let guardedTail = false
  const sendMessage = h.kernel.onebot.sendMessage.bind(h.kernel.onebot)
  h.kernel.onebot.sendMessage = (...args) => {
    const sending = sendMessage(...args)
    quiet = true // 第一条已经通过最终守卫；在真实HTTP返回前稳定进入免打扰。
    return sending
  }
  h.kernel.deliver.onDecorate((out) => { if (out.blocked) guardedTail = true })
  h.kernel.pacing.tickNow()
  await waitFor(() => h.ctx._prompts.length)
  const { exec } = started(h)
  await h.ctx._registeredTools.get('mcp__qq__send_message').execute({ target: h.key, text: '今天想分享一件开心的小事。刚好也让我想起了你。' }, exec)
  await waitFor(() => guardedTail)
  assert.equal(h.fake.sent.length, 1)
})

test('最终beforeSend在异步装饰后和forward失败各分段前复查，媒体不套文本decorate', async () => {
  let quiet = false
  let sends = 0
  let decorates = 0
  const deliver = createDeliver({
    log: { info() {}, warn() {}, error() {} },
    onebot: {
      async sendMessage() { sends++; quiet = true; return 1 },
      async sendMedia() { sends++; return 2 },
      async sendForward() { throw new Error('forward failed') },
    },
    replyMaxLength: 10,
    beforeSend: () => { if (quiet) throw new Error('quiet guard') },
  })
  deliver.onDecorate(async () => { decorates++ })
  await assert.rejects(deliver('group:20001', '足够长的内容用于验证转发失败后分段不会越过时段继续发送'), /quiet guard/)
  assert.equal(sends, 1)
  await assert.rejects(deliver.media('group:20001', '[CQ:image,file=fake.png]'), /quiet guard/)
  assert.equal(decorates, 1)
  quiet = false
  deliver.onDecorate(async () => { await settle(); quiet = true })
  await assert.rejects(deliver('group:20001', '普通短句'), /quiet guard/)
  assert.equal(sends, 1)
})

test('Pipeline系统门禁检查不执行任何其他入站阶段', async () => {
  const p = new Pipeline()
  const calls = []
  for (const stage of p.stages.keys()) p.use(stage, () => { calls.push(stage) })
  assert.equal(await p.checkGate(createEvent({ chatKey: 'private:10001' })), true)
  assert.deepEqual(calls, ['pre-gate'])
})
