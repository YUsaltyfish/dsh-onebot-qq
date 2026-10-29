import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createAdminEndpoints } from '../admin/endpoints.js'
import { switchPersona, PERSONA_LINK_FILES } from '../platform/persona-ref.js'
import { bootKernel } from './helpers.mjs'

const quiet = { info() {}, warn() {} }
const deferred = () => {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function snapshot(workspaceDir) {
  return Object.fromEntries([...PERSONA_LINK_FILES, '.persona.json'].map((name) => {
    const file = path.join(workspaceDir, name)
    try {
      const stat = fs.lstatSync(file)
      return [name, stat.isSymbolicLink()
        ? { type: 'link', target: fs.readlinkSync(file) }
        : { type: 'file', bytes: fs.readFileSync(file).toString('base64'), mode: stat.mode & 0o777 }]
    } catch (error) {
      if (error.code !== 'ENOENT') throw error
      return [name, null]
    }
  }))
}
async function setup(t) {
  const h = await bootKernel({ config: { pluginConfig: { 'persona-voice': { activePersona: 'Alpha' } } } })
  t.after(() => h.dispose())
  const { workspaceDir, personaDir } = h.kernel.paths
  fs.mkdirSync(personaDir, { recursive: true })
  for (const [name, rich] of [['Alpha', true], ['Beta', false], ['Gamma', true]]) {
    fs.writeFileSync(path.join(personaDir, `${name}.md`), `# ${name}\nSynthetic fixture instructions.\n`)
    if (rich) {
      fs.writeFileSync(path.join(personaDir, `${name}.lines.txt`), `[neutral]\n${name} fixture phrase\n`)
      fs.writeFileSync(path.join(personaDir, `${name}.wake.txt`), `${name}-wake\n`)
    }
  }
  switchPersona({ workspaceDir, personaDir, name: 'Alpha', mode: 'auto' })
  await h.kernel.reloadConfig()
  const admin = createAdminEndpoints({ kernel: h.kernel, log: quiet })
  return { ...h, workspaceDir, admin }
}

test('console reload failure restores exact persona links/files/pointer and raw config before reloading old runtime', async (t) => {
  const h = await setup(t)
  const before = snapshot(h.workspaceDir)
  const configBefore = fs.readFileSync(h.configPath, 'utf8')
  const reload = h.kernel.reloadConfig.bind(h.kernel)
  let calls = 0
  h.kernel.reloadConfig = async () => {
    if (++calls === 1) {
      await reload() // actual runtime changed before failure
      assert.equal(h.kernel.raw.pluginConfig['persona-voice'].activePersona, 'Beta')
      throw new Error('synthetic reload failure')
    }
    assert.deepEqual(snapshot(h.workspaceDir), before, 'restore persona before rollback reload')
    assert.equal(fs.readFileSync(h.configPath, 'utf8'), configBefore)
    return reload()
  }
  const result = await h.admin.handle('persona', { op: 'switch', name: 'Beta' })
  assert.equal(result.ok, false)
  assert.match(result.error, /synthetic reload failure/)
  assert.deepEqual(snapshot(h.workspaceDir), before)
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), configBefore)
  assert.equal(h.kernel.raw.pluginConfig['persona-voice'].activePersona, 'Alpha')
  assert.equal(calls, 2)
  assert.equal(fs.readdirSync(h.workspaceDir).some((name) => name.startsWith('.persona-')), false)
})

test('concurrent console switches cannot install the second persona before first rollback finishes', async (t) => {
  const h = await setup(t)
  const before = snapshot(h.workspaceDir)
  const reload = h.kernel.reloadConfig.bind(h.kernel)
  const entered = deferred()
  const release = deferred()
  const applied = []
  let calls = 0
  h.kernel.reloadConfig = async () => {
    calls += 1
    if (calls === 1) {
      await reload()
      entered.resolve()
      await release.promise
      throw new Error('first switch failed')
    }
    if (calls === 2) assert.deepEqual(snapshot(h.workspaceDir), before)
    const result = await reload()
    applied.push(h.kernel.raw.pluginConfig['persona-voice'].activePersona)
    return result
  }
  const first = h.admin.handle('persona', { op: 'switch', name: 'Beta' })
  await entered.promise
  const installedBeta = snapshot(h.workspaceDir)
  const secondAdmin = createAdminEndpoints({ kernel: h.kernel, log: quiet })
  const second = secondAdmin.handle('persona', { op: 'switch', name: 'Gamma' })
  await Promise.resolve()
  assert.deepEqual(snapshot(h.workspaceDir), installedBeta, 'queued effect must not install Gamma yet')
  release.resolve()
  assert.equal((await first).ok, false)
  assert.equal((await second).ok, true)
  assert.deepEqual(applied, ['Alpha', 'Gamma'])
  assert.equal(h.kernel.raw.pluginConfig['persona-voice'].activePersona, 'Gamma')
  assert.match(fs.readFileSync(path.join(h.workspaceDir, 'AGENTS.local.md'), 'utf8'), /Gamma/)
  assert.equal(fs.readdirSync(h.workspaceDir).some((name) => name.startsWith('.persona-')), false)
})
