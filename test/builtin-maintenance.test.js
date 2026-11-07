import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createMaintenance } from '../ops/maintenance.js'

const DAY = 24 * 3600000
function symlinkOrSkip(t, target, file, type) {
  try { fs.symlinkSync(target, file, type); return true } catch (error) {
    if (['EPERM', 'ENOSYS', 'EACCES'].includes(error.code)) {
      t.skip('Symlink capability is unavailable on this host')
      return false
    }
    throw error
  }
}
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-maintenance-'))
  t.after(() => {
    assert.equal(path.dirname(root), os.tmpdir())
    assert.match(path.basename(root), /^qq-maintenance-/)
    fs.rmSync(root, { recursive: true, force: true })
  })
  const incoming = path.join(root, 'incoming')
  const imagegen = path.join(root, 'imagegen')
  fs.mkdirSync(incoming)
  fs.mkdirSync(imagegen)
  const configPath = path.join(root, 'config.json')
  fs.writeFileSync(configPath, '{"live":true}')
  let now = Date.now()
  const active = new Set()
  const m = createMaintenance({ dataDir: root, configPath, tempRoots: [incoming, imagegen], inUseFiles: () => active, clock: () => now })
  const write = (file, content = 'old-cache', old = true) => {
    fs.writeFileSync(file, content)
    if (old) fs.utimesSync(file, new Date(now - 2 * DAY), new Date(now - 2 * DAY))
    return file
  }
  const backup = (n, content = '{"same":true}') => write(`${configPath}.bak-console-${String(n).padStart(17, '0')}`, content)
  return { root, incoming, imagegen, configPath, active, m, write, backup, advance: (ms) => { now += ms } }
}

test('cleanup previews then deletes only old direct regular files in explicit roots', (t) => {
  const { root, incoming, imagegen, configPath, active, m, write } = fixture(t)
  const old = write(path.join(incoming, 'old.png'))
  const generated = write(path.join(imagegen, 'old.png'))
  const fresh = write(path.join(incoming, 'fresh.png'), 'fresh', false)
  const used = write(path.join(incoming, 'used.png'))
  active.add(used)
  const outside = write(path.join(root, 'other.txt'))
  fs.mkdirSync(path.join(incoming, 'nested'))
  const nested = write(path.join(incoming, 'nested', 'old.png'))
  const preview = m.cleanup({ files: [outside], maxAgeMs: 0 })
  assert.equal(preview.planned, 2)
  assert.equal(preview.removed, 0)
  assert.equal(preview.totalBytes, Buffer.byteLength('old-cache') * 2)
  assert.match(preview.previewLines[0], /24.*不递归/)
  assert.ok(fs.existsSync(old))
  const done = m.cleanup({ confirm: true, previewToken: preview.previewToken })
  assert.equal(done.removed, 2)
  assert.equal(fs.existsSync(old), false)
  assert.equal(fs.existsSync(generated), false)
  for (const file of [fresh, used, outside, nested, configPath]) assert.ok(fs.existsSync(file))
})

test('token required, method-bound, expiring and single-use; new files never join a plan', (t) => {
  const { incoming, m, write, advance } = fixture(t)
  const first = write(path.join(incoming, 'first'))
  assert.equal(m.cleanup({ confirm: true }).ok, false)
  const preview = m.cleanup()
  assert.equal(m.dedup({ confirm: true, previewToken: preview.previewToken }).ok, false)
  const newer = write(path.join(incoming, 'later'))
  assert.equal(m.cleanup({ confirm: true, previewToken: preview.previewToken }).removed, 1)
  assert.equal(fs.existsSync(first), false)
  assert.ok(fs.existsSync(newer))
  assert.equal(m.cleanup({ confirm: true, previewToken: preview.previewToken }).ok, false)
  const expired = m.cleanup()
  advance(10 * 60000)
  assert.equal(m.cleanup({ confirm: true, previewToken: expired.previewToken }).ok, false)
  assert.ok(fs.existsSync(newer))
})

test('confirmation skips same-size changed content with restored mtime and newly in-use files', (t) => {
  const { incoming, m, write, active } = fixture(t)
  const changed = write(path.join(incoming, 'changed'), 'AAAA')
  const used = write(path.join(incoming, 'used'))
  const before = fs.statSync(changed)
  const preview = m.cleanup()
  fs.writeFileSync(changed, 'BBBB')
  fs.utimesSync(changed, before.atime, before.mtime)
  active.add(used)
  const result = m.cleanup({ confirm: true, previewToken: preview.previewToken })
  assert.equal(result.removed, 0)
  assert.ok(result.skipped >= 2)
  assert.equal(fs.readFileSync(changed, 'utf8'), 'BBBB')
  assert.ok(fs.existsSync(used))
})

