/**
 * platform/atomic.js — 配置/状态文件的稳健读写（跨平台）。
 *
 * Windows 的特殊性：
 *   · 杀毒/索引器可能短暂占用文件 → rename 覆盖可能抛 EPERM/EBUSY/EACCES，退避重试；
 *   · 记事本等编辑器可能写 UTF-8 BOM → JSON.parse 会失败，读盘统一剥 BOM。
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './paths.js'

const RETRYABLE = new Set(['EPERM', 'EACCES', 'EBUSY'])
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** 剥 UTF-8 BOM。 */
export function stripBom(text) {
  return String(text ?? '').replace(/^\uFEFF/, '')
}

/** 读 JSON（自动剥 BOM）；文件不存在抛 ENOENT，由调用方决定是否忽略。 */
export function readJsonFile(file) {
  return JSON.parse(stripBom(fs.readFileSync(file, 'utf8')))
}

/**
 * 原子写文本：temp 文件（同目录、带 pid+随机）→ rename 覆盖。
 * Windows 上 rename 可能被占用，做 3 次退避重试（约 30/90/180ms）。
 */
export function atomicWriteFileSync(file, data, opts = {}) {
  const target = path.resolve(String(file))
  ensureDir(path.dirname(target))
  const tmp = `${target}.tmp-${process.pid}-${Math.random().toString(36).slice(2, 8)}`
  const mode = Number.isInteger(opts.mode) ? opts.mode : null
  fs.writeFileSync(tmp, data, { encoding: opts.encoding || 'utf8', ...(mode != null ? { mode } : {}) })
  let lastErr
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      fs.renameSync(tmp, target)
      // rename 之后按需收紧权限（写 tmp 时的 mode 会受 umask 影响，目标文件也要显式设）
      if (mode != null) { try { fs.chmodSync(target, mode) } catch { /* Windows 无 chmod 语义 */ } }
      return target
    } catch (e) {
      lastErr = e
      if (!RETRYABLE.has(e.code) || attempt === 2) break
      sleepMs(30 * (attempt + 1) * (attempt + 1))
    }
  }
  try {
    fs.unlinkSync(tmp)
  } catch {
    /* temp 可能已被 rename 掉 */
  }
  throw lastErr
}

/** 原子写 JSON（4 空格缩进 + 末尾换行）。 */
export function writeJsonFileSync(file, value, opts = {}) {
  return atomicWriteFileSync(file, `${JSON.stringify(value, null, 4)}\n`, opts)
}

/** 复制备份（文件名后缀必须 ASCII，避免跨 locale 工具链问题）。 */
export function backupFileSync(file, tag = 'bak') {
  const src = path.resolve(String(file))
  if (!fs.existsSync(src)) return ''
  const stamp = new Date().toISOString().replace(/[-:T.Z]/g, '').slice(0, 17)
  const bak = `${src}.${tag}-${stamp}`
  fs.copyFileSync(src, bak)
  try { fs.chmodSync(bak, 0o600) } catch { /* Windows 无 chmod 语义 */ }
  return bak
}
