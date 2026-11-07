import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import vm from 'node:vm'
import { bootKernel } from './helpers.mjs'
import { createAdminHost } from '../admin/host.js'
import { createAdminEndpoints } from '../admin/endpoints.js'
import { createMaintenance } from '../ops/maintenance.js'
import { runDiagnostics } from '../admin/diagnostics.js'

const quiet = { info() {}, warn() {}, error() {}, debug() {} }

async function fixture(t) {
  const h = await bootKernel({ config: { pluginConfig: { 'group-memory': { accumulateEnabled: false } } } })
  t.after(h.dispose)
  return h
}

function snapshot(dir) {
  const out = {}
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) out[entry.name] = snapshot(file)
    else if (entry.isSymbolicLink()) out[entry.name] = `link:${fs.readlinkSync(file)}`
    else out[entry.name] = fs.readFileSync(file).toString('base64')
  }
  return out
}

test('host不加载环境指定扩展、不暴露ops/setOps；status不伪造系统服务', async (t) => {
  const h = await fixture(t)
  const marker = path.join(h.dataDir, 'executed')
  const extension = path.join(h.dataDir, 'ops.local.mjs')
  fs.writeFileSync(extension, `import fs from 'node:fs'; fs.writeFileSync(${JSON.stringify(marker)}, 'bad'); export default {}`)
  const before = process.env.DSH_QQ_OPS
  process.env.DSH_QQ_OPS = extension
  t.after(() => { if (before === undefined) delete process.env.DSH_QQ_OPS; else process.env.DSH_QQ_OPS = before })
  const host = await createAdminHost({ ctx: h.ctx, kernel: h.kernel, log: quiet,
    ops: { systemdProbe() { assert.fail('removed injected extension executed') } },
  })
  t.after(host.dispose)
  assert.equal(fs.existsSync(marker), false)
  assert.equal(fs.existsSync(extension), true, '保留用户私有文件，仅移除加载机制')
  assert.equal('ops' in host, false)
  assert.equal('setOps' in host.api, false)
  const status = await host.handle('status')
  assert.equal(status.services, null)
})

test('内置selfcheck复用离线诊断：不网络/模型/宿主回调/写报告/写探针，逐项结果可见', async (t) => {
  const h = await fixture(t)
  for (const method of ['checkOneBot', 'checkAgentPreset', 'status']) {
    h.kernel[method] = () => { assert.fail(`offline called ${method}`) }
  }
  h.kernel.onebot.health = () => { assert.fail('offline network health callback') }
  h.kernel.dsh.prompt = () => { assert.fail('offline model prompt') }
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { assert.fail('offline fetch') }
  t.after(() => { globalThis.fetch = originalFetch })
  const before = snapshot(h.dataDir)
  const api = createAdminEndpoints({ kernel: h.kernel, log: quiet })
  const result = await api.handle('action', { id: 'selfcheck' })
  assert.equal(result.ok, true, result.error)
  assert.equal(result.reportPath, '')
  assert.match(result.message, /配置校验/)
  assert.match(result.message, /跳过网络探测/)
  assert.doesNotMatch(result.report, /报告落盘失败/)
  assert.deepEqual(snapshot(h.dataDir), before)
})

test('离线诊断不为缺失目录创建路径；线上诊断仍执行探测并导出报告', async (t) => {
  const h = await fixture(t)
  const api = createAdminEndpoints({ kernel: h.kernel, log: quiet })
  const missing = path.join(h.dataDir, 'missing-workspace')
  const kernel = { ...h.kernel, paths: { ...h.kernel.paths, workspaceDir: missing } }
  const offline = await runDiagnostics({ kernel, store: api.store, offline: true, persist: false, log: quiet })
  assert.equal(fs.existsSync(missing), false)
  assert.equal(offline.checks.find((c) => c.id === 'dirs').ok, false)
  let checks = 0
  kernel.checkOneBot = async () => { checks++; return { ok: true, linked: true } }
  const online = await runDiagnostics({ kernel, store: api.store, log: quiet })
  assert.equal(checks, 1)
  assert.equal(fs.existsSync(missing), true)
  assert.ok(online.reportPath)
  assert.equal(fs.existsSync(online.reportPath), true)
})

