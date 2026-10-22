/**
 * 群记忆「自动积累」内置调度器测试（group-memory 插件）。
 *
 * 覆盖：
 *  ① 开关关闭 → 不跑；
 *  ② 消息够 → 调后台任务 → 写回 + .revisions 备份 + 保留份数；
 *  ③ 消息太少 → 跳过、不调模型；
 *  ④ 模型输出无效（空）→ 不写盘、记入 failed；
 *  ⑤ 模型只写 `<<<GROUP>>>` 开头、漏 `<<<END>>>` 结尾（2026-10-22 线上实测）→ 仍能逐群解析、照常写回；
 *  ⑥ 批量 digest 让模型用 `memory_append` 工具提交（结构化，不走文本解析）；漏提交的群记失败、不推水位；
 *  ⑦ 状态结构（enabled / intervalHours / lastRunAt / nextDueAt / lastResult）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/group-memory/index.js'

const GROUP = '1122334455'
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

/** 造一个最小可用的 bot（只实现插件用到的能力）。 */
function makeBot({ dataDir, archiveDir, cfg = {}, runner }) {
  const shared = Object.create(null)
  const tools = new Map()
  const stages = []
  const bot = {
    id: 'group-memory',
    cfg: { dir: path.join(dataDir, 'qq-memory'), enabled: true, ...cfg },
    log: quiet,
    core: { dataDir, archive: { dir: archiveDir } },
    state: { get: () => undefined },
    shared,
    dsh: runner ? { runIsolatedTask: runner } : {},
    on(stage, fn) { stages.push([stage, fn]) },
    registerTool(name, def) { tools.set(name, def) },
    currentTurn: () => null,
  }
  return { bot, shared, tools, stages }
}

function writeArchive(archiveDir, rows, gid = GROUP) {
  fs.mkdirSync(archiveDir, { recursive: true })
  const lines = rows.map((r) => JSON.stringify(r)).join('\n') + '\n'
  fs.writeFileSync(path.join(archiveDir, `group_${gid}.jsonl`), lines)
}

function msg(ts, qq, nick, text, dir = 'in') {
  return { ts, dir, chat: `group:${GROUP}`, sender: { qq, nickname: nick }, text, messageId: ts }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-gm-'))
}

test('群记忆积累：消息够 → 调后台任务 → 写回 + 保留历史版本', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  writeArchive(archiveDir, [
    msg(now - 60_000, 111, '甲', '赫萝今天好安静'),
    msg(now - 50_000, 222, '乙', '她可能在忙吧'),
    msg(now - 40_000, 111, '甲', '问她个问题试试'),
  ])
  let called = 0
  const runner = async ({ prompt }) => {
    called += 1
    assert.match(prompt, /甲\(111\)/)
    return { ok: true, text: '# 群记忆\n\n## 说话风格\n- 群友喜欢逗机器人，语气轻松\n- 常用 `赫萝` 称呼它\n\n## 群里的人\n- **甲(111)**：爱开玩笑，常在晚上出现\n- **乙(222)**：话少但会接梗' }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  plugin.setup(bot)

  const st0 = shared.memoryAccumulateStatus()
  assert.equal(st0.enabled, true)
  assert.equal(st0.running, false)
  assert.ok(st0.nextDueAt > Date.now(), '首次启动应留缓冲，不立刻跑')

  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  assert.deepEqual(r.updated, [GROUP])
  assert.equal(called, 1)

  const memFile = path.join(dataDir, 'qq-memory', `${GROUP}.md`)
  assert.match(fs.readFileSync(memFile, 'utf8'), /甲\(111\)/)
  const revDir = path.join(dataDir, 'qq-memory', '.revisions')
  assert.equal(fs.existsSync(revDir) ? fs.readdirSync(revDir).length : 0, 0, '首次写入没有旧版本可备份')

  const st = shared.memoryAccumulateStatus()
  assert.equal(st.running, false)
  assert.ok(st.lastRunAt > 0)
  assert.match(st.lastResult.message, /更新 1/)
})

