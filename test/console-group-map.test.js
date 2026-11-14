/**
 * test/console-group-map.test.js — 控制台群名单（纳入管理 / 存法迁移）回归。
 *
 * 覆盖：
 *  - ensure 写入的空条目要存活到后续编辑（对别的群 add/remove 之后，之前纳入的群仍在）；
 *  - status 群清单依据（卡片出现）来自名单键，不依赖有没有 QQ；
 *  - 唤醒词不支持 ensure（明确报错，而不是假装成功）；
 *  - gate-wake 名单的对象存法会在启动时迁移成文本存法（控制台 str 控件不再显示 [object Object]）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { loadConfig, defaultConfig } from '../kernel/config-store.js'
import { bootKernel, tmpDir, waitFor, ADMIN_QQ } from './helpers.mjs'

const gwAllow = (h) => h.kernel.raw.pluginConfig?.['gate-wake']?.groupUserAllowlist

async function fixture(t, gwCfg = {}) {
  const h = await bootKernel({
    config: {
      pluginConfig: { 'gate-wake': gwCfg },
      pacing: { merge: { enabled: false }, reply: { enabled: false } },
    },
  })
  t.after(() => h.dispose())
  return h
}

test('ensure 的空条目不会被后续编辑抹掉：纳入 A → 给 B 加名单 → A 仍在（卡片不消失）', async (t) => {
  const h = await fixture(t)
  const ensured = await h.kernel.handleAdminRpc('group', { kind: 'allowlist', op: 'ensure', group_id: 111111 })
  assert.equal(ensured.ok, true, JSON.stringify(ensured))
  assert.match(String(gwAllow(h)), /111111:/, 'ensure 应写入空条目（群号:）')

  const added = await h.kernel.handleAdminRpc('group', { kind: 'allowlist', op: 'add', group_id: 222222, value: ADMIN_QQ })
  assert.equal(added.ok, true, JSON.stringify(added))
  assert.match(String(gwAllow(h)), /111111:/, '给别的群加名单不得清掉已纳入的群')
  assert.match(String(gwAllow(h)), /222222:\d+/, '新加的群与 QQ 要写进去')

  const status = await h.kernel.handleAdminRpc('status', {})
  const gids = (status.groupList || []).map((g) => String(g.id))
  assert.ok(gids.includes('111111'), '「纳入管理」的群要出现在群清单（卡片才会出现）')
  assert.ok(gids.includes('222222'), '加名单的群也要出现在群清单')

  const removed = await h.kernel.handleAdminRpc('group', { kind: 'allowlist', op: 'remove', group_id: 222222, value: ADMIN_QQ })
  assert.equal(removed.ok, true)
  assert.match(String(gwAllow(h)), /111111:/, 'remove 只删目标群自身，不能牵连其它群')
  assert.doesNotMatch(String(gwAllow(h)), /222222:/, '名单空了应整条删除')
})

test('ensure 幂等：重复纳入同一个群不报错、不重复写', async (t) => {
  const h = await fixture(t)
  for (let i = 0; i < 3; i += 1) {
    const r = await h.kernel.handleAdminRpc('group', { kind: 'allowlist', op: 'ensure', group_id: 333333 })
    assert.equal(r.ok, true)
  }
  const raw = String(gwAllow(h))
  assert.equal(raw.match(/333333:/g)?.length, 1, '同一个群只应出现一次')
})

test('唤醒词不支持 ensure：明确报错而不是假装成功', async (t) => {
  const h = await fixture(t)
  const before = JSON.stringify(h.kernel.raw.pluginConfig?.['gate-wake']?.keywords ?? '')
  const r = await h.kernel.handleAdminRpc('group', { kind: 'keywords', op: 'ensure', group_id: '*' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /不支持 ensure/)
  assert.equal(JSON.stringify(h.kernel.raw.pluginConfig?.['gate-wake']?.keywords ?? ''), before, '失败不得修改配置')
})

test('名单对象存法在加载时迁移成文本存法（控制台不再显示 [object Object]）', async (t) => {
  const dataDir = tmpDir('group-map-migrate')
  const file = path.join(dataDir, 'config.json')
  const cfg = {
    ...defaultConfig(),
    adminQq: ADMIN_QQ,
    pluginConfig: {
      'gate-wake': { groupUserAllowlist: { 111111: [], 222222: [ADMIN_QQ] }, groupUserBlocklist: {} },
    },
  }
  fs.mkdirSync(dataDir, { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(cfg, null, 4)}\n`)

  const loaded = loadConfig({ dataDir, createIfMissing: true })
  assert.equal(loaded.mapMigrated, true, '应报告发生了名单存法迁移')
  assert.equal(loaded.raw.pluginConfig['gate-wake'].groupUserAllowlist, `111111:;222222:${ADMIN_QQ}`)
  assert.equal(loaded.raw.pluginConfig['gate-wake'].groupUserBlocklist, '')

  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'))
  assert.equal(onDisk.pluginConfig['gate-wake'].groupUserAllowlist, `111111:;222222:${ADMIN_QQ}`)
  assert.ok(fs.readdirSync(dataDir).some((n) => n.includes('bak-prune')), '落盘前应留备份')
})