test('cleanup/dedup端点必须本次预演token，拒绝空/跨动作/复用token；会话清空仍沿用confirm', async (t) => {
  const h = await fixture(t)
  const root = path.join(h.dataDir, 'incoming')
  fs.mkdirSync(root)
  const old = path.join(root, 'old.png')
  fs.writeFileSync(old, 'old')
  const past = new Date(Date.now() - 48 * 3600000)
  fs.utimesSync(old, past, past)
  h.kernel.maintenance = createMaintenance({ dataDir: h.dataDir, configPath: h.configPath, tempRoots: [root] })
  const api = createAdminEndpoints({ kernel: h.kernel, log: quiet })
  const preview = await api.handle('action', { id: 'cleanup-tmp' })
  assert.equal(preview.ok, true)
  assert.equal(preview.needsConfirm, true)
  assert.ok(preview.previewToken)
  assert.equal(fs.existsSync(old), true)
  for (const payload of [
    { id: 'cleanup-tmp', confirm: true },
    { id: 'dedup-baks', confirm: true, previewToken: preview.previewToken },
  ]) {
    const rejected = await api.handle('action', payload)
    assert.equal(rejected.ok, false)
    assert.match(rejected.error, /预演/)
  }
  const done = await api.handle('action', { id: 'cleanup-tmp', confirm: true, previewToken: preview.previewToken })
  assert.equal(done.removed, 1)
  assert.equal(fs.existsSync(old), false)
  assert.equal((await api.handle('action', { id: 'cleanup-tmp', confirm: true, previewToken: preview.previewToken })).ok, false)
  let clear = 0
  h.kernel.clearAllLines = async () => { clear++; return { cleared: 0 } }
  assert.equal((await api.handle('action', { id: 'clear-qq-sessions' })).needsConfirm, true)
  assert.equal(clear, 0)
  assert.equal((await api.handle('action', { id: 'clear-qq-sessions', confirm: true })).ok, true)
  assert.equal(clear, 1)
})

test('浏览器清理确认回传预演token，clear-sessions未要求token', async () => {
  let client
  const react = { createElement: (type, props, ...children) => ({ type, props: props || {}, children }) }
  const source = fs.readFileSync(new URL('../client.js', import.meta.url), 'utf8')
    .replace('return module.exports', 'return { OpsTab }')
  vm.runInNewContext(source, { window: { __ModuleLoader__: { load: ({ factory }) => { client = factory(() => react) } } } })
  const nodes = (tree) => Array.isArray(tree) ? tree.flatMap(nodes) : tree && typeof tree === 'object' ? [tree, ...nodes(tree.children)] : []
  for (const id of ['cleanup-tmp', 'dedup-baks', 'clear-qq-sessions']) {
    const calls = []
    let confirm
    const props = {
      schema: { actions: [{ id, label: id, confirm: {} }] }, busy: false,
      setBusy() {}, setMsg() {}, setConfirmBox(value) { confirm = value },
      run: (_label, fn) => fn(),
      call: async (_endpoint, payload) => {
        calls.push(JSON.parse(JSON.stringify(payload)))
        return { ok: true, previewLines: ['preview'], ...(id !== 'clear-qq-sessions' ? { previewToken: 'one-preview' } : {}) }
      },
    }
    nodes(client.OpsTab(props)).find((n) => n.type === 'button').props.onClick()
    await new Promise((resolve) => setImmediate(resolve))
    await confirm.onOk()
    assert.deepEqual(calls, [{ id }, { id, confirm: true, ...(id !== 'clear-qq-sessions' ? { previewToken: 'one-preview' } : {}) }])
  }
})
