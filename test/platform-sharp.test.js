/**
 * test/platform-sharp.test.js — 借用 DSH 自带 sharp 的路径发现（纯函数，不依赖本机安装）。
 *
 * 关键回归：`process.argv[1]` 常常是软链（/usr/bin/dsh），必须先 realpath，
 * 否则按软链目录找不到 `<dsh 包>/node_modules/sharp`，缩放会静默降级成原图。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'

import { sharpCandidatePaths, loadSharp } from '../platform/sharp.js'
import { tmpDir } from './helpers.mjs'

test('软链 argv1：按 realpath 目录逐级向上给出 node_modules/sharp 候选', (t) => {
  const dir = tmpDir('sharp')
  const real = path.join(dir, 'bin.js')
  const link = path.join(dir, 'dsh-link.js')
  fs.writeFileSync(real, '')
  try { fs.symlinkSync(real, link) } catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) { t.skip('Symlink capability is unavailable on this host'); return }
    throw error
  }
  const cands = sharpCandidatePaths({ argv1: link, env: {} })
  assert.equal(cands[0], 'sharp', '包名兜底在最前（显式配置除外）')
  assert.ok(cands.includes(path.join(dir, 'node_modules', 'sharp')), 'realpath 同目录的 sharp 候选')
  assert.ok(cands.includes(path.join(path.dirname(dir), 'node_modules', 'sharp')), '逐级向上')
  assert.ok(cands.length <= 11, '候选有界')
})

test('DSH_QQ_SHARP 显式配置优先', () => {
  const cands = sharpCandidatePaths({ argv1: '/nonexistent/dsh', env: { DSH_QQ_SHARP: '/custom/sharp' } })
  assert.equal(cands[0], '/custom/sharp')
})

test('找不到 sharp 时 loadSharp 返回 null（降级不抛错）', () => {
  const dir = tmpDir('sharp-none')
  const entry = path.join(dir, 'bin.js')
  fs.writeFileSync(entry, '')
  assert.equal(loadSharp({ argv1: entry, env: {} }), null)
})
