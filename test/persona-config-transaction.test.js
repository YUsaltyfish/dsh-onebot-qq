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

// ── A2：控制台「当前人设」文本框 = 钉死并切换（与总览芯片同一条事务）──────────
const deliveredMd = (h) => fs.readFileSync(path.join(h.workspaceDir, 'AGENTS.local.md'), 'utf8')
const pinned = (h) => h.kernel.raw.pluginConfig['persona-voice']?.activePersona

test('set 写人设 = 钉死 + 投递文件（不再只写 config 的半切换）', async (t) => {
  const h = await setup(t)
  const r = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: 'Beta' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(pinned(h), 'Beta', '配置要钉死新人设')
  assert.match(deliveredMd(h), /Beta/, 'DSH 读的人设正文要一起换（不是只换句池）')
})

test('set 写不存在的人设：报错且配置、投递文件都不动', async (t) => {
  const h = await setup(t)
  const before = snapshot(h.workspaceDir)
  const configBefore = fs.readFileSync(h.configPath, 'utf8')
  const r = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: '不存在的人设' })
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.deepEqual(snapshot(h.workspaceDir), before)
  assert.equal(fs.readFileSync(h.configPath, 'utf8'), configBefore)
})

test('set 写空串 = 解除钉死（只写配置，不重投递）', async (t) => {
  const h = await setup(t)
  const before = snapshot(h.workspaceDir)
  const r = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: '' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(pinned(h), '', '空串应清掉钉死')
  assert.deepEqual(snapshot(h.workspaceDir), before, '解除钉死不需要动投递文件')
})

test('已是当前人设：不重投（copy 模式下重投会因用户手改而报冲突）', async (t) => {
  const h = await setup(t)
  assert.equal(pinned(h), 'Alpha')
  // 用户手改过投递文件（很常见：临时调人设）
  fs.appendFileSync(path.join(h.workspaceDir, 'AGENTS.local.md'), '\n用户临时补充\n')
  const before = snapshot(h.workspaceDir)
  const r = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: 'Alpha' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.match(String(r.message || ''), /无需切换|钉死/)
  assert.deepEqual(snapshot(h.workspaceDir), before, '同人设不得重新投递（不能覆盖用户改动）')
})

test('人设未钉死时填写当前人设名：只钉死、不重投', async (t) => {
  const h = await setup(t)
  const off = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: '' })
  assert.equal(off.ok, true, JSON.stringify(off))
  const before = snapshot(h.workspaceDir)
  const r = await h.admin.handle('set', { key: 'persona-voice.activePersona', value: 'Alpha' })
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.equal(pinned(h), 'Alpha', '应钉死当前人设')
  assert.deepEqual(snapshot(h.workspaceDir), before, '文件已经是对的，不需要重投')
})
