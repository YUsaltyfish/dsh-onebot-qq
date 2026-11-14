/**
 * test/console-minor-fixes.test.js — 控制台小修回归（B1/B2/B3/B5）。
 *
 * 覆盖：
 *  - B1 check-host-deps 失败时返回 error（前端只显示 e.message，不然只剩“✗ ”）；
 *  - B2 memory save 拒绝非字符串 content（别把 [object Object] 写进记忆）；
 *  - B3 版本文件清理同时认 `<stamp>` / `<stamp>-N` / `<stamp>-manual` / `<stamp>-N-manual`；
 *  - B5 离线自检不再把“跳过 OneBot 网络探测”画成 ✅；诊断建议不再指向已删除的「DSH 连接」页。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { bootKernel, tmpDir } from './helpers.mjs'
import { pruneMemoryRevisions } from '../plugins/group-memory/storage.js'

async function fixture(t, config = {}) {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false }, reply: { enabled: false } }, ...config },
  })
  t.after(() => h.dispose())
  return h
}

test('B1 check-host-deps 失败：返回 error，前端不再只剩“✗ ”', async (t) => {
  const h = await fixture(t)
  h.kernel.checkHostDeps = async () => ({
    ok: false,
    items: [{ id: 'ffmpeg', required: true, ok: false, hint: 'apt install ffmpeg' }],
    env: {},
  })
  const r = await h.kernel.handleAdminRpc('action', { id: 'check-host-deps' })
  assert.equal(r.ok, false)
  assert.match(String(r.error), /ffmpeg/)
  assert.match(String(r.message), /ffmpeg/)
})

test('B2 memory save 拒绝对象 content：不写盘、不留旧版备份', async (t) => {
  const h = await fixture(t)
  const memoryDir = path.join(h.dataDir, 'qq-memory')
  fs.mkdirSync(memoryDir, { recursive: true })
  const file = path.join(memoryDir, '20001.md')
  fs.writeFileSync(file, '# 原内容\n## 稳定记忆\n- 保留\n')
  const before = fs.readFileSync(file, 'utf8')

  const r = await h.kernel.handleAdminRpc('memory', { op: 'save', chat: 'group:20001', content: { evil: 1 } })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.match(String(r.error), /content 必须是字符串/)
  assert.equal(fs.readFileSync(file, 'utf8'), before, '记忆文件不得被覆盖')
  const revDir = path.join(memoryDir, '.revisions')
  assert.equal(fs.existsSync(revDir) ? fs.readdirSync(revDir).length : 0, 0, '拒绝时不应先写 -manual 备份')
})

test('B3 版本文件清理认全四种命名（含同秒兜底的 -N-manual）', (t) => {
  const dir = tmpDir('revs')
  const revDir = path.join(dir, '.revisions')
  fs.mkdirSync(revDir, { recursive: true })
  const names = [
    '20001-20260101-120000.md',
    '20001-20260101-120000-1.md',
    '20001-20260101-120000-manual.md',
    '20001-20260101-120000-1-manual.md',
  ]
  names.forEach((name, i) => {
    const file = path.join(revDir, name)
    fs.writeFileSync(file, 'x')
    fs.utimesSync(file, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
  })
  const removed = pruneMemoryRevisions(dir, '20001', 2)
  assert.equal(removed, 2, '四种命名都要参与保留策略（以前 -N-manual 永不清理）')
  const left = fs.readdirSync(revDir).sort()
  assert.deepEqual(left, [names[2], names[3]].sort(), `应只保留最新的两份：${left.join(',')}`)
})

test('B5 离线自检的 OneBot 项是“跳过”不是 ✅；诊断建议不再指向已删除的「DSH 连接」页', async (t) => {
  const h = await fixture(t)
  const self = await h.kernel.handleAdminRpc('action', { id: 'selfcheck' })
  assert.equal(self.ok, true)
  const onebot = (self.checks || []).find((c) => c.id === 'onebot')
  assert.ok(onebot, '自检应包含 OneBot 项')
  assert.equal(onebot.ok, false, '离线跳过不能画成通过')
  assert.match(String(onebot.detail), /跳过/)
  assert.doesNotMatch(String(self.message), /✅ OneBot 连接/)

  const diag = await h.kernel.handleAdminRpc('action', { id: 'diagnose' })
  const preset = (diag.checks || []).find((c) => c.id === 'agentPreset')
  assert.ok(preset)
  assert.doesNotMatch(`${preset.hint || ''}${preset.detail || ''}`, /DSH 连接/)
})

test('B3 控制台保存后的清理同样认全四种命名（否则 -N-manual 永久残留）', async (t) => {
  const h = await fixture(t, { pluginConfig: { 'group-memory': { accumulateRetainRevisions: 1, maxBytes: 200000 } } })
  const memoryDir = path.join(h.dataDir, 'qq-memory')
  const revDir = path.join(memoryDir, '.revisions')
  fs.mkdirSync(revDir, { recursive: true })
  fs.writeFileSync(path.join(memoryDir, '20001.md'), '# 旧内容\n')
  const names = [
    '20001-20260101-120000.md',
    '20001-20260101-120000-1.md',
    '20001-20260101-120000-manual.md',
    '20001-20260101-120000-1-manual.md',
  ]
  names.forEach((name, i) => {
    const file = path.join(revDir, name)
    fs.writeFileSync(file, 'x')
    fs.utimesSync(file, new Date(1000 * (i + 1)), new Date(1000 * (i + 1)))
  })
  const r = await h.kernel.handleAdminRpc('memory', { op: 'save', chat: 'group:20001', content: '# 新内容\n## 稳定记忆\n- 一条\n' })
  assert.equal(r.ok, true, JSON.stringify(r))
  const left = fs.readdirSync(revDir)
  assert.equal(left.length, 1, `保留 1 份时应只剩 1 个版本文件，实际：${left.join(',')}`)
})
