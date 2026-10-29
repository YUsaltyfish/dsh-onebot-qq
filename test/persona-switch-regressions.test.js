import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PERSONA_LINK_FILES, switchPersona, beginPersonaSwitch, readPersonaPointer } from '../platform/persona-ref.js'

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-persona-'))
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))
  const personaDir = path.join(root, 'personas')
  const workspaceDir = path.join(root, 'workspace')
  fs.mkdirSync(personaDir)
  fs.mkdirSync(workspaceDir)
  const source = (name, suffix, value) => fs.writeFileSync(path.join(personaDir, `${name}${suffix}`), value)
  for (const suffix of ['.md', '.lines.txt', '.wake.txt']) source('Alpha', suffix, `Alpha${suffix}`)
  source('_default', '.lines.txt', 'shared')
  source('Beta', '.md', 'Beta')
  return { root, personaDir, workspaceDir, source }
}

function snapshot(ws) {
  return Object.fromEntries([...PERSONA_LINK_FILES, '.persona.json'].map((name) => {
    const file = path.join(ws, name)
    try {
      const stat = fs.lstatSync(file)
      return [name, stat.isSymbolicLink()
        ? { link: fs.readlinkSync(file) }
        : { bytes: fs.readFileSync(file).toString('hex'), mode: stat.mode }]
    } catch (e) {
      if (e.code === 'ENOENT') return [name, null]
      throw e
    }
  }))
}

test('persona transaction: commit retains delivery and terminators are idempotent', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  const transaction = beginPersonaSwitch({ ...f, name: 'Beta', mode: 'copy' })
  assert.equal(transaction.result.name, 'Beta')
  assert.equal(transaction.result.ok, true)
  assert.equal(readPersonaPointer(f.workspaceDir).name, 'Beta')
  assert.ok(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.persona-')))
  transaction.commit()
  const committed = snapshot(f.workspaceDir)
  transaction.commit()
  transaction.rollback()
  assert.deepEqual(snapshot(f.workspaceDir), committed)
  assert.equal(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.persona-')), false)
})

for (const originalMode of ['copy', 'symlink']) {
  test(`persona transaction: async save rejection restores exact ${originalMode} originals without source replay`, {
    skip: originalMode === 'symlink' && process.platform === 'win32',
  }, async (t) => {
    const f = fixture(t)
    switchPersona({ ...f, name: 'Alpha', mode: originalMode })
    const before = snapshot(f.workspaceDir)
    const mode = originalMode === 'copy' && process.platform !== 'win32' ? 'symlink' : 'copy'
    const transaction = beginPersonaSwitch({ ...f, name: 'Beta', mode })
    let rejectSave
    const save = new Promise((_, reject) => { rejectSave = reject })
    const failed = save.catch((error) => { transaction.rollback(); throw error })
    assert.ok(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.persona-')))
    f.source('Alpha', '.md', 'changed during save')
    fs.unlinkSync(path.join(f.personaDir, 'Alpha.wake.txt'))
    rejectSave(new Error('configuration reload failed'))
    await assert.rejects(failed, /configuration reload failed/)
    assert.deepEqual(snapshot(f.workspaceDir), before)
    transaction.rollback()
    transaction.commit()
    assert.deepEqual(snapshot(f.workspaceDir), before)
    assert.equal(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.persona-')), false)
  })
}

test('persona transaction: rollback first install removes all staged deliveries', (t) => {
  const f = fixture(t)
  const before = snapshot(f.workspaceDir)
  const transaction = beginPersonaSwitch({ ...f, name: 'Alpha', mode: 'copy' })
  transaction.rollback()
  assert.deepEqual(snapshot(f.workspaceDir), before)
  assert.deepEqual(fs.readdirSync(f.workspaceDir), [])
})

test('persona transaction: external rollback failure preserves original backups', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  const before = snapshot(f.workspaceDir)
  const transaction = beginPersonaSwitch({ ...f, name: 'Beta', mode: 'copy' })
  const original = fs.renameSync
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (String(from).endsWith('AGENTS.local.md.bak')) throw new Error('rollback denied')
    return original.call(this, from, to)
  })
  assert.throws(() => transaction.rollback(), AggregateError)
  transaction.commit() // failed rollback must never discard recovery backups
  const staging = fs.readdirSync(f.workspaceDir).find((file) => file.startsWith('.persona-'))
  assert.ok(staging)
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, staging, 'AGENTS.local.md.bak')).toString('hex'), before['AGENTS.local.md'].bytes)
})