test('群记忆积累：保留 N 份历史版本，超出自动清理', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const memDir = path.join(dataDir, 'qq-memory')
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, `${GROUP}.md`), '# 旧记忆\n\n## 说话风格\n- 旧的\n')
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 10_000, 111, '甲', '新话题出现了')])
  let n = 0
  const runner = async () => ({ ok: true, text: `# 群记忆\n\n## 说话风格\n- 第 ${++n} 版：群友在聊新话题，讨论很热烈\n\n## 群里的人\n- **甲(111)**：喜欢接梗\n` })
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    cfg: { accumulateMinNewMsgs: 1, accumulateRetainRevisions: 2 },
    runner,
  })
  plugin.setup(bot)
  for (let i = 0; i < 4; i += 1) {
    // 每轮写一条新消息（否则水位会把它当已消化，不会产生新版本）
    writeArchive(archiveDir, [msg(Date.now(), 111, '甲', `新话题出现了 ${i}`)])
    // eslint-disable-next-line no-await-in-loop
    const r = await shared.memoryAccumulateSync({ confirm: true })
    assert.equal(r.ok, true)
  }
  const revisions = fs.readdirSync(path.join(memDir, '.revisions'))
  assert.equal(revisions.length, 2, `应只保留 2 份，实际 ${revisions.length}`)
})

test('群记忆积累：消息太少跳过（不调模型）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '就一句')])
  let called = 0
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    cfg: { accumulateMinNewMsgs: 20 },
    runner: async () => { called += 1; return { ok: true, text: '# x' } },
  })
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(called, 0, '少于门槛不应调用模型')
  assert.deepEqual(r.updated, [])
  assert.deepEqual(r.skipped, [GROUP])
})

test('群记忆积累：开关关闭 / 模型输出无效 → 不写盘', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '有消息')])

  // 开关关闭：状态显示关，且定时到期时间 0
  {
    const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateEnabled: false, accumulateMinNewMsgs: 1 }, runner: async () => ({ ok: true, text: '# x' }) })
    plugin.setup(bot)
    const st = shared.memoryAccumulateStatus()
    assert.equal(st.enabled, false)
    assert.equal(st.nextDueAt, 0)
  }

  // 模型输出无效（空文本）→ 不写盘、计入 failed
  {
    const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner: async () => ({ ok: false, text: '' }) })
    plugin.setup(bot)
    const r = await shared.memoryAccumulateSync({ confirm: true })
    assert.equal(r.ok, true)
    assert.equal(r.updated.length, 0)
    assert.equal(r.failed.length, 1)
    assert.equal(fs.existsSync(path.join(dataDir, 'qq-memory', `${GROUP}.md`)), false, '无效输出不应写盘')
  }
})

test('群记忆积累：digest 两个群只调一次模型（批量 + 标记解析 + 水位）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const G2 = '2233445566'
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 3000, 111, '甲', '甲说话')])
  writeArchive(archiveDir, [msg(now - 2000, 222, '乙', '乙说话')], G2)
  let called = 0
  const runner = async () => {
    called += 1
    return {
      ok: true,
      text: `<<<GROUP:${GROUP}>>>\n- **甲(111)**：爱开玩笑\n- 风格：语气轻松\n<<<END:${GROUP}>>>\n`
        + `<<<GROUP:${G2}>>>\n- **乙(222)**：话少但会接根\n<<<END:${G2}>>>`,
    }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  assert.equal(called, 1, '两个群应合成一次调用')
  assert.equal(r.calls, 1)
  assert.deepEqual([...r.updated].sort(), [GROUP, G2].sort())
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${GROUP}.md`), 'utf8'), /甲\(111\)/)
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${G2}.md`), 'utf8'), /乙\(222\)/)

  // 第二轮：同一批消息不应再喂模型（消化水位）
  const r2 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(called, 1, '没有新消息时不应再调用模型')
  assert.equal(r2.calls, 0)
})

test('群记忆积累：模型漏写 <<<END>>> 标记也能解析（2026-10-22 线上实测格式）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const G2 = '2233445566'
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 3000, 111, '甲', '甲说话')])
  writeArchive(archiveDir, [msg(now - 2000, 222, '乙', '乙说话')], G2)
  // 线上真实形态：每个群只有 GROUP 开头行，一条 END 都没有
  const runner = async () => ({
    ok: true,
    text: `<<<GROUP:${GROUP}>>>\n- **甲(111)**：爱开玩笑\n\n<<<GROUP:${G2}>>>\n- **乙(222)**：话少但会接棗`,
  })
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.failed.length, 0, '漏 END 不应再整批失败')
  assert.deepEqual([...r.updated].sort(), [GROUP, G2].sort())
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${GROUP}.md`), 'utf8'), /甲\(111\)/)
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${G2}.md`), 'utf8'), /乙\(222\)/)
})

