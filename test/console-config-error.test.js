/**
 * test/console-config-error.test.js — 运行中配置损坏时的控制台兜底（A6）。
 *
 * 场景：插件已启动、配置文件事后被改坏（JSON 损坏/读不了）。
 * 期望：schema/status 仍可渲染（用内存最后一次成功配置兜底）并带 configError；
 *       写盘一律拒绝、绝不覆盖坏文件；修好后自动恢复。
 * 注：**启动时**配置就坏不在本覆盖范围（loadConfig 直接抛错，插件根本不会加载）。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'

import { bootKernel } from './helpers.mjs'

async function fixture(t) {
  const h = await bootKernel({ config: { pacing: { merge: { enabled: false }, reply: { enabled: false } } } })
  t.after(() => h.dispose())
  const good = fs.readFileSync(h.configPath, 'utf8')
  // 运行中把配置改坏
  fs.writeFileSync(h.configPath, '{ 坏掉的 JSON')
  return { ...h, good }
}

test('配置坏掉时 schema/status 仍可用，并显示 configError、不再报「已就绪」', async (t) => {
  const h = await fixture(t)
  const schema = await h.kernel.handleAdminRpc('schema', {})
  assert.equal(schema.ok, true, 'schema 必须还能渲染（否则诊断入口都点不到）')
  assert.match(String(schema.configError), /配置文件/)
  assert.ok(Array.isArray(schema.controls) && schema.controls.length > 0, '用内存兜底配置仍要给出控件')
  assert.ok(schema.controls.some((c) => c.key === 'adminQq'), '兜底值来自最后一次成功加载的配置')

  const status = await h.kernel.handleAdminRpc('status', {})
  assert.equal(status.ok, true)
  assert.match(String(status.configError), /配置文件/)
  assert.equal(status.meta.configReady, false, '配置坏着绝不能报就绪')
  const cfgStep = (status.onboarding || []).find((s) => s.id === 'config')
  assert.equal(cfgStep?.ok, false)
  assert.match(String(cfgStep?.hint || ''), /失败/)
})

test('配置坏掉时写盘一律拒绝，且不覆盖坏文件（留给用户修）', async (t) => {
  const h = await fixture(t)
  const broken = fs.readFileSync(h.configPath, 'utf8')
  const r = await h.kernel.handleAdminRpc('set', { key: 'outbound.replyMaxLength', value: 1000 })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), broken, '拒绝写入时必须原样保留坏文件')
})

test('配置文件修好后自动恢复：configError 消失、configReady 回到正常', async (t) => {
  const h = await fixture(t)
  fs.writeFileSync(h.configPath, h.good)
  const schema = await h.kernel.handleAdminRpc('schema', {})
  assert.equal(schema.ok, true)
  assert.equal(schema.configError, '')
  const status = await h.kernel.handleAdminRpc('status', {})
  assert.equal(status.configError, '')
  assert.equal(status.meta.configReady, true)
  const write = await h.kernel.handleAdminRpc('set', { key: 'outbound.replyMaxLength', value: 1000 })
  assert.equal(write.ok, true, JSON.stringify(write))
})
