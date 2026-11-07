/** Built-in, preview-first maintenance. Never invokes a shell or follows symlinks. */
import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomBytes } from 'node:crypto'
import { isInsidePath, normForCompare } from '../platform/paths.js'
import { stripBom } from '../platform/atomic.js'

const DAY = 24 * 3600000
const TTL = 10 * 60000
const MAX_JSON = 10 * 1024 * 1024
const samePath = (a, b) => normForCompare(a) === normForCompare(b)
const sameFile = (a, b) => ['dev', 'ino', 'size', 'mtimeMs', 'ctimeMs'].every((key) => a[key] === b[key])

// Validate every ancestor, not just the final root (realpath alone follows symlinks).
function directoryIdentity(root) {
  const resolved = path.resolve(root)
  const chain = []
  let cursor = resolved
  while (true) {
    const stat = fs.lstatSync(cursor)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('unsafe-directory')
    chain.push({ path: cursor, dev: stat.dev, ino: stat.ino })
    const parent = path.dirname(cursor)
    if (parent === cursor) break
    cursor = parent
  }
  const real = fs.realpathSync(resolved)
  return { real, chain }
}

function sameDirectory(a, b) {
  return samePath(a.real, b.real) && a.chain.length === b.chain.length
    && a.chain.every((item, index) => samePath(item.path, b.chain[index].path)
      && item.dev === b.chain[index].dev && item.ino === b.chain[index].ino)
}

function snapshot(root, file, json = false) {
  if (!samePath(path.dirname(file), root) || !isInsidePath(root, file)) throw new Error('outside-root')
  const directory = directoryIdentity(root)
  const stat = fs.lstatSync(file)
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not-regular')
  if (json && stat.size > MAX_JSON) throw new Error('oversize-json')
  const real = fs.realpathSync(file)
  if (!samePath(path.dirname(real), directory.real)) throw new Error('outside-real-root')
  const fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0))
  try {
    if (!sameFile(stat, fs.fstatSync(fd))) throw new Error('changed-before-read')
    const hash = createHash('sha256')
    const chunks = []
    const buffer = Buffer.alloc(65536)
    let total = 0
    let count
    while ((count = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0) {
      total += count
      if (json && total > MAX_JSON) throw new Error('oversize-json')
      hash.update(buffer.subarray(0, count))
      if (json) chunks.push(Buffer.from(buffer.subarray(0, count)))
    }
    if (!sameFile(stat, fs.fstatSync(fd)) || !sameFile(stat, fs.lstatSync(file))) throw new Error('changed-during-read')
    if (json) JSON.parse(stripBom(Buffer.concat(chunks).toString('utf8')))
    return { root, file, real, directory, stat, hash: hash.digest('hex'), json }
  } finally { fs.closeSync(fd) }
}

function unchanged(saved) {
  const current = snapshot(saved.root, saved.file, saved.json)
  return sameDirectory(saved.directory, current.directory) && samePath(saved.real, current.real)
    && sameFile(saved.stat, current.stat) && saved.hash === current.hash
}

/**
 * Only explicit incoming/imagegen roots and configPath's console backups are eligible.
 * Methods are synchronous; all confirmation tokens are process-local, single-use, 10-minute plans.
 */
