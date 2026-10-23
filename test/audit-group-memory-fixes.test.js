/**
 * test/audit-group-memory-fixes.test.js — 群记忆 2026-10-23 修复回归。
 *
 * 覆盖：
 *  ① 写侧用未截断原文：>maxBytes 的记忆合并不丢尾，截断提示不落盘，备份是全文；
 *  ② 水位按「喂到的最新 ts」：采样跳过计数可见；积累期间到达的新消息不被标成已消化；
 *  ③ digest 解析 0 条不推水位（下轮还能重试）；
 *  ④ 单轮群数上限 + 轮转游标：第 13 个群不会被永久饿死；
 *  ⑤ 同一 QQ 的重复画像归一、run-on 拍平、临时内容（这轮…）丢弃；
 *  ⑥ `.revisions` 统一保留策略（含控制台 -manual 备份）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import plugin from '../plugins/group-memory/index.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

function makeBot({ dataDir, archiveDir, cfg = {}, runner }) {
  const shared = Object.create(null)
  const tools = new Map()
  const bot = {
    id: 'group-memory',
    cfg: { dir: path.join(dataDir, 'qq-memory'), enabled: true, ...cfg },
    log: quiet,
    core: { dataDir, archive: { dir: archiveDir } },
    state: { get: () => undefined },
    shared,
    dsh: runner ? { runIsolatedTask: runner } : {},
    on() {},
    registerTool(name, def) { tools.set(name, def) },
    currentTurn: () => null,
    onDispose() {},
  }
  return { bot, shared, tools }
}

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-gmfix-'))
}

function msg(ts, qq, nick, text, dir = 'in') {
  return { ts, dir, sender: { qq, nickname: nick }, text }
}

function writeArchive(archiveDir, rows, gid) {
  fs.mkdirSync(archiveDir, { recursive: true })
  fs.writeFileSync(path.join(archiveDir, `group_${gid}.jsonl`), rows.map((r) => JSON.stringify(r)).join('\n') + '\n')
}

function appendArchive(archiveDir, row, gid) {
  fs.appendFileSync(path.join(archiveDir, `group_${gid}.jsonl`), `${JSON.stringify(row)}\n`)
}

function readState(dataDir) {
  try { return JSON.parse(fs.readFileSync(path.join(dataDir, 'state', 'group-memory.json'), 'utf8')) } catch { return {} }
}

test('群记忆修复：>maxBytes 的记忆合并后不丢尾、截断提示不落盘、备份为全文', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const memDir = path.join(dataDir, 'qq-memory')
  const GROUP = '1122334455'
  fs.mkdirSync(memDir, { recursive: true })
  const pad = Array.from({ length: 120 }, (_, i) => `- 填充条目 ${i}：${'很长的一段群聊背景'.repeat(10)}`)
  const tail = '- 尾部唯一标记XYZ：这条必须活下来'
  fs.writeFileSync(path.join(memDir, `${GROUP}.md`), [
    '# 群记忆', '## 唤醒与对话风格', '- 简短回话', '## 群里的人', '- **甲(111)**：爱聊',
    '## 其它', ...pad, '…（本群记忆过长已截断，请精简文件）', tail, '',
  ].join('\n'))
  assert.ok(fs.statSync(path.join(memDir, `${GROUP}.md`)).size > 24000, 'fixture 应超过 maxBytes')

  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '新消息')], GROUP)
  let submit = null
  const runner = async () => {
    submit({ group_id: GROUP, points: '- **乙(222)**：新来的' })
    return { ok: true, text: '已提交' }
  }
  const { bot, shared, tools } = makeBot({
    dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1, accumulateRetainRevisions: 5 }, runner,
  })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)

  // 返回给模型的仍按 maxBytes 截断，并明确告诉它被截断了（在合并把文件缩到上限内之前测）
  const tool = tools.get('read_memory')
  const before = await tool.execute({ target: `group:${GROUP}` })
  assert.equal(before.clipped, true)
  assert.match(String(before.hint || ''), /截断/)

  const r = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r.ok, true)
  assert.equal(r.failed.length, 0, JSON.stringify(r.failed))

  const text = fs.readFileSync(path.join(memDir, `${GROUP}.md`), 'utf8')
  assert.ok(text.includes('尾部唯一标记XYZ'), '超过 maxBytes 的尾部不能被合并写回丢掉')
  assert.equal(text.includes('本群记忆过长已截断'), false, '旧版截断提示应在合并时清掉')
  const revs = fs.readdirSync(path.join(memDir, '.revisions'))
  assert.ok(revs.length >= 1, '应留下旧版备份')
  const revText = fs.readFileSync(path.join(memDir, '.revisions', revs[0]), 'utf8')
  assert.ok(revText.includes('尾部唯一标记XYZ'), '备份必须是未截断全文')

  // 合并后文件应回到读取上限以内 → 读侧不再截断
  const after = await tool.execute({ target: `group:${GROUP}` })
  assert.equal(Boolean(after.clipped), false)
})

test('群记忆修复：采样跳过可见；积累期间到达的新消息不被推进水位', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const GROUP = '1122334455'
  const now = Date.now()
  const rows = Array.from({ length: 30 }, (_, i) => msg(now - 30_000 + i * 1000, 111, '甲', `m${i}`))
  writeArchive(archiveDir, rows, GROUP)

  let calls = 0
  let submit = null
  const prompts = []
  const runner = async ({ prompt }) => {
    calls += 1
    prompts.push(prompt)
    if (calls === 1) {
      // 模拟“模型调用期间群里又来了一条”：写进留档，时间戳晚于本轮喂到的最后一条
      appendArchive(archiveDir, msg(Date.now(), 222, '乙', 'during-run'), GROUP)
      submit({ group_id: GROUP, points: '- **甲(111)**：活跃' })
    } else {
      submit({ group_id: GROUP, points: '- **乙(222)**：新来的' })
    }
    return { ok: true, text: '已提交' }
  }
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    cfg: { accumulateMinNewMsgs: 1, accumulateMsgPerGroup: 20, accumulateMaxChars: 30000 },
    runner,
  })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)

  const r1 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r1.sampledOut, 10, `应把超出的 10 条记为采样跳过，实际 ${r1.sampledOut}`)
  const st1 = readState(dataDir)
  const fedTs = st1.groups?.[GROUP]?.digestedAt
  assert.ok(fedTs > 0, '水位应推进到已喂消息的 ts')
  assert.ok(fedTs < Date.now() - 1000, '水位不能是 Date.now()（会吞掉调用期间的新消息）')

  const r2 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(calls, 2, '积累期间到达的新消息应在下一轮被处理')
  assert.match(prompts[1], /during-run/)
  assert.equal(r2.sampledOut, 0)
})

test('群记忆修复：digest 解析 0 条不推水位、不写盘（下轮可重试）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const GROUP = '1122334455'
  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '一条消息')], GROUP)

  let calls = 0
  const errors = []
  let submit = null
  const runner = async () => {
    calls += 1
    try { submit({ group_id: GROUP, points: '这是一段没有列表的总结，模型没按格式提交' }) } catch (e) { errors.push(String(e.message)) }
    return { ok: true, text: '' }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)

  const r1 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r1.failed.length, 1)
  assert.ok(errors.length >= 1 && /列表行/.test(errors[0]))
  assert.equal(fs.existsSync(path.join(dataDir, 'qq-memory', `${GROUP}.md`)), false, '不应写盘')
  const st = readState(dataDir)
  assert.equal(st.groups?.[GROUP]?.digestedAt, undefined, '解析 0 条不能推水位')

  await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(calls, 2, '水位没动 → 下一轮还能重试')
})

test('群记忆修复：单轮群数上限 + 轮转游标（第 13 个群不会被饿死）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const gids = Array.from({ length: 13 }, (_, i) => `10000000${String(i).padStart(2, '0')}`)
  for (const gid of gids) writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '消息')], gid)

  const runner = async () => ({ ok: true, text: '' }) // 不提交 → 每个群 failed（测调度，不测写入）
  const { bot, shared } = makeBot({
    dataDir, archiveDir,
    cfg: { accumulateMinNewMsgs: 1, accumulateMaxGroupsPerRound: 12 },
    runner,
  })
  plugin.setup(bot)
  const r1 = await shared.memoryAccumulateSync({ confirm: true })
  assert.equal(r1.groups, 12)
  assert.equal(r1.deferred, 1)
  const first = new Set(r1.failed.map((x) => x.gid))
  assert.equal(first.size, 12)
  assert.equal(first.size + r1.deferred, gids.length)

  const r2 = await shared.memoryAccumulateSync({ confirm: true })
  const second = new Set(r2.failed.map((x) => x.gid))
  const union = new Set([...first, ...second])
  assert.equal(union.size, gids.length, '两轮合起来应覆盖全部 13 个群（游标轮转）')
  assert.ok([...second].some((g) => !first.has(g)), '第二轮应从上次游标之后开始')
})

test('群记忆修复：同 QQ 重复画像归一、run-on 拍平、临时内容丢弃', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const memDir = path.join(dataDir, 'qq-memory')
  const GROUP = '1122334455'
  fs.mkdirSync(memDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, `${GROUP}.md`), [
    '# 群记忆',
    '## 唤醒与对话风格', '- 简短回话',
    '## 群里的人',
    '- **老名(123456789)**：爱发图；**123456789（另一个名）**：熬夜',
    '- **老名(123456789)**：技术向',
    '## 其它', '',
  ].join('\n'))
  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '新消息')], GROUP)

  let submit = null
  const runner = async () => {
    submit({
      group_id: GROUP,
      points: [
        '- **新名(123456789)**：最近在学 MC',
        '- **丙(987654321)**：新人',
        '- 这轮群里在聊显卡',
        '- **老名(123456789)**：这轮在折腾显卡',
      ].join('\n'),
    })
    return { ok: true, text: '已提交' }
  }
  const { bot, shared } = makeBot({ dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1 }, runner })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)
  await shared.memoryAccumulateSync({ confirm: true })

  const text = fs.readFileSync(path.join(memDir, `${GROUP}.md`), 'utf8')
  const lines = text.split('\n').filter((l) => l.includes('123456789'))
  assert.equal(lines.length, 1, `同一 QQ 应只剩一条画像，实际 ${lines.length}`)
  assert.equal(text.includes('；**'), false, '不能出现一条里套两条的 run-on')
  for (const fact of ['爱发图', '熬夜', '技术向', '最近在学 MC']) assert.ok(lines[0].includes(fact), `应保留事实：${fact}`)
  assert.match(lines[0], /新名/, '昵称以新提交的为准')
  assert.ok(text.includes('丙(987654321)'), '新人应写入')
  assert.equal(text.includes('这轮'), false, '「这轮…」临时内容应丢弃')
})

test('群记忆修复：.revisions 统一保留策略（-manual 备份也会被清理）', async () => {
  const dataDir = tmp()
  const archiveDir = path.join(dataDir, 'logs', 'qq_chat')
  const memDir = path.join(dataDir, 'qq-memory')
  const revDir = path.join(memDir, '.revisions')
  const GROUP = '1122334455'
  fs.mkdirSync(revDir, { recursive: true })
  fs.writeFileSync(path.join(memDir, `${GROUP}.md`), '# 群记忆\n## 唤醒与对话风格\n- 旧\n## 群里的人\n## 其它\n')
  fs.writeFileSync(path.join(revDir, `${GROUP}-20260101-000000-manual.md`), 'old manual\n')
  fs.writeFileSync(path.join(revDir, `${GROUP}-20260101-000001.md`), 'old auto\n')
  writeArchive(archiveDir, [msg(Date.now() - 1000, 111, '甲', '新消息')], GROUP)

  let submit = null
  const runner = async () => {
    submit({ group_id: GROUP, points: '- 风格：简短回话' })
    return { ok: true, text: '已提交' }
  }
  const { bot, shared } = makeBot({
    dataDir, archiveDir, cfg: { accumulateMinNewMsgs: 1, accumulateRetainRevisions: 1 }, runner,
  })
  submit = (args) => bot.shared.memoryAccumulateSubmit(args)
  plugin.setup(bot)
  await shared.memoryAccumulateSync({ confirm: true })

  const names = fs.readdirSync(revDir)
  assert.equal(names.length, 1, `retain=1 应只留一份，实际 ${names.join(',')}`)
  assert.equal(names.some((n) => n.endsWith('-manual.md')), false, 'manual 备份也要纳入保留策略')
})
