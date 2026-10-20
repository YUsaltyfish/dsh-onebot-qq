/**
 * test/audit-group-welcome.test.js — 入群欢迎子插件（固定句池 / 图片池 / 群范围 / 冷却 / 模型模式）。
 *
 * 迁移自旧 `audit-group-welcome.test.js`：保留行为级断言；删除站点 selfcheck 对照与旧内部实现细节。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID } from './helpers.mjs'

const NEWCOMER = 40001
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function increaseNotice({ qq = NEWCOMER, id = 7001, groupId = GROUP_ID } = {}) {
  return {
    post_type: 'notice',
    notice_type: 'group_increase',
    sub_type: 'approve',
    group_id: groupId,
    user_id: qq,
    target_id: qq,
    message_id: id,
    sender: { user_id: qq, nickname: '新人' },
  }
}

async function boot(t, welcome = {}, extra = {}) {
  const extraConfig = extra.config || {}
  const extraPlugins = extraConfig.pluginConfig || {}
  const h = await bootKernel({
    config: {
      pacing: { merge: { enabled: false } },
      ...extraConfig,
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
        'group-welcome': { enabled: true, delayMs: 0, groups: [GROUP_ID], ...welcome },
        ...extraPlugins,
      },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('装配：group-welcome 已加载；configSchema 已进入 kernel.pluginDefs（控制台可渲染）', async (t) => {
  const h = await boot(t)
  assert.ok(h.kernel.plugins.some((p) => p.id === 'group-welcome'))
  const def = h.kernel.pluginDefs.find((d) => d.id === 'group-welcome')
  assert.ok(def, 'pluginDefs 应包含 group-welcome')
  for (const key of ['enabled', 'mode', 'groups', 'lines', 'delayMs', 'imageChance']) {
    assert.ok(key in def.configSchema, `configSchema 应有 ${key}`)
  }
})

test('固定句池：占位符替换 + @ 新人 + 零 token（不进模型）', async (t) => {
  const h = await boot(t, { lines: '欢迎 {name} 加入 {group}！', atNewcomer: true })
  await emitRaw(h.kernel, increaseNotice())
  const sent = await waitFor(() => h.sent[0], { label: '欢迎消息' })
  assert.ok(sent.wire.includes('欢迎 新人 加入 测试群'), `占位符应替换：${sent.wire}`)
  assert.ok(sent.wire.includes(`[CQ:at,qq=${NEWCOMER}]`), '@ 新人')
  assert.equal(h.ctx._prompts.length, 0, '固定句池不叫模型（零 token）')
})

test('固定句池：@ 关掉；未知占位符原样保留不炸', async (t) => {
  const h = await boot(t, { lines: '欢迎 {name}{unknown_x} 光临', atNewcomer: false })
  await emitRaw(h.kernel, increaseNotice())
  const sent = await waitFor(() => h.sent[0], { label: '欢迎消息' })
  assert.ok(sent.wire.includes('{unknown_x}'), '未知占位符原样保留')
  assert.equal(sent.wire.includes('[CQ:at,'), false, 'atNewcomer=false 不带 @')
})

test('群范围：白名单未勾 → 不欢迎；* → 所有群；整群屏蔽 → pre-gate 拦下', async (t) => {
  const h = await boot(t, { groups: [] })
  await emitRaw(h.kernel, increaseNotice())
  await sleep(80)
  assert.equal(h.sent.length, 0, 'groups 为空不欢迎')

  const h2 = await boot(t, { groups: ['*'] })
  await emitRaw(h2.kernel, increaseNotice())
  await waitFor(() => h2.sent[0], { label: '*' })

  const h3 = await boot(t, { groups: ['*'] }, { config: { pluginConfig: { 'gate-wake': { adminQq: ADMIN_QQ, ignoreGroups: [GROUP_ID] } } } })
  await emitRaw(h3.kernel, increaseNotice())
  await sleep(80)
  assert.equal(h3.sent.length, 0, '屏蔽群不欢迎')
})

test('冷却：同一人同群冷却内只欢迎一次', async (t) => {
  const h = await boot(t, { cooldownMs: 10, lines: '欢迎 {name}' })
  await emitRaw(h.kernel, increaseNotice({ id: 7001 }))
  await waitFor(() => h.sent[0], { label: '第一次欢迎' })
  await emitRaw(h.kernel, increaseNotice({ id: 7002 }))
  await sleep(120)
  assert.equal(h.sent.length, 1, '冷却内重复入群不再欢迎')
})

test('图片池：概率 100 时文字后附图；目录不存在只发文字', async (t) => {
  const imgDir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-wel-')), 'imgs')
  fs.mkdirSync(imgDir, { recursive: true })
  fs.writeFileSync(path.join(imgDir, 'a.png'), 'fake-png')
  const h = await boot(t, { imageChance: 100, imageDir: imgDir, lines: '欢迎' })
  await emitRaw(h.kernel, increaseNotice())
  await waitFor(() => h.sent.length >= 2, { label: '文字 + 图片' })
  assert.ok(h.sent.some((s) => s.kind === 'media'), '应发一条媒体')

  const h2 = await boot(t, { imageChance: 100, imageDir: path.join(imgDir, 'nope'), lines: '欢迎' })
  await emitRaw(h2.kernel, increaseNotice())
  await sleep(120)
  assert.equal(h2.sent.length, 1, '图片目录不存在只发文字')
  assert.equal(h2.sent[0].kind, 'msg')
})

test('模型模式：入群通知合成 welcome 回合（prompt 含新人）；模型没出站 → 句池兜底补发', async (t) => {
  const h = await boot(t, { mode: 'model', modelFallback: true, modelFallbackMs: 0.05, lines: '句池兜底欢迎', groups: ['*'] })
  await emitRaw(h.kernel, increaseNotice())
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: 'welcome 回合' })
  const text = prompt.content[0].text
  assert.ok(text.includes('[入群欢迎轮'), `prompt 应标记欢迎轮：${text}`)
  assert.ok(text.includes('新人') || text.includes(String(NEWCOMER)), 'prompt 含新人信息')
  const sent = await waitFor(() => h.sent[0], { label: '兜底句池' })
  assert.ok(sent.wire.includes('句池兜底欢迎'), '模型没出站 → 句池兜底')
})
