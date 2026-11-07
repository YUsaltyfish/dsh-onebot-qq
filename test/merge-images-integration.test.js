import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { apply } from '../index.js'
import { createFakeOneBot } from './fake-onebot.mjs'
import { createMockCtx, tmpDir, writeInstanceConfig, waitFor, ADMIN_QQ, MEMBER_QQ } from './helpers.mjs'

const image = (n) => Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), Buffer.alloc(24, n)])
async function fixture(t, loadImages = true) {
  const fake = createFakeOneBot()
  await fake.start()
  const dataDir = tmpDir('merge-image-integration')
  writeInstanceConfig(dataDir, {
    onebot: fake.url, outbound: { groupContextCount: 0 },
    pacing: { merge: { enabled: true, waitMs: 5000, loadImages }, reply: { enabled: false } },
    pluginConfig: { 'gate-wake': { callAck: false }, stickers: { enabled: false }, 'group-memory': { accumulateEnabled: false } },
  })
  const ctx = createMockCtx({ workspacePath: path.join(dataDir, 'workspace') })
  await apply(ctx, { dataDir, autoConnect: false })
  const kernel = ctx.get('qqBot').kernel
  const requests = []
  const server = http.createServer((req, res) => {
    requests.push(req.url)
    if (req.url === '/bad') { res.writeHead(500); res.end(); return }
    const bytes = image(Number(req.url.slice(1)) || 1)
    res.writeHead(200, { 'content-type': 'image/png', 'content-length': bytes.length }); res.end(bytes)
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const url = (n) => `http://127.0.0.1:${server.address().port}/${n}`
  await kernel.onebot.connect()
  await waitFor(() => kernel.onebot.health().qqLoggedIn === true)
  t.after(async () => { for (const fn of ctx._effects) fn(); await fake.close(); await new Promise((resolve) => server.close(resolve)) })
  const seen = []
  kernel.pipeline.use('pre-gate', (ev) => { seen.push(ev) }, { order: 0 })
  async function push(raw) {
    const count = seen.length
    fake.pushEvent(raw)
    await waitFor(() => seen.length > count)
    // 等管线完成（before-turn仍可能反查引用）；不要等合批timer。
    await new Promise((resolve) => setImmediate(resolve))
  }
  async function flush(key) {
    kernel.pacing.flush(key)
    await waitFor(() => ctx._prompts.length)
    return ctx._prompts.at(-1)
  }
  return { fake, kernel, ctx, dataDir, requests, url, push, flush }
}
function attach(raw, urls) {
  raw.message.push(...urls.map((url) => ({ type: 'image', data: { url } })))
  return raw
}
const images = (req) => req.content.filter((p) => p.type === 'image')

test('群先@再非唤醒尾图：只在flush后下载，按消息顺序带视觉附件与发送者映射且不借主人身份', async (t) => {
  const h = await fixture(t)
  await h.push(attach(h.fake.groupMessage({ atSelf: true, messageId: 501, text: '帮看这几张' }), [h.url(1)]))
  await h.push(attach(h.fake.groupMessage({ atSelf: false, userId: MEMBER_QQ, nickname: '路人', messageId: 502, text: '这张也看' }), [h.url(2)]))
  assert.deepEqual(h.requests, [])
  const req = await h.flush('group:20001')
  assert.deepEqual(images(req).map((p) => p.data), [image(1), image(2)].map((b) => b.toString('base64')))
  assert.deepEqual(h.requests, ['/1', '/2'])
  const text = req.content[0].text
  assert.match(text, /图片1 对应消息发送者 主人\(QQ:10001\)，消息ID:501/)
  assert.match(text, /图片2 对应消息发送者 路人\(QQ:10002\)，消息ID:502/)
  h.ctx.emit('session/event', { id: req.sessionId }, { type: 'turn/start' })
  assert.equal(h.kernel.turnBySession.get(req.sessionId).isMaster, false)
})

test('私聊合批多图保留每条消息内部顺序，预加载base不吞raw尾图', async (t) => {
  const h = await fixture(t)
  h.kernel.pipeline.use('before-turn', (ev) => {
    if (ev.messageId === 601) {
      ev.imageParts = [{ mediaType: 'image/png', data: image(1).toString('base64'), name: 'preloaded' }]
      ev.imagePaths = [path.join(h.dataDir, 'preloaded.png')]
    }
  }, { order: 999 })
  await h.push(attach(h.fake.privateMessage({ messageId: 601, text: '第一张' }), [h.url(1)]))
  await h.push(attach(h.fake.privateMessage({ messageId: 602, text: '后两张' }), [h.url(2), h.url(3)]))
  assert.deepEqual(h.requests, [])
  const req = await h.flush('private:10001')
  assert.deepEqual(images(req).map((p) => p.data), [image(1), image(2), image(3)].map((b) => b.toString('base64')))
  assert.deepEqual(h.requests, ['/2', '/3'])
  assert.match(req.content[0].text, /图片3 对应消息发送者 主人\(QQ:10001\)，消息ID:602/)
})

test('关闭loadImages只加载base图，尾图不提前下载但尾正文仍合并', async (t) => {
  const h = await fixture(t, false)
  await h.push(attach(h.fake.privateMessage({ messageId: 611, text: 'base' }), [h.url(1)]))
  await h.push(attach(h.fake.privateMessage({ messageId: 612, text: '尾图说明' }), [h.url(2)]))
  assert.deepEqual(h.requests, [])
  const req = await h.flush('private:10001')
  assert.equal(images(req).length, 1)
  assert.deepEqual(h.requests, ['/1'])
  assert.match(req.content[0].text, /尾图说明/)
})

test('引用图片保留原反查，单张失败后成功附件连续编号不吞整轮', async (t) => {
  const h = await fixture(t)
  h.kernel.onebot.msgById = async () => ({ sender: { user_id: MEMBER_QQ, nickname: '原作者' }, message: [{ type: 'image', data: { url: h.url(2) } }] })
  const raw = attach(h.fake.privateMessage({ messageId: 621, text: '看看引用' }), [h.url('bad')])
  raw.message.unshift({ type: 'reply', data: { id: '101' } })
  await h.push(raw)
  await h.push(attach(h.fake.privateMessage({ messageId: 622, text: '补一张' }), [h.url(3)]))
  const req = await h.flush('private:10001')
  assert.deepEqual(images(req).map((p) => p.data), [image(2), image(3)].map((b) => b.toString('base64')))
  assert.match(req.content[0].text, /原作者\(QQ:10002\)/)
  assert.match(req.content[0].text, /图片1 对应消息发送者 主人\(QQ:10001\)，消息ID:621（含引用图时不代表原作者）/)
  assert.match(req.content[0].text, /图片2 .*消息ID:622/)
  assert.doesNotMatch(req.content[0].text, /图片3 对应/)
})

test('预加载无path保留索引、重复实际path只留一次；协议溯源失败仍回落原始URL', async (t) => {
  const h = await fixture(t)
  const local = path.join(h.dataDir, 'loaded.png')
  h.kernel.pipeline.use('before-turn', (ev) => {
    if (ev.messageId === 641) {
      ev.imageParts = [1, 2, 3].map((n) => ({ mediaType: 'image/png', data: image(n).toString('base64') }))
      ev.imagePaths = [null, local, local]
    }
  }, { order: 999 })
  h.kernel.onebot.getFile = async () => { throw new Error('missing get_file') }
  await h.push(h.fake.privateMessage({ messageId: 641, text: '预加载' }))
  const tail = attach(h.fake.privateMessage({ messageId: 642, text: '原始URL兜底' }), [h.url(4)])
  tail.message.at(-1).data.file = 'protocol-image-id'
  await h.push(tail)
  const req = await h.flush('private:10001')
  assert.deepEqual(images(req).map((p) => p.data), [image(1), image(2), image(4)].map((b) => b.toString('base64')))
  assert.deepEqual(h.requests, ['/4'])
  assert.match(req.content[0].text, /图片3 .*消息ID:642/)
})

test('下载等待期间卸载，恢复后不提交会话或模型', async (t) => {
  const h = await fixture(t)
  let resume
  h.kernel.onebot.getFile = async () => {
    await new Promise((resolve) => { resume = resolve })
    return { url: h.url(1) }
  }
  const raw = h.fake.privateMessage({ messageId: 651 })
  raw.message.push({ type: 'image', data: { file: 'pending-image' } })
  await h.push(raw)
  h.kernel.pacing.flush('private:10001')
  await waitFor(() => resume)
  for (const fn of h.ctx._effects) fn()
  resume()
  await new Promise((resolve) => setImmediate(resolve))
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(h.ctx._prompts.length, 0)
  assert.equal(h.ctx._sessions.size, 0)
  assert.deepEqual(h.requests, [])
})

test('不合批普通轮仍走同一loader，未唤醒和门禁拒绝图片不下载', async (t) => {
  const h = await fixture(t)
  await h.push(attach(h.fake.groupMessage({ atSelf: false, messageId: 631 }), [h.url(1)]))
  assert.deepEqual(h.requests, [])
  h.kernel.pipeline.use('pre-gate', (ev) => { if (ev.messageId === 632) ev.stopped = true }, { order: 1 })
  await h.push(attach(h.fake.privateMessage({ messageId: 632 }), [h.url(2)]))
  assert.deepEqual(h.requests, [])
  h.kernel.pacing.apply({ merge: { enabled: false }, reply: { enabled: false } })
  await h.push(attach(h.fake.privateMessage({ messageId: 633 }), [h.url(3)]))
  await waitFor(() => h.ctx._prompts.length)
  assert.equal(images(h.ctx._prompts[0]).length, 1)
  assert.deepEqual(h.requests, ['/3'])
})