for (const mode of ['copy', 'symlink']) {
  const options = { skip: mode === 'symlink' && process.platform === 'win32' }
  test(`persona ${mode}: missing optional deliveries removed, shared fallback retained`, options, (t) => {
    const f = fixture(t)
    switchPersona({ ...f, name: 'Alpha', mode })
    const result = switchPersona({ ...f, name: 'Beta', mode })
    assert.equal(result.ok, true)
    assert.deepEqual(result.missing, ['lines.txt', 'wake.txt'])
    assert.ok(result.changed.includes('lines.txt'))
    assert.ok(result.changed.includes('wake.txt'))
    assert.equal(fs.existsSync(path.join(f.workspaceDir, 'lines.txt')), false)
    assert.equal(fs.existsSync(path.join(f.workspaceDir, 'wake.txt')), false)
    assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'lines.default.txt'), 'utf8'), 'shared')
    assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'AGENTS.local.md'), 'utf8'), 'Beta')
    assert.equal(readPersonaPointer(f.workspaceDir).name, 'Beta')
    fs.unlinkSync(path.join(f.personaDir, '_default.lines.txt'))
    switchPersona({ ...f, name: 'Beta', mode })
    assert.equal(fs.existsSync(path.join(f.workspaceDir, 'lines.default.txt')), false)
    assert.deepEqual(fs.readdirSync(f.workspaceDir).sort(), ['.persona.json', 'AGENTS.local.md'])
  })

  for (const failureAt of ['stage', 'commit', 'pointer']) {
    test(`persona ${mode}: ${failureAt} failure rolls back entire delivery`, options, (t) => {
      const f = fixture(t)
      switchPersona({ ...f, name: 'Alpha', mode })
      const before = snapshot(f.workspaceDir)
      const method = failureAt === 'stage' ? (mode === 'copy' ? 'copyFileSync' : 'symlinkSync') : 'renameSync'
      const original = fs[method]
      let failed = false
      t.mock.method(fs, method, function (...args) {
        const target = String(args[1])
        const inject = failureAt === 'stage' || (failureAt === 'commit'
          ? target === path.join(f.workspaceDir, 'lines.default.txt')
          : target === path.join(f.workspaceDir, '.persona.json'))
        if (!failed && inject) {
          failed = true
          throw new Error(`injected ${failureAt} failure`)
        }
        return original.apply(this, args)
      })
      assert.throws(() => switchPersona({ ...f, name: 'Beta', mode }), /injected/)
      assert.equal(failed, true)
      assert.deepEqual(snapshot(f.workspaceDir), before)
      assert.equal(fs.readdirSync(f.workspaceDir).some((name) => name.startsWith('.persona-')), false)
    })
  }
}

test('persona: first installation commit failure leaves no pointer or deliveries', (t) => {
  const f = fixture(t)
  const before = snapshot(f.workspaceDir)
  const original = fs.renameSync
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (to === path.join(f.workspaceDir, 'wake.txt')) throw new Error('injected install failure')
    return original.call(this, from, to)
  })
  assert.throws(() => switchPersona({ ...f, name: 'Alpha', mode: 'copy' }), /injected install/)
  assert.deepEqual(snapshot(f.workspaceDir), before)
  assert.deepEqual(fs.readdirSync(f.workspaceDir), [])
})

