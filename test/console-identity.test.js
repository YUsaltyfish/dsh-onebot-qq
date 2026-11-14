/**
 * test/console-identity.test.js — 主人 QQ 单一来源（控制台改造 A1 回归）。
 *
 * 覆盖：
 *  - 「其他」页不再暴露 gate-wake.adminQq 控件（旧双源入口关闭）；
 *  - 旧配置里残留的插件级 adminQq 不再生效：门禁按实例配置的 adminQq 判主人；
 *  - 仅提示、不写盘（配置文件原样保留旧键，交给用户手动清理）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { bootKernel, emitRaw, groupAtEvent, tapInbound, waitFor, ADMIN_QQ } from './helpers.mjs'

const LEGACY_QQ = 19999

async function fixture(t) {
  const h = await bootKernel({
    config: {
      adminQq: ADMIN_QQ,
      pluginConfig: { 'gate-wake': { adminQq: LEGACY_QQ } },
      pacing: { merge: { enabled: false }, reply: { enabled: false } },
    },
  })
  t.after(() => h.dispose())
  return h
}

const pluginCfgOf = (kernel, id) => kernel.plugins.find((p) => p.id === id)?.cfg || {}

test('插件级 adminQq 已废弃：生效值以实例配置为准，且控制台不再暴露该控件', async (t) => {
  const h = await fixture(t)
  const gw = pluginCfgOf(h.kernel, 'gate-wake')
  assert.equal(gw.adminQq, ADMIN_QQ, 'gate-wake 生效 cfg 应等于实例配置 adminQq')
  assert.notEqual(gw.adminQq, LEGACY_QQ, '旧插件级值不得生效')

  const schema = await h.kernel.handleAdminRpc('schema', {})
  assert.equal(schema.ok, true)
  assert.equal(schema.controls.some((c) => c.key === 'gate-wake.adminQq'), false, '其他页不应再有第二个主人 QQ 控件')
  const groupChatKeys = schema.controls.filter((c) => c.group === '群聊').map((c) => c.key)
  assert.ok(groupChatKeys.includes('adminQq'), '主人 QQ 仍在「群聊」页')
})

test('旧插件级值不参与主人判定：只有实例配置的 adminQq 算主人', async (t) => {
  const h = await fixture(t)
  const seen = tapInbound(h.kernel)
  await emitRaw(h.kernel, groupAtEvent({ text: '主人说话', messageId: 9101, userId: ADMIN_QQ }))
  await emitRaw(h.kernel, groupAtEvent({ text: '旧号说话', messageId: 9102, userId: LEGACY_QQ }))
  await waitFor(() => seen.events.length >= 2, { label: '两条入站' })
  const byId = new Map(seen.events.map((ev) => [String(ev.messageId), ev]))
  assert.equal(byId.get('9101')?.sender?.isMaster, true, '实例 adminQq 的消息应判主人')
  assert.equal(byId.get('9102')?.sender?.isMaster, false, '旧插件级号码不得被判主人')
})

test('旧键只提示不写盘：配置文件里残留的插件级值不会被控制台悄悄删除', async (t) => {
  const h = await fixture(t)
  const onDisk = JSON.parse(fs.readFileSync(h.configPath, 'utf8'))
  assert.equal(onDisk.pluginConfig?.['gate-wake']?.adminQq, LEGACY_QQ, '启动不应改写用户配置（留给用户手动清理）')
  assert.equal(onDisk.adminQq, ADMIN_QQ)
})
