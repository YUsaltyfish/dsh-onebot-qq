/**
 * test/context-images.test.js — 群聊「上文图片入站」：上文窗口里的真实图片随轮次送模型。
 *
 * 覆盖：
 *  - 开启后：上文里的图被下载、按消息顺序入站、带「上文图片对应」映射；表情包不入站；
 *  - 数量与「入站条数上限」同步封顶（取最近 N 张）；
 *  - 关闭（默认）：行为与旧版一致，只有 `[图片]` 占位符，不下载；
 *  - 兼容：`fetchGroupContext` 仍返回字符串，`fetchGroupContextDetailed` 额外给 images。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import path from 'node:path'

import { bootKernel, emitRaw, groupAtEvent, waitFor, ADMIN_QQ, GROUP_ID, MEMBER_QQ } from './helpers.mjs'

const PNG = (n) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, n)])

async function imageServer(t) {
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    const n = Number(req.url.slice(1)) || 1
    const bytes = PNG(n)
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length })
    res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise((resolve) => server.close(resolve)))
  return { requests, url: (n) => `http://127.0.0.1:${server.address().port}/${n}` }
}

async function fixture(t, config = {}) {
  const h = await bootKernel({
    config: {
      outbound: { groupContextImages: true, groupContextCount: 5 },
      pacing: { merge: { enabled: false }, reply: { enabled: false } },
      pluginConfig: { 'gate-wake': { callAck: false }, stickers: { enabled: false }, 'group-memory': { accumulateEnabled: false } },
      ...config,
    },
  })
  t.after(() => h.dispose())
  return h
}

const history = (rows) => async () => rows
const msg = (id, text, images = [], { ago = 10 } = {}) => ({
  message_id: id,
  time: Math.floor(Date.now() / 1000) - ago,
  sender: { user_id: MEMBER_QQ, nickname: '群友', card: '' },
  message: [
    ...(text ? [{ type: 'text', data: { text } }] : []),
    ...images.map((url) => ({ type: 'image', data: { url } })),
  ],
})

test('开启后：上文里的真实图片按消息顺序入站，表情包不入站，带发送者映射', async (t) => {
  const h = await fixture(t)
  const srv = await imageServer(t)
  h.kernel.onebot.groupHistory = history([
    msg(701, '看这个', [srv.url(1)]),
    msg(702, '还有这个', [srv.url(2)]),
    // 表情包：extractText 会标 isSticker，不能送视觉
    { message_id: 703, time: Math.floor(Date.now() / 1000) - 9, sender: { user_id: MEMBER_QQ, nickname: '群友' },
      message: [{ type: 'image', data: { url: srv.url(9), summary: '[动画表情]', sub_type: 1 } }] },
  ])
  await emitRaw(h.kernel, groupAtEvent({ text: '看看这个', messageId: 704 }))
  await waitFor(() => h.ctx._prompts.length, { label: '一轮 prompt' })
  const req = h.ctx._prompts.at(-1)
  const imgs = req.content.filter((p) => p.type === 'image')
  assert.deepEqual(imgs.map((p) => p.data), [PNG(1), PNG(2)].map((b) => b.toString('base64')), '两张真实图按消息顺序入站')
  assert.deepEqual(srv.requests, ['/1', '/2'], '表情包不下载')
  const text = req.content[0].text
  assert.match(text, /\[群聊上文\]/, '上文块仍在')
  assert.match(text, /\[图片\]/, '占位符保留（方便模型知道原消息里有图）')
  assert.match(text, new RegExp(`\\[上文图片对应：图片1 对应上文消息发送者 群友\\(QQ:${MEMBER_QQ}\\)，消息ID:701`))
  assert.match(text, new RegExp(`图片2 对应上文消息发送者 群友\\(QQ:${MEMBER_QQ}\\)，消息ID:702`))
  assert.doesNotMatch(text, /图片3 /, '表情包不占图片编号')
})

test('图片数量与「入站条数上限」同步：单条消息多图时也只带最近 N 张', async (t) => {
  const h = await fixture(t, { outbound: { groupContextImages: true, groupContextCount: 2 } })
  const srv = await imageServer(t)
  h.kernel.onebot.groupHistory = history([msg(711, '三张', [srv.url(1), srv.url(2), srv.url(3)])])
  await emitRaw(h.kernel, groupAtEvent({ text: '看这几张，messageId', messageId: 712 }))
  await waitFor(() => h.ctx._prompts.length, { label: '一轮 prompt' })
  const imgs = h.ctx._prompts.at(-1).content.filter((p) => p.type === 'image')
  assert.deepEqual(imgs.map((p) => p.data), [PNG(2), PNG(3)].map((b) => b.toString('base64')), '封顶 2 张且取最近')
})

test('默认关闭：不下载上文图，只有占位符', async (t) => {
  const h = await fixture(t, { outbound: { groupContextImages: false, groupContextCount: 5 } })
  const srv = await imageServer(t)
  h.kernel.onebot.groupHistory = history([msg(721, '看这个', [srv.url(1)])])
  await emitRaw(h.kernel, groupAtEvent({ text: '看看这个', messageId: 722 }))
  await waitFor(() => h.ctx._prompts.length, { label: '一轮 prompt' })
  const req = h.ctx._prompts.at(-1)
  assert.equal(req.content.filter((p) => p.type === 'image').length, 0, '关闭时零图片块')
  assert.deepEqual(srv.requests, [], '关闭时零下载')
  assert.match(req.content[0].text, /\[图片\]/, '占位符仍在')
  assert.doesNotMatch(req.content[0].text, /上文图片对应/)
})

test('驱动层兼容：fetchGroupContext 仍返回文本；fetchGroupContextDetailed 额外给 images', async (t) => {
  const h = await fixture(t)
  const srv = await imageServer(t)
  const chatKey = `group:${GROUP_ID}`
  h.kernel.state.get(chatKey).lastContextId = null
  h.kernel.onebot.groupHistory = history([
    msg(731, '旧图', [srv.url(1)]),
    msg(732, '新图', [srv.url(2)]),
  ])
  const ev = { chatKey, groupId: GROUP_ID, messageId: 733, _scratch: {} }
  const detailed = await h.kernel.dsh.fetchGroupContextDetailed(ev, 5)
  assert.ok(detailed.block.includes('[群聊上文]'))
  assert.equal(detailed.images.length, 2)
  assert.equal(detailed.images[0].url, srv.url(1))
  assert.equal(detailed.images[0].messageId, 731)
  assert.deepEqual(detailed.images[0].sender, { qq: MEMBER_QQ, name: '群友', card: '' })
  // 水位已推进 → 兼容接口返回字符串且不带旧消息
  const text = await h.kernel.dsh.fetchGroupContext(ev, 5)
  assert.equal(typeof text, 'string')
  assert.equal(text, '')
  assert.equal((await h.kernel.dsh.fetchGroupContextDetailed(ev, 5)).images.length, 0)
})

test('被引图与上文图是同一张时只入站一次（按 url/file 去重）', async (t) => {
  const h = await fixture(t)
  const srv = await imageServer(t)
  const imageMsg = { message_id: 741, time: Math.floor(Date.now() / 1000) - 10,
    sender: { user_id: ADMIN_QQ, nickname: '主人' },
    message: [{ type: 'image', data: { url: srv.url(1) } }] }
  h.kernel.onebot.groupHistory = history([imageMsg])
  // 被引消息反查返回同一张图（引用图会先进 ev.images），与上文图 url 相同
  h.kernel.onebot.msgById = async () => imageMsg
  await emitRaw(h.kernel, groupAtEvent({ text: '这张怎么改', messageId: 742, userId: MEMBER_QQ, replyTo: 741 }))
  await waitFor(() => h.ctx._prompts.length, { label: '一轮 prompt' })
  const req = h.ctx._prompts.at(-1)
  assert.equal(req.content.filter((p) => p.type === 'image').length, 1, '同一张只入站一次')
  assert.deepEqual(srv.requests, ['/1'], '同一张只下载一次')
})