test('symlink root and symlink ancestor never become deletion scope', (t) => {
  const { root, incoming, configPath, write } = fixture(t)
  const victim = write(path.join(incoming, 'victim'))
  const link = path.join(root, 'alias')
  if (!symlinkOrSkip(t, root, link, 'dir')) return
  const throughParent = createMaintenance({ dataDir: root, configPath, tempRoots: [path.join(link, 'incoming')] })
  assert.equal(throughParent.cleanup().planned, 0)
  const other = path.join(root, 'other')
  fs.mkdirSync(other)
  if (!symlinkOrSkip(t, incoming, path.join(other, 'incoming'), 'dir')) return
  const throughRoot = createMaintenance({ dataDir: root, configPath, tempRoots: [path.join(other, 'incoming')] })
  assert.equal(throughRoot.cleanup().planned, 0)
  assert.ok(fs.existsSync(victim))
})

test('replacing a root or file after preview cannot redirect confirmation', (t) => {
  const { root, incoming, m, write } = fixture(t)
  write(path.join(incoming, 'victim'))
  const preview = m.cleanup()
  const displaced = path.join(root, 'displaced')
  assert.equal(path.dirname(incoming), root)
  assert.equal(path.dirname(displaced), root)
  fs.renameSync(incoming, displaced)
  fs.mkdirSync(incoming)
  const replacement = write(path.join(incoming, 'victim'))
  const result = m.cleanup({ confirm: true, previewToken: preview.previewToken })
  assert.equal(result.removed, 0)
  assert.ok(fs.existsSync(replacement))
  assert.ok(fs.existsSync(path.join(displaced, 'victim')))
})

test('file replaced by a symlink and in-use getter errors fail closed', (t) => {
  const { root, incoming, configPath, m, write } = fixture(t)
  const file = write(path.join(incoming, 'planned'))
  const outside = write(path.join(root, 'outside'))
  const preview = m.cleanup()
  assert.equal(path.dirname(file), incoming)
  fs.unlinkSync(file)
  if (!symlinkOrSkip(t, outside, file)) return
  assert.equal(m.cleanup({ confirm: true, previewToken: preview.previewToken }).removed, 0)
  assert.equal(fs.lstatSync(file).isSymbolicLink(), true)
  const unused = write(path.join(incoming, 'unused'))
  const guarded = createMaintenance({ dataDir: root, configPath, tempRoots: [incoming],
    inUseFiles: () => { throw new Error('tracking unavailable') } })
  assert.equal(guarded.cleanup().planned, 0)
  assert.ok(fs.existsSync(unused))
  assert.ok(fs.existsSync(outside))
})

test('dedup only removes byte-identical older console backups, always retaining latest three', (t) => {
  const { root, configPath, m, backup, write } = fixture(t)
  const files = Array.from({ length: 6 }, (_, i) => backup(i + 1))
  const distinct = backup(0, '{ "same": true }')
  const invalid = backup(7, 'invalid json')
  const ignored = [write(`${configPath}.bak-console-nope`), write(`${configPath}.bak-console-123`),
    write(`${configPath}.bak-12345678901234567`), write(path.join(root, 'credentials.json.bak-console-12345678901234567'))]
  const preview = m.dedup()
  // Latest 7(invalid),6,5 stay protected; the valid newest representative is 6.
  assert.equal(preview.planned, 4)
  assert.match(preview.previewLines[0], /保留最新 3.*不同字节内容不删/)
  assert.equal(preview.totalBytes, Buffer.byteLength('{"same":true}') * 4)
  const done = m.dedup({ confirm: true, previewToken: preview.previewToken })
  assert.equal(done.removed, 4)
  for (const file of files.slice(4)) assert.ok(fs.existsSync(file))
  for (const file of [distinct, invalid, configPath, ...ignored]) assert.ok(fs.existsSync(file))
})

test('dedup revalidates retained reference and does not delete if it disappears', (t) => {
  const { m, backup } = fixture(t)
  const files = Array.from({ length: 5 }, (_, i) => backup(i + 1))
  const preview = m.dedup()
  assert.equal(preview.planned, 2)
  const keeper = files.at(-1)
  assert.match(keeper, /config\.json\.bak-console-\d{17}$/)
  fs.unlinkSync(keeper)
  assert.equal(m.dedup({ confirm: true, previewToken: preview.previewToken }).removed, 0)
  for (const file of files.slice(0, -1)) assert.ok(fs.existsSync(file))
})

test('dedup rejects oversized JSON, symlinks and configs outside dataDir', (t) => {
  const { root, configPath, m, backup } = fixture(t)
  for (let i = 1; i <= 5; i += 1) backup(i)
  const huge = backup(6, `"${'a'.repeat(10 * 1024 * 1024)}"`)
  const link = `${configPath}.bak-console-00000000000000007`
  if (!symlinkOrSkip(t, configPath, link)) return
  const preview = m.dedup()
  assert.ok(preview.skipped >= 2)
  m.dedup({ confirm: true, previewToken: preview.previewToken })
  assert.ok(fs.existsSync(huge))
  assert.equal(fs.lstatSync(link).isSymbolicLink(), true)
  const outside = createMaintenance({ dataDir: path.join(root, 'incoming'), configPath })
  assert.equal(outside.dedup().planned, 0)
})
