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

test('协议端适配器：重连/重复触发后只保留一条 WS（防双回复）', async (t) => {
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

test('协议端适配器：撤回失败不把原始报错放进 msg（raw 只供日志）', async () => {
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

test('协议端适配器：群历史同时带 message_id/message_seq（多数实现认 seq，SnowLuma 认 id）', async (t) => {
  const fake = createFakeNapCat()
  const urls = await fake.start()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-history-'))
  const adapter = new NapCatAdapter({
    wsUrl: urls.wsUrl, httpUrl: urls.httpUrl, log: quiet, avatarDir: path.join(dataDir, 'avatars'),
  })
  t.after(async () => {
    adapter.close()
    await fake.close()
  })
  await adapter.connect()
  await waitFor(() => adapter.health().linked, 8000, 'WS 连接')
  await adapter.groupHistory(fake.groupId, 5)
  const call = fake.calls.find((c) => c.action === 'get_group_msg_history')
  assert.ok(call, '应发出 get_group_msg_history')
  assert.equal(call.params.group_id, fake.groupId)
  assert.equal(call.params.message_id, 0, 'SnowLuma 认 message_id（0 = 最新）')
  assert.equal(call.params.message_seq, 0, '多数实现认 message_seq（0 = 最新）')
  assert.equal(call.params.count, 5)
})

test('协议端适配器：get_status 明确 online=false/good=false 优先判异常；心跳 good 进 health', async (t) => {
  const fake = createFakeNapCat()
  const urls = await fake.start()
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-status-'))
  const adapter = new NapCatAdapter({
    wsUrl: urls.wsUrl, httpUrl: urls.httpUrl, log: quiet, avatarDir: path.join(dataDir, 'avatars'),
  })
  t.after(async () => {
    adapter.close()
    await fake.close()
  })
  await adapter.connect()
  await waitFor(() => adapter.health().linked, 8000, 'WS 连接')

  const okRes = await adapter.checkLogin({ force: true })
  assert.equal(okRes.ok, true, '正常状态仍判在线（get_stranger_info 探针照旧）')

  // SnowLuma 场景：online 但接收链路停滞（发得出、收不进）→ 必须判异常，不能报"在线"
  fake.setStatus({ online: true, good: false })
  const stalled = await adapter.checkLogin({ force: true })
  assert.equal(stalled.ok, false)
  assert.match(String(stalled.error), /接收链路/)

  fake.setStatus({ online: false, good: false })
  const offline = await adapter.checkLogin({ force: true })
  assert.equal(offline.ok, false)
  assert.match(String(offline.error), /离线/)

  // 心跳里的 status.good 也记进 health（SnowLuma 30s 一发；NapCat 没字段就保持 null）
  fake.pushEvent({ post_type: 'meta_event', meta_event_type: 'heartbeat', status: { online: true, good: false } })
  await sleep(150)
  assert.equal(adapter.health().qqReceiveGood, false)
})
