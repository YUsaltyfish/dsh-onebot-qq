/**
 * test/pacing-merge-v2.test.js — 等待槽（2026-11-04 重做）的行为：
 *   私聊合批（并入 + 刷新计时）/ 群聊唤醒各自成轮 / 非唤醒消息只并入当前槽 /
 *   忙线不等待 / 图片占位 / 卸载清槽 / 内核真实入站两条路径。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTurnContext } from '../contracts.js'
import { createPacing } from '../kernel/pacing.js'
import { ChatState } from '../kernel/state-pipeline.js'
import { bootKernel, emitRaw, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ, groupAtEvent, privateEvent } from './helpers.mjs'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function ev(over = {}) {
  const e = {
    chatKey: 'private:213445357', isGroup: false, groupId: null, messageId: 1,
    sender: { qq: 213445357, name: '主人', isMaster: true },
    text: '一句话', wake: { kind: 'private' }, _scratch: {}, hint: [], images: [], ...over,
  }
  e.turnCtx = createTurnContext(e)
  return e
}

function pacingWith(cfg = { enabled: true, waitMs: 40 }) {
  const pacing = createPacing({ state: new ChatState(), log: quiet })
  pacing.apply({ merge: cfg })
  return pacing
}

test('私聊合批：等待期内新消息并入并刷新计时，安静后只入站一轮', async () => {
  const pacing = pacingWith({ enabled: true, waitMs: 60 })
  const runs = []
  pacing.submit(ev({ messageId: 1, text: '第一句' }), (v) => runs.push(v))
  await sleep(30)
  pacing.submit(ev({ messageId: 2, text: '第二句' }), (v) => runs.push(v))
  await sleep(40) // 第一条若没被刷新，此刻已发车
  assert.equal(runs.length, 0, '新唤醒刷新了计时，不应提前发车')
  await sleep(60)
  assert.equal(runs.length, 1, '安静后只入站一轮')
  const merged = runs[0]
  assert.equal(merged._scratch.mergedCount, 2)
  assert.match(merged.text, /第一句/)
  assert.match(merged.text, /\[主人\(QQ:213445357\)\]: 第二句/, '后随消息带昵称+QQ')
  pacing.stop()
})

test('群聊：非唤醒消息并入当前槽；又来唤醒 → 当前槽立即发车、新唤醒另开一轮', async () => {
  const pacing = pacingWith({ enabled: true, waitMs: 60 })
  const runs = []
  const boom = ev({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 1, sender: { qq: MEMBER_QQ, name: '群友' }, wake: { kind: 'at' }, text: '@本机 第一问' })
  pacing.submit(boom, (v) => runs.push(v))
  assert.equal(pacing.collect(ev({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 2, sender: { qq: 40002, name: '旁人' }, wake: null, text: '补一句' })), true)
  const second = ev({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 3, sender: { qq: MEMBER_QQ, name: '群友' }, wake: { kind: 'at' }, text: '@本机 第二问' })
  pacing.submit(second, (v) => runs.push(v))
  assert.equal(runs.length, 1, '群聊来了新唤醒 → 当前槽立即发车')
  assert.match(runs[0].text, /第一问/)
  assert.match(runs[0].text, /\[旁人\(QQ:40002\)\]: 补一句/, '非唤醒消息并进当前轮')
  await sleep(90)
  assert.equal(runs.length, 2, '新唤醒自己成一轮')
  assert.match(runs[1].text, /第二问/)
  pacing.stop()
})

test('忙线时若已有等待槽：先把槽发车再让新唤醒排队（不插队、顺序不乱）', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000 })
  const runs = []
  let busy = false
  pacing.start({ isBusy: () => busy })
  const ev1 = ev({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 71, sender: { qq: MEMBER_QQ, name: '群友' }, wake: { kind: 'at' }, text: '@ 第一问' })
  pacing.submit(ev1, (v) => runs.push(v))
  assert.equal(runs.length, 0, '第一问进等待槽')
  busy = true // 第一问已 admission、模型还没开始跑 → 对合并来说算忙
  const ev2 = ev({ chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID, messageId: 72, sender: { qq: MEMBER_QQ, name: '群友' }, wake: { kind: 'at' }, text: '@ 第二问' })
  pacing.submit(ev2, (v) => runs.push(v))
  assert.equal(runs.length, 2, '槽里的第一问要先发车，第二问再直接排队（不能反序）')
  assert.match(runs[0].text, /第一问/)
  assert.match(runs[1].text, /第二问/)
  pacing.stop()
})

test('非唤醒消息没有打开的槽时不排队（返回 false）', () => {
  const pacing = pacingWith()
  assert.equal(pacing.collect(ev({ wake: null })), false)
  pacing.stop()
})

test('忙线：唤醒直接交给 serialize 排队，不合批、不等待', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000 })
  pacing.start({ isBusy: () => true })
  let ran = 0
  pacing.submit(ev({ text: '忙时的新唤醒' }), () => { ran += 1 })
  assert.equal(ran, 1, '忙线应立即入站（排队由 serialize 负责）')
  pacing.stop()
})

test('关闭合批：唤醒立即入站', () => {
  const pacing = pacingWith({ enabled: false, waitMs: 5000 })
  let ran = 0
  pacing.submit(ev(), () => { ran += 1 })
  assert.equal(ran, 1)
  pacing.stop()
})

test('默认收集合批原始图片但不下载，正文保留 [图片] 占位', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000 })
  let merged
  pacing.submit(ev({ messageId: 1, text: '看图' }), (v) => { merged = v })
  pacing.collect(ev({ messageId: 2, text: '', images: [{ file: 'x.jpg' }], wake: null }))
  pacing.collect(ev({ messageId: 3, text: '这张', images: [{ file: 'y.jpg' }], wake: null }))
  pacing.flush('private:213445357')
  assert.match(merged.text, /\[图片\]$/m)
  assert.match(merged.text, /这张 \[图片\]/)
  assert.equal(merged.imageParts?.length ?? 0, 0, 'pacing不下载图片，留给内核统一载入')
  assert.equal(pacing.config.merge.loadImages, true)
  assert.deepEqual(merged.images, [{ file: 'x.jpg' }, { file: 'y.jpg' }])
  assert.deepEqual(merged._scratch.mergedImageEvents.map((item) => item.messageId), [1, 2, 3])
  assert.doesNotThrow(() => JSON.stringify(merged), '图片快照不回指base形成循环')
  pacing.stop()
})

test('开启读图按事件顺序快照来源并复用预载图片，仅同路径去重', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000, loadImages: true })
  let merged
  const first = { type: 'image', data: 'first' }
  const second = { type: 'image', data: 'second' }
  const third = { type: 'image', data: 'third' }
  const head = ev({ messageId: 11, images: [{ file: 'same-placeholder' }], imageParts: [first], imagePaths: ['/loaded/first.png'] })
  pacing.submit(head, (value) => { merged = value })
  pacing.submit(ev({ messageId: 12, sender: { qq: 40002, name: '旁人', isMaster: false },
    images: [{ file: 'same-placeholder' }], imageParts: [second, first, third],
    imagePaths: ['/loaded/second.png', '/loaded/first.png'] }), (value) => { merged = value })
  pacing.flush(head.chatKey)
  assert.deepEqual(merged.images, [{ file: 'same-placeholder' }, { file: 'same-placeholder' }], 'raw描述相同也不猜测是同一图')
  assert.deepEqual(merged.imageParts, [first, second, third])
  assert.deepEqual(merged.imagePaths, ['/loaded/first.png', '/loaded/second.png', null])
  const snapshots = merged._scratch.mergedImageEvents
  assert.deepEqual(snapshots.map((item) => [item.sender.qq, item.messageId]), [[213445357, 11], [40002, 12]])
  assert.equal(snapshots[0].images.length, 1, '首条快照不受扁平聚合影响')
  assert.deepEqual(snapshots[1].imageParts, [second, first, third])
  assert.equal(merged._scratch.mergedIsMaster, false, '合并成员身份规则保持不变')
  assert.doesNotThrow(() => JSON.stringify(merged))
  pacing.stop()
})

test('关闭读图仅首条图片，tail原始与已下载图片均不带入', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000, loadImages: false })
  let merged
  const first = { type: 'image', data: 'head' }
  pacing.submit(ev({ messageId: 21, images: [{ file: 'head.jpg' }], imageParts: [first], imagePaths: ['/loaded/head.jpg'] }),
    (value) => { merged = value })
  pacing.collect(ev({ messageId: 22, wake: null, text: '后图', images: [{ file: 'tail.jpg' }],
    imageParts: [{ type: 'image', data: 'tail' }], imagePaths: ['/loaded/tail.jpg'] }))
  pacing.flush('private:213445357')
  assert.deepEqual(merged.images, [{ file: 'head.jpg' }])
  assert.deepEqual(merged.imageParts, [first])
  assert.deepEqual(merged.imagePaths, ['/loaded/head.jpg'])
  assert.deepEqual(merged._scratch.mergedImageEvents.map((item) => item.messageId), [21])
  assert.match(merged.text, /后图 \[图片\]/)
  pacing.stop()
})

test('群普通图片只并入已有唤醒槽，无槽不独立成轮或触发下载', () => {
  const pacing = pacingWith({ enabled: true, waitMs: 5000, loadImages: true })
  let runs = 0
  let merged
  const group = { chatKey: `group:${GROUP_ID}`, isGroup: true, groupId: GROUP_ID }
  const picture = ev({ ...group, wake: null, messageId: 32, images: [{ file: 'group.jpg' }] })
  assert.equal(pacing.collect(picture), false)
  assert.equal(runs, 0)
  pacing.submit(ev({ ...group, wake: { kind: 'at' }, messageId: 31 }), (value) => { runs += 1; merged = value })
  assert.equal(pacing.collect(picture), true)
  assert.equal(runs, 0)
  pacing.flush(group.chatKey)
  assert.equal(runs, 1)
  assert.deepEqual(merged.images, [{ file: 'group.jpg' }])
  assert.deepEqual(merged._scratch.mergedImageEvents.map((item) => item.messageId), [31, 32])
  assert.equal(pacing.collect(ev({ ...picture, messageId: 33 })), false)
  assert.equal(runs, 1)
  pacing.stop()
})

test('卸载 stop：清掉等待槽，不再触发入站', async () => {
  const pacing = pacingWith({ enabled: true, waitMs: 40 })
  let ran = 0
  pacing.submit(ev(), () => { ran += 1 })
  pacing.stop()
  await sleep(80)
  assert.equal(ran, 0, '停止后挂起的槽必须一起清掉')
})

test('内核：群里 @ + 等待期内的普通消息 → 一轮 prompt 同时包含两条', async (t) => {
  const h = await bootKernel({
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: true, waitMs: 150 } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())

  await emitRaw(h.kernel, groupAtEvent({ text: '第一问', messageId: 21, userId: MEMBER_QQ }))
  await emitRaw(h.kernel, {
    post_type: 'message', message_type: 'group', group_id: GROUP_ID, user_id: 40002,
    message_id: 22, sender: { user_id: 40002, nickname: '旁人' },
    message: [{ type: 'text', data: { text: '补一句' } }],
  })
  const prompt = await waitFor(() => h.ctx._prompts[0], { label: '合并后入站' })
  assert.ok(prompt.content[0].text.includes('第一问'))
  assert.ok(prompt.content[0].text.includes('补一句'), '非唤醒消息并进同一轮')
  assert.ok(prompt.content[0].text.includes('[旁人(QQ:40002)]'), '带昵称+QQ 以便分辨')
})

test('内核：群里两次 @ → 两轮独立（当前轮立即发车）', async (t) => {
  const h = await bootKernel({
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: true, waitMs: 150 } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())

  await emitRaw(h.kernel, groupAtEvent({ text: '第一问', messageId: 31, userId: MEMBER_QQ }))
  await emitRaw(h.kernel, groupAtEvent({ text: '第二问', messageId: 32, userId: MEMBER_QQ }))
  await waitFor(() => h.ctx._prompts.length >= 2, { label: '两轮独立入站' })
  assert.equal(h.ctx._prompts.length, 2, '两次唤醒各自成轮')
  assert.ok(h.ctx._prompts[0].content[0].text.includes('第一问'))
  assert.ok(h.ctx._prompts[1].content[0].text.includes('第二问'))
})

test('内核：私聊连发两条 → 合成一轮', async (t) => {
  const h = await bootKernel({
    config: {
      archive: { enabled: false, dir: 'logs/qq_chat' },
      pacing: { merge: { enabled: true, waitMs: 150 } },
      pluginConfig: {
        'link-parser': { enabled: false },
        'persona-voice': { splitReplyEnabled: false },
        'gate-wake': { adminQq: ADMIN_QQ },
      },
    },
  })
  t.after(() => h.dispose())

  await emitRaw(h.kernel, privateEvent({ text: '第一句', messageId: 41 }))
  await emitRaw(h.kernel, privateEvent({ text: '第二句', messageId: 42 }))
  await waitFor(() => h.ctx._prompts.length >= 1, { label: '私聊合并入站' })
  await sleep(200)
  assert.equal(h.ctx._prompts.length, 1, '私聊连发只开一轮')
  assert.ok(h.ctx._prompts[0].content[0].text.includes('第一句'))
  assert.ok(h.ctx._prompts[0].content[0].text.includes('第二句'))
})
