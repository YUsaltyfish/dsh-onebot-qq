/**
 * 回归：NapCat 重连不能叠出第二条 WS（否则每条消息处理两次、双回复）。
 * 用 test/fake-napcat.mjs 的真实 WS 服务端验证：close/forceReconnect/重复触发后，连接数始终收敛到 1。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { NapCatAdapter } from '../kernel/napcat-adapter.js'
import { createFakeNapCat } from './fake-napcat.mjs'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const quiet = { info() {}, warn() {}, error() {}, debug() {} }

async function waitFor(fn, timeoutMs = 8000, label = '条件') {
  const t0 = Date.now()
  while (Date.now() - t0 < timeoutMs) {
    if (await fn()) return true
    await sleep(50)
  }
  throw new Error(`等待超时：${label}`)
}

test('NapCat 适配器：重连/重复触发后只保留一条 WS（防双回复）', async (t) => {
  const fake = createFakeNapCat()
  const urls = await fake.start()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-reconnect-'))
  const adapter = new NapCatAdapter({
    wsUrl: urls.wsUrl, httpUrl: urls.httpUrl, log: quiet, avatarDir: path.join(dataDir, 'avatars'),
  })
  t.after(async () => {
    adapter.close()
    await fake.close()
  })
  await adapter.connect()
  await waitFor(() => adapter.health().linked, 8000, '首次连接')
  assert.equal(fake.clientCount, 1)

  // 连续两次强制重连（模拟用户连点「重新连接」/配置热改）：最终仍只能有 1 条
  adapter._forceReconnect()
  adapter._forceReconnect()
  await waitFor(() => adapter.health().linked, 8000, '重连后恢复')
  await sleep(300)
  assert.equal(fake.clientCount, 1, `重连后应只有 1 条 WS，实际 ${fake.clientCount}`)

  // close 后再 connect：旧 socket 的迟到 close 不得再拉起新连接
  adapter.close()
  await waitFor(() => fake.clientCount === 0, 5000, 'close 断开')
  await adapter.connect()
  await waitFor(() => adapter.health().linked, 8000, '重新 connect')
  await sleep(300)
  assert.equal(fake.clientCount, 1, `重新 connect 后应只有 1 条 WS，实际 ${fake.clientCount}`)
})

test('NapCat 适配器：撤回失败不把原始报错放进 msg（raw 只供日志）', async () => {
  const adapter = new NapCatAdapter({
    httpUrl: 'http://127.0.0.1:9', log: quiet, avatarDir: path.join(os.tmpdir(), 'qqbot-recall-avatar'),
  })
  adapter._post = async () => ({
    status: 200,
    data: {
      status: 'failed',
      wording: 'Timeout: NTEvent serviceAndMethod:NodeIKernelMsgService/recallMsg ListenerName:NodeIKernelMsgListener/onMsgInfoListUpdate EventRet:\n{\n    "result": 7,\n    "errMsg": "decode failed!"\n}',
    },
  })
  const r = await adapter.recall(123)
  assert.equal(r.ok, false)
  assert.equal(/NTEvent|EventRet|decode failed|Timeout|recallMsg/.test(r.msg), false, `msg 不应含内部报错：${r.msg}`)
  assert.ok(String(r.raw).includes('NTEvent'), 'raw 保留原文给日志/排查')

  adapter._post = async () => {
    const e = new Error('The operation was aborted due to timeout')
    e.name = 'TimeoutError'
    throw e
  }
  const r2 = await adapter.recall(124)
  assert.equal(r2.ok, false)
  assert.equal(/timeout|aborted|NTEvent/i.test(r2.msg), false, `超时 msg 也不回显原始错误：${r2.msg}`)
})
