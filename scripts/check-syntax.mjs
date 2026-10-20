#!/usr/bin/env node
/**
 * scripts/check-syntax.mjs — 包内所有 JS/ESM 语法自检。
 *
 * 用 `node --check`（parse-only，不执行）逐文件检查，跨平台（不依赖 bash / find / xargs）。
 * 排除目录：node_modules、.git、_reference（旧实现只读参考，不进包）、coverage、data。
 *
 * 退出码：0 = 全部通过；1 = 有文件语法错误 / 无文件可检查。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '_reference', 'coverage', 'data', 'dist'])
const EXTS = new Set(['.js', '.mjs', '.cjs'])

function walk(dir, out = []) {
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return out
  }
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) {
      if (EXCLUDE_DIRS.has(entry.name)) continue
      walk(full, out)
    } else if (entry.isFile() && EXTS.has(path.extname(entry.name).toLowerCase())) {
      out.push(full)
    }
  }
  return out
}

const files = walk(ROOT)
if (files.length === 0) {
  console.error('[check-syntax] 没找到任何 .js/.mjs 文件')
  process.exit(1)
}

const failures = []
let index = 0
for (const file of files) {
  index += 1
  const rel = path.relative(ROOT, file)
  const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' })
  if (r.error) {
    failures.push({ file: rel, message: r.error.message })
  } else if (r.status !== 0) {
    const msg = String(r.stderr || '').trim().split('\n').slice(0, 4).join('\n')
    failures.push({ file: rel, message: msg })
  }
}

if (failures.length) {
  console.error(`[check-syntax] FAIL ${failures.length}/${files.length} 个文件语法错误：`)
  for (const f of failures) console.error(`\n--- ${f.file} ---\n${f.message}`)
  process.exit(1)
}

console.error(`[check-syntax] OK ${files.length} 个文件全部通过 node --check`)