test('persona: rollback failure reports error and retains exact original backup', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  const before = snapshot(f.workspaceDir)
  const original = fs.renameSync
  let commitFailed = false
  t.mock.method(fs, 'renameSync', function (from, to) {
    if ((!commitFailed && to === path.join(f.workspaceDir, '.persona.json')) || String(from).endsWith('AGENTS.local.md.bak')) {
      commitFailed = true
      throw new Error('injected rollback failure')
    }
    return original.call(this, from, to)
  })
  assert.throws(() => switchPersona({ ...f, name: 'Beta', mode: 'copy' }), AggregateError)
  const staging = fs.readdirSync(f.workspaceDir).find((file) => file.startsWith('.persona-'))
  assert.ok(staging)
  const backup = fs.readFileSync(path.join(f.workspaceDir, staging, 'AGENTS.local.md.bak')).toString('hex')
  assert.equal(backup, before['AGENTS.local.md'].bytes)
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, '.persona.json')).toString('hex'), before['.persona.json'].bytes)
})

for (const method of ['unlinkSync', 'rmdirSync']) {
  test(`persona: ${method} cleanup failure does not reject committed switch`, (t) => {
    const f = fixture(t)
    switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
    const original = fs[method]
    t.mock.method(fs, method, function (file, ...args) {
      if (path.dirname(file) !== f.workspaceDir || method === 'rmdirSync') {
        throw Object.assign(new Error('injected cleanup failure'), { code: 'EBUSY' })
      }
      return original.call(this, file, ...args)
    })
    const result = switchPersona({ ...f, name: 'Beta', mode: 'copy' })
    assert.equal(result.ok, true)
    assert.equal(readPersonaPointer(f.workspaceDir).name, 'Beta')
    assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'AGENTS.local.md'), 'utf8'), 'Beta')
    assert.equal(fs.existsSync(path.join(f.workspaceDir, 'wake.txt')), false)
    assert.ok(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.persona-')))
    t.mock.restoreAll()
  })
}

test('persona: cleanup failure after rollback preserves the original delivery error', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  const before = snapshot(f.workspaceDir)
  const original = fs.renameSync
  let failed = false
  t.mock.method(fs, 'renameSync', function (from, to) {
    if (!failed && to === path.join(f.workspaceDir, '.persona.json')) {
      failed = true
      throw new Error('injected original commit failure')
    }
    return original.call(this, from, to)
  })
  t.mock.method(fs, 'rmdirSync', () => { throw new Error('injected cleanup failure') })
  assert.throws(() => switchPersona({ ...f, name: 'Beta', mode: 'copy' }), /original commit failure/)
  assert.deepEqual(snapshot(f.workspaceDir), before)
  t.mock.restoreAll()
})

test('persona auto: unavailable symlink permission falls back to copy', (t) => {
  const f = fixture(t)
  t.mock.method(fs, 'symlinkSync', () => { throw Object.assign(new Error('denied'), { code: 'EPERM' }) })
  const result = switchPersona({ ...f, name: 'Alpha' })
  assert.equal(result.mode, 'copy')
  for (const file of PERSONA_LINK_FILES) assert.equal(fs.lstatSync(path.join(f.workspaceDir, file)).isSymbolicLink(), false)
  assert.equal(fs.readdirSync(f.workspaceDir).some((file) => file.startsWith('.symlink-probe-')), false)
})

test('persona: directory conflicts and invalid pointers remain untouched', (t) => {
  const f = fixture(t)
  const wake = path.join(f.workspaceDir, 'wake.txt')
  fs.mkdirSync(wake)
  fs.writeFileSync(path.join(wake, 'user.txt'), 'user')
  assert.throws(() => switchPersona({ ...f, name: 'Alpha', mode: 'copy' }), /保留用户文件/)
  assert.equal(fs.readFileSync(path.join(wake, 'user.txt'), 'utf8'), 'user')
  fs.writeFileSync(path.join(f.workspaceDir, '.persona.json'), 'invalid')
  assert.throws(() => switchPersona({ ...f, name: 'Beta', mode: 'copy' }), /指针无法读取/)
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, '.persona.json'), 'utf8'), 'invalid')
  assert.equal(fs.existsSync(path.join(f.workspaceDir, 'AGENTS.local.md')), false)
})