test('群记忆积累：digest 用 memory_append 工具提交（不走文本标签解析）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const G2 = '2233445566'
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 3000, 111, '甲', '甲说话')])
  writeArchive(archiveDir, [msg(now - 2000, 222, '乙', '乙说话')], G2)
  let called = 0
  let submit = null
  const runner = async ({ prompt }) => {
    called += 1
    assert.match(prompt, /memory_append/, '批量 digest 提示词应要求用工具提交')
    // 模拟模型在回合内逐群调工具；正文完全不含 <<<GROUP>>> 标记
    submit({ group_id: GROUP, points: '- **甲(111)**：爱开玩笑\n- 风格：语气轻松' })
    submit({ group_id: G2, points: '- **乙(222)**：话少但会接根' })
    return { ok: true, text: '已提交' }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  assert.equal(called, 1, '仍然是两个群一次调用')
  assert.equal(r.failed.length, 0, '工具提交不应再出现格式失败')
  assert.deepEqual([...r.updated].sort(), [GROUP, G2].sort())
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${GROUP}.md`), 'utf8'), /甲\(111\)/)
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${G2}.md`), 'utf8'), /乙\(222\)/)
  // 模型回合结束后（普通会话/轮次外）工具应报错
  assert.throws(() => shared.memoryAccumulateSubmit({ group_id: GROUP, points: '- x' }), /没有进行中的群记忆积累轮次/)
})

test('群记忆积累：工具漏提交的群记失败、不推水位（下轮能重试）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const G2 = '2233445566'
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 3000, 111, '甲', '甲说话')])
  writeArchive(archiveDir, [msg(now - 2000, 222, '乙', '乙说话')], G2)
  let submit = null
  let round = 0
  const runner = async () => {
    round += 1
    if (round === 1) submit({ group_id: GROUP, points: '- **甲(111)**：爱开玩笑' }) // 故意漏 G2
    else { submit({ group_id: G2, points: '- **乙(222)**：话少但会接根' }) }
    return { ok: true, text: '' }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)
  const r1 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r1.failed.length, 1)
  assert.equal(r1.failed[0].gid, G2)
  // G2 没推水位 → 第二轮仍会喂它，提交后成功
  const r2 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(round, 2)
  assert.deepEqual(r2.updated, [G2])
  assert.match(fs.readFileSync(path.join(dataDir, 'qq-memory', `${G2}.md`), 'utf8'), /乙\(222\)/)
})

test('群记忆积累：车轮清理只删「已消化 且 过期」的原始记录', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const now = Date.now()
  writeArchive(archiveDir, [
    msg(now - 5 * 86400000, 111, '甲', '五天前的旧消息'),
    msg(now - 60_000, 222, '乙', '一分钟前的新消息'),
  ])
  // 预置状态：这个群已经消化到 now
  fs.mkdirSync(path.join(dataDir, 'state'), { recursive: true })
  fs.writeFileSync(path.join(dataDir, 'state', 'group-memory.json'),
    JSON.stringify({ groups: { [GROUP]: { digestedAt: now } } }))
  const { bot, shared } = makeBot({
    dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner: async () => ({ ok: true, text: '' }),
  })
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  const lines = fs.readFileSync(path.join(archiveDir, `group_${GROUP}.jsonl`), 'utf8').trim().split('\n').filter(Boolean)
  assert.equal(lines.length, 1, '只应保留未过期的一条')
  assert.match(lines[0], /一分钟前/)
  assert.equal(r.pruned.removed, 1)
})

test('群记忆积累：per-group 模式逐群各调一次', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const G2 = '2233445566'
  const now = Date.now()
  writeArchive(archiveDir, [msg(now - 1000, 111, '甲', '甲说话')])
  writeArchive(archiveDir, [msg(now - 900, 222, '乙', '乙说话')], G2)
  let called = 0
  const runner = async () => {
    called += 1
    return { ok: true, text: `# 群记忆\n\n## 说话风格\n- 第 ${called} 版：群友很活跃，喜欢在晚上聊天，语气轻松\n` }
  }
  const { bot, shared } = makeBot({
    dataDir, archiveDir, cfg: { accumulateMode: 'per-group', accumulateMinNewMsgs: 1 }, runner,
  })
  plugin.setup(bot)
  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(called, 2)
  assert.equal(r.calls, 2)
  assert.equal(r.updated.length, 2)
})
