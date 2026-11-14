/**
 * test/console-write-paths.test.js — 控制台「同一配置两条写入口径」回归（A5）。
 *
 * 覆盖：
 *  - 通用 set 不接 `group-memory.dir`（必须走带路径校验的「群记忆 → 高级配置」）；
 *  - `memory setcfg` 仍拒绝 `../` 逃逸、允许数据目录内的路径；
 *  - 入群欢迎群列表的逐群开关保留 `*`（以前 toNumList 会把它静默抹掉）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel } from './helpers.mjs'

async function fixture(t, config = {}) {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false }, reply: { enabled: false } }, ...config },
  })
  t.after(() => h.dispose())
  return h
}

const welcomeList = (h) => h.kernel.raw.pluginConfig?.['group-welcome']?.groups
const memDir = (h) => h.kernel.raw.pluginConfig?.['group-memory']?.dir

test('通用 set 拒绝 group-memory.dir：指到「群记忆 → 高级配置」，且不改配置', async (t) => {
  const h = await fixture(t)
  const before = JSON.stringify(memDir(h) ?? '')
  const r = await h.kernel.handleAdminRpc('set', { key: 'group-memory.dir', value: '../../outside' })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(String(r.error), /群记忆 → 高级配置/)
  assert.equal(JSON.stringify(memDir(h) ?? ''), before, '被拒时配置必须原样')
})

test('memory setcfg 仍做路径校验：../ 拒绝、数据目录内放行', async (t) => {
  const h = await fixture(t)
  const bad = await h.kernel.handleAdminRpc('memory', { op: 'setcfg', key: 'group-memory.dir', value: '../../outside' })
  assert.equal(bad.ok, false, JSON.stringify(bad))
  assert.match(String(bad.error), /数据目录内/)

  const good = await h.kernel.handleAdminRpc('memory', { op: 'setcfg', key: 'group-memory.dir', value: 'mem-inside' })
  assert.equal(good.ok, true, JSON.stringify(good))
  assert.equal(memDir(h), 'mem-inside')
})

test('入群欢迎逐群开关保留 *：add/remove 单群不得关掉全群欢迎', async (t) => {
  const h = await fixture(t, { pluginConfig: { 'group-welcome': { groups: ['*'] } } })
  assert.deepEqual(welcomeList(h), ['*'])

  const add = await h.kernel.handleAdminRpc('group', { kind: 'welcome', op: 'add', group_id: 222222 })
  assert.equal(add.ok, true, JSON.stringify(add))
  assert.deepEqual(welcomeList(h), ['*', '222222'], '加单群后仍要保留 *')

  const remove = await h.kernel.handleAdminRpc('group', { kind: 'welcome', op: 'remove', group_id: 222222 })
  assert.equal(remove.ok, true, JSON.stringify(remove))
  assert.deepEqual(welcomeList(h), ['*'], '删单群后 * 必须还在（否则全群欢迎被关掉）')
})

test('入群欢迎删除数字存法的群（老配置）也能生效', async (t) => {
  const h = await fixture(t, { pluginConfig: { 'group-welcome': { groups: [20001] } } })
  const r = await h.kernel.handleAdminRpc('group', { kind: 'welcome', op: 'remove', group_id: 20001 })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(welcomeList(h), [], '数字存法的群也要能被删掉')
})