test('persona copy: modified deliveries and unowned optional files are preserved', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  fs.writeFileSync(path.join(f.workspaceDir, 'wake.txt'), 'user wake')
  fs.writeFileSync(path.join(f.workspaceDir, 'lines.txt'), 'user pool')
  switchPersona({ ...f, name: 'Beta', mode: 'copy' })
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'wake.txt'), 'utf8'), 'user wake')
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'lines.txt'), 'utf8'), 'user pool')
  const before = snapshot(f.workspaceDir)
  assert.throws(() => switchPersona({ ...f, name: 'Alpha', mode: 'copy' }), /保留用户文件/)
  assert.deepEqual(snapshot(f.workspaceDir), before)
})

test('persona copy: pointer hashes recognize removed/edited source without deleting user files', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  f.source('Alpha', '.lines.txt', 'edited source')
  fs.unlinkSync(path.join(f.personaDir, 'Alpha.wake.txt'))
  switchPersona({ ...f, name: 'Beta', mode: 'copy' })
  assert.equal(fs.existsSync(path.join(f.workspaceDir, 'lines.txt')), false)
  assert.equal(fs.existsSync(path.join(f.workspaceDir, 'wake.txt')), false)
})

test('persona: unowned required file refuses complete transaction; identical template stays unowned', (t) => {
  const f = fixture(t)
  fs.writeFileSync(path.join(f.workspaceDir, 'AGENTS.local.md'), 'user body')
  const before = snapshot(f.workspaceDir)
  assert.throws(() => switchPersona({ ...f, name: 'Alpha', mode: 'copy' }), /保留用户文件/)
  assert.deepEqual(snapshot(f.workspaceDir), before)
  fs.writeFileSync(path.join(f.workspaceDir, 'AGENTS.local.md'), 'Alpha.md')
  fs.writeFileSync(path.join(f.workspaceDir, 'lines.default.txt'), 'shared')
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  assert.equal(readPersonaPointer(f.workspaceDir).files['AGENTS.local.md'], undefined)
  fs.unlinkSync(path.join(f.personaDir, '_default.lines.txt'))
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'lines.default.txt'), 'utf8'), 'shared')
})

test('persona: legacy copy pointer adopts only unchanged previous deliveries', (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'copy' })
  fs.writeFileSync(path.join(f.workspaceDir, '.persona.json'), JSON.stringify({ name: 'Alpha', mode: 'copy' }))
  fs.writeFileSync(path.join(f.workspaceDir, 'wake.txt'), 'user wake')
  switchPersona({ ...f, name: 'Beta', mode: 'copy' })
  assert.equal(fs.existsSync(path.join(f.workspaceDir, 'lines.txt')), false)
  assert.equal(fs.readFileSync(path.join(f.workspaceDir, 'wake.txt'), 'utf8'), 'user wake')
})

test('persona symlink: legacy links and dangling managed links handled without touching external links', {
  skip: process.platform === 'win32',
}, (t) => {
  const f = fixture(t)
  switchPersona({ ...f, name: 'Alpha', mode: 'symlink' })
  fs.unlinkSync(path.join(f.workspaceDir, '.persona.json'))
  switchPersona({ ...f, name: 'Beta', mode: 'symlink' })
  switchPersona({ ...f, name: 'Alpha', mode: 'symlink' })
  fs.unlinkSync(path.join(f.personaDir, 'Alpha.lines.txt'))
  fs.unlinkSync(path.join(f.workspaceDir, 'wake.txt'))
  const external = path.join(f.root, 'user-wake.txt')
  fs.writeFileSync(external, 'external')
  fs.symlinkSync(external, path.join(f.workspaceDir, 'wake.txt'), 'file')
  switchPersona({ ...f, name: 'Beta', mode: 'copy' })
  assert.equal(snapshot(f.workspaceDir)['lines.txt'], null)
  assert.equal(fs.readlinkSync(path.join(f.workspaceDir, 'wake.txt')), external)
  assert.equal(fs.readFileSync(external, 'utf8'), 'external')
  assert.equal(fs.lstatSync(path.join(f.workspaceDir, 'AGENTS.local.md')).isSymbolicLink(), false)
})
