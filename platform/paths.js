/**
 * platform/paths.js — 跨平台路径工具（Linux / Windows 统一入口）。
 *
 * 纪律（Code Review 必查）：
 *   1. 包内代码**禁止**再出现 `/opt`、`/root`、`/var`、`/tmp` 这类默认值；
 *      所有路径都经本模块解析（配置相对路径 → dataDir 派生）。
 *   2. 白名单/包含判定只允许 `isInsidePath()`（realpath + path.relative），
 *      禁止 `startsWith(root + '/')`（Windows 反斜杠下必坏）。
 *   3. Windows 路径大小写不敏感，所有比较走 `normForCompare()`。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const isWin = process.platform === 'win32'

/** DSH 数据根：显式配置 > $DSH_HOME > ~/.dsh */
export function resolveDshHome(env = process.env, home = os.homedir()) {
  const configured = String(env.DSH_HOME || '').trim()
  if (configured) return path.resolve(expandHome(configured))
  return path.join(home, '.dsh')
}

/** 展开 `~` / `~/x`（Windows 下 `~\\x` 同样处理）；不做通配符展开。 */
export function expandHome(input) {
  const s = String(input ?? '')
  if (s === '~') return os.homedir()
  if (s.startsWith('~/') || s.startsWith('~\\')) return path.join(os.homedir(), s.slice(2))
  return s
}

/** 数据根目录：`dataDir` 配置为空时默认 `$DSH_HOME/dsh-onebot-qq`；会确保目录存在。
 *
 * 改名兼容：新版默认目录不存在、但旧版 `$DSH_HOME/dsh-qq-bot` 存在时，**继续沿用旧目录**
 * （老用户升级无感，不迁移、不丢配置；想搬新名字手动搬即可）。
 */
export function resolveDataDir(configured, env = process.env) {
  const raw = String(configured || '').trim()
  let dir
  if (raw) dir = path.resolve(expandHome(raw))
  else {
    const home = resolveDshHome(env)
    const next = path.join(home, 'dsh-onebot-qq')
    const legacy = path.join(home, 'dsh-qq-bot')
    dir = (!fs.existsSync(next) && fs.existsSync(legacy)) ? legacy : next
  }
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 临时目录：`<os.tmpdir()>/dsh-onebot-qq/<sub>`；会确保目录存在。 */
export function resolveTmpDir(...sub) {
  const dir = path.join(os.tmpdir(), 'dsh-onebot-qq', ...sub.map(String))
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

/** 判断是否是"完整绝对路径"：
 *  - POSIX：`/x`
 *  - Windows：`C:\x` / `C:/x` / `\\server\share`
 *  - Windows 的 `\x`（无盘符）**不算**（依赖当前盘，不可靠）。 */
export function isFullAbsolute(input) {
  const s = String(input ?? '')
  if (!s) return false
  if (isWin) return /^[a-zA-Z]:[\\/]/.test(s) || s.startsWith('\\\\')
  return path.isAbsolute(s)
}

/** 配置里的相对路径 → 相对 dataDir 的绝对路径；已是绝对/`~` 开头则原样归一。 */
export function resolveDataPath(value, dataDir) {
  const s = String(value ?? '').trim()
  if (!s) return ''
  if (s.startsWith('~')) return path.normalize(expandHome(s))
  if (isFullAbsolute(s)) return path.normalize(s)
  return path.resolve(dataDir, s)
}

/** 真实路径（不存在的路径退回 path.resolve，不抛错）。 */
export function canonicalPath(input) {
  const p = path.resolve(String(input))
  try {
    return fs.realpathSync(p)
  } catch {
    return p
  }
}

/** Windows 下大小写不敏感；统一小写后交给 path.relative 比较。 */
export function normForCompare(input) {
  const s = String(input)
  return isWin ? s.toLowerCase() : s
}

/**
 * 判断 `candidate` 是否在 `root` 目录内（含自身）。
 * 两侧先 realpath（软链穿不出去），再 path.relative 判定，Windows 忽略大小写。
 */
export function isInsidePath(root, candidate) {
  const r = canonicalPath(root)
  const c = canonicalPath(candidate)
  const rel = path.relative(normForCompare(r), normForCompare(c))
  if (rel === '') return true
  if (path.isAbsolute(rel)) return false
  return rel !== '..' && !rel.startsWith(`..${path.sep}`)
}

/** 确保目录存在（递归）。 */
export function ensureDir(dir) {
  const d = path.resolve(String(dir))
  fs.mkdirSync(d, { recursive: true })
  return d
}
