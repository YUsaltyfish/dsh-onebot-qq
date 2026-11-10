import fs from 'node:fs'
import path from 'node:path'
import { atomicWriteFileSync } from '../../platform/atomic.js'

const revisionBase = (key) => String(key).replace(':', '_')
export function pruneMemoryRevisions(dir, key, keep) {
  if (!/^(?:private:)?\d{4,12}$/.test(String(key))) throw new Error('Invalid memory revision key')
  const root = path.resolve(dir, '.revisions')
  const re = new RegExp(`^${revisionBase(key)}-(?:\\d{8}-\\d{6}(?:-\\d+)?|\\d{8}-\\d{6}-manual)\\.md$`)
  let names
  try { names = fs.readdirSync(root) } catch (e) { if (e.code === 'ENOENT') return 0; throw e }
  const entries = names.filter((name) => re.test(name)).map((name) => ({ name, at: fs.statSync(path.join(root, name)).mtimeMs }))
    .sort((a, b) => a.at - b.at || a.name.localeCompare(b.name))
  let removed = 0
  for (const entry of entries.slice(0, Math.max(0, entries.length - Math.max(0, keep)))) {
    const target = path.resolve(root, entry.name)
    // Verified basename and parent keep retention strictly inside this chat's revision directory.
    if (path.dirname(target) !== root || !re.test(path.basename(target))) throw new Error('Invalid revision path')
    fs.unlinkSync(target)
    removed++
  }
  return removed
}

/** Shared accumulator writer: exact old document backup, atomic replacement, cache invalidation. */
export function writeMemoryDocument({ dir, key, file, original = '', text, keep = 20, onInvalidate }) {
  const body = String(text || '').trimEnd() + '\n'
  if (String(original).trimEnd() === body.trimEnd()) return false
  fs.mkdirSync(path.dirname(file), { recursive: true })
  if (original && keep > 0) {
    const rev = path.join(dir, '.revisions')
    fs.mkdirSync(rev, { recursive: true })
    const iso = new Date().toISOString().replace(/[-:T.]/g, '')
    const stamp = `${iso.slice(0, 8)}-${iso.slice(8, 14)}`
    let backup = path.join(rev, `${revisionBase(key)}-${stamp}.md`)
    for (let n = 1; fs.existsSync(backup); n++) backup = path.join(rev, `${revisionBase(key)}-${stamp}-${n}.md`)
    atomicWriteFileSync(backup, original.endsWith('\n') ? original : original + '\n', { mode: 0o600 })
  }
  atomicWriteFileSync(file, body, { mode: 0o600 })
  onInvalidate?.(key)
  // Cleanup never turns a successful write into a failed task (which could otherwise replay it).
  try { if (keep > 0) pruneMemoryRevisions(dir, key, keep) } catch { /* retry cleanup next write */ }
  return true
}