export function createMaintenance({ dataDir, configPath, tempRoots = [], inUseFiles = () => [], clock = Date.now } = {}) {
  const dataRoot = dataDir ? path.resolve(dataDir) : ''
  const config = configPath ? path.resolve(configPath) : ''
  const roots = [...new Set(tempRoots.filter((root) => typeof root === 'string' && path.isAbsolute(root))
    .map((root) => path.resolve(root)).filter((root) => ['incoming', 'imagegen'].includes(path.basename(root))))]
  const plans = new Map()
  const now = () => Number(typeof clock === 'function' ? clock() : clock.now())
  const inUse = (file) => {
    // Getter failures abort safely rather than treating every file as unused.
    const files = typeof inUseFiles === 'function' ? inUseFiles() : inUseFiles
    return [...(files || [])].some((item) => {
      const resolved = path.resolve(String(item))
      if (samePath(resolved, file)) return true
      try { return samePath(fs.realpathSync(resolved), fs.realpathSync(file)) } catch { return false }
    })
  }
  const safeCandidate = (file) => !samePath(file, config) && !inUse(file)
  const result = (fields) => ({ ok: true, previewLines: [], message: '', removed: 0, skipped: 0, ...fields })

  function run(kind, payload = {}) {
    const timestamp = now()
    for (const [token, plan] of plans) if (timestamp >= plan.expiresAt) plans.delete(token)
    if (payload.confirm === true) {
      const token = String(payload.previewToken || '')
      const plan = plans.get(token)
      if (!plan || plan.kind !== kind) return result({ ok: false, message: '预演凭证无效或已过期，请重新预演。' })
      plans.delete(token)
      let removed = 0
      let skipped = plan.skipped
      for (const entry of plan.entries) {
        try {
          if (!safeCandidate(entry.file) || !unchanged(entry)) { skipped += 1; continue }
          if (entry.keeper && (!unchanged(entry.keeper) || entry.keeper.hash !== entry.hash)) { skipped += 1; continue }
          // Verify the final lexical target and all parents immediately before unlinking.
          if (!sameDirectory(entry.directory, directoryIdentity(entry.root))
            || !sameFile(entry.stat, fs.lstatSync(entry.file))) { skipped += 1; continue }
          fs.unlinkSync(entry.file)
          removed += 1
        } catch { skipped += 1 }
      }
      return result({ removed, skipped, planned: plan.entries.length, totalBytes: plan.totalBytes,
        message: `维护完成：删除 ${removed} 个，跳过 ${skipped} 个；未扩大预演范围。` })
    }
    const entries = []
    let skipped = 0
    if (kind === 'cleanup') {
      for (const root of roots) {
        let names
        try { directoryIdentity(root); names = fs.readdirSync(root) } catch { skipped += 1; continue }
        for (const name of names) {
          const file = path.join(root, name)
          try {
            const stat = fs.lstatSync(file)
            if (!stat.isFile() || stat.isSymbolicLink() || timestamp - stat.mtimeMs <= DAY || !safeCandidate(file)) { skipped += 1; continue }
            entries.push(snapshot(root, file))
          } catch { skipped += 1 }
        }
      }
    } else if (config && dataRoot) {
      const root = path.dirname(config)
      try {
        directoryIdentity(dataRoot)
        directoryIdentity(root)
        if (!isInsidePath(dataRoot, config)) throw new Error('config-outside-data')
        const prefix = `${path.basename(config)}.bak-console-`
        const names = fs.readdirSync(root).filter((name) => name.startsWith(prefix) && /^\d{17}$/.test(name.slice(prefix.length)))
          .sort((a, b) => b.localeCompare(a))
        const keepers = new Map()
        for (const [index, name] of names.entries()) {
          const file = path.join(root, name)
          try {
            const item = snapshot(root, file, true)
            const keeper = keepers.get(item.hash)
            if (index < 3 || !keeper) {
              if (!keeper) keepers.set(item.hash, item)
              continue
            }
            if (!safeCandidate(file)) { skipped += 1; continue }
            entries.push({ ...item, keeper })
          } catch { skipped += 1 }
        }
      } catch { skipped += 1 }
    }
    const previewToken = randomBytes(24).toString('hex')
    // Bound memory without ever reusing a token or expanding a previously approved plan.
    if (plans.size >= 100) plans.delete(plans.keys().next().value)
    const totalBytes = entries.reduce((total, entry) => total + entry.stat.size, 0)
    const rule = kind === 'cleanup'
      ? '规则：仅清理超过 24 小时的直接层普通文件；不递归、不跟随软链、跳过在用文件。'
      : '规则：仅 dataDir 内配置的 bak-console 备份；保留最新 3 个，不同字节内容不删，仅移除更旧重复副本。'
    plans.set(previewToken, { kind, entries, skipped, totalBytes, expiresAt: timestamp + TTL })
    return result({ previewToken, planned: entries.length, skipped, totalBytes,
      previewLines: [rule, `预计删除 ${entries.length} 个，共 ${totalBytes} bytes；跳过 ${skipped} 个。`,
        ...entries.map((entry) => `将删除：${entry.file} (${entry.stat.size} bytes)`)],
      message: `预演：${entries.length} 个文件可删除（${totalBytes} bytes），跳过 ${skipped} 个；10 分钟内确认方可执行。` })
  }

  return { cleanup: (payload) => run('cleanup', payload), dedup: (payload) => run('dedup', payload) }
}
