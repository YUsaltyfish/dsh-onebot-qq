/**
 * test/platform.test.js — platform/ 适配层单测（Linux / Windows 通用）。
 * 跑法：node --test（包根自动发现）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  isWin,
  resolveDshHome,
  resolveDataDir,
  resolveTmpDir,
  isFullAbsolute,
  resolveDataPath,
  isInsidePath,
} from '../platform/paths.js'
import {
  escapeCq,
  escapeCqParam,
  fromOneBotFileRef,
  toOneBotFileRef,
} from '../platform/cq-file.js'
import {
  readJsonFile,
  atomicWriteFileSync,
  writeJsonFileSync,
  stripBom,
} from '../platform/atomic.js'
import {
  canSymlink,
  activePersona,
  personaSources,
  listPersonas,
  switchPersona,
} from '../platform/persona-ref.js'

const tmpRoot = () => fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-platform-'))
const write = (file, text) => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, text)
}

test('paths: DSH_HOME / dataDir / tmpDir 解析', () => {
  // 用「当前盘根 + 子目录」构造绝对路径：POSIX 是 /…，Windows 是 <盘符>:\…，两种平台都成立。
  const fakeDshHome = path.join(path.parse(process.cwd()).root, 'tmp', 'dsh-home-test')
  assert.equal(resolveDshHome({ DSH_HOME: fakeDshHome }), path.resolve(fakeDshHome))
  const fakeHome = path.join(path.parse(process.cwd()).root, 'home', 'tester')
  assert.equal(resolveDshHome({}, fakeHome), path.join(fakeHome, '.dsh'))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qqbot-data-'))
  assert.equal(resolveDataDir(dir, {}), path.resolve(dir))
  const withHomeDir = resolveDataDir('', { DSH_HOME: dir })
  assert.equal(withHomeDir, path.join(path.resolve(dir), 'dsh-onebot-qq'))
  assert.ok(fs.existsSync(withHomeDir))

  const tmp = resolveTmpDir('incoming', 'x')
  assert.ok(tmp.startsWith(os.tmpdir()))
  assert.ok(fs.existsSync(tmp))
})

test('paths: 相对/绝对/盘符判定与解析', () => {
  // 同样按平台构造绝对路径，避免 POSIX 字面路径在 Windows 上被当成「盘符相对路径」。
  const root = path.parse(process.cwd()).root
  const dataDir = path.join(root, 'data')
  const absFile = path.join(root, 'abs', 'x')
  assert.equal(isFullAbsolute(absFile), true)
  assert.equal(isFullAbsolute('rel/dir'), false)
  // POSIX 的 `/a/b` 才是完整绝对路径；Windows 的 `\a\b` 依赖当前盘，不算。
  assert.equal(isFullAbsolute('/a/b'), !isWin)
  if (isWin) assert.equal(isFullAbsolute('\\abs\\x'), false)
  assert.equal(resolveDataPath('state/sessions.json', dataDir), path.join(dataDir, 'state', 'sessions.json'))
  assert.equal(resolveDataPath(absFile, dataDir), path.normalize(absFile))
  assert.equal(resolveDataPath('', dataDir), '')
})

test('paths: isInsidePath 拒绝越界/接受内部（跨平台）', () => {
  const root = tmpRoot()
  fs.mkdirSync(path.join(root, 'inside'), { recursive: true })
  assert.equal(isInsidePath(root, root), true)
  assert.equal(isInsidePath(root, path.join(root, 'inside')), true)
  assert.equal(isInsidePath(root, path.join(root, '..')), false)
  if (!isWin) {
    write(path.join(root, 'inside', 'a.png'), 'x')
    assert.equal(isInsidePath(path.join(root, 'inside'), path.join(root, 'inside', 'a.png')), true)
    assert.equal(isInsidePath(path.join(root, 'inside'), '/etc/passwd'), false)
  }
})

test('cq: 文本只转义 & [ ]（逗号保持原样）；参数值额外转义逗号', () => {
  assert.equal(escapeCq('a,b&c[d]e'), 'a,b&amp;c&#91;d&#93;e')
  assert.equal(escapeCqParam('a,b&c[d]e'), 'a&#44;b&amp;c&#91;d&#93;e')
})

test('cq: toOneBotFileRef / fromOneBotFileRef 往返', () => {
  const file = path.join(tmpRoot(), '图 0,1.png')
  const fwd = toOneBotFileRef(file, { mode: 'fwd' })
  if (isWin) assert.ok(!fwd.includes('\\'), 'Windows 默认模式应转正斜杠')
  const uri = toOneBotFileRef(file, { mode: 'fileUri' })
  assert.ok(uri.startsWith('file://'))
  assert.equal(fromOneBotFileRef(uri), path.resolve(file))
  assert.equal(fromOneBotFileRef(file), file)
})

test('atomic: BOM 剥离 / JSON 原子写读', () => {
  const dir = tmpRoot()
  const file = path.join(dir, 'config.json')
  fs.writeFileSync(file, '\uFEFF{"a":1}', 'utf8')
  assert.deepEqual(readJsonFile(file), { a: 1 })
  assert.equal(stripBom('\uFEFFhello'), 'hello')

  const out = path.join(dir, 'nested', 'data.json')
  writeJsonFileSync(out, { x: '中文', y: [1, 2] })
  assert.deepEqual(readJsonFile(out), { x: '中文', y: [1, 2] })
  atomicWriteFileSync(out, '{"z":true}')
  assert.deepEqual(readJsonFile(out), { z: true })
  const leftovers = fs.readdirSync(path.dirname(out)).filter((n) => n.includes('.tmp-'))
  assert.deepEqual(leftovers, [], '不应残留 tmp 文件')
})

test('persona: 列表 / 切换（symlink 不可用自动 copy）', () => {
  const dir = tmpRoot()
  const personaDir = path.join(dir, 'personas')
  const ws = path.join(dir, 'qq-lines')
  write(path.join(personaDir, '_default.lines.txt'), '## default\n底池\n')
  write(path.join(personaDir, '测试人设.md'), '# persona\n')
  write(path.join(personaDir, '测试人设.lines.txt'), '## poke\n戳\n')
  write(path.join(personaDir, '测试人设.wake.txt'), '唤醒词\n')

  assert.deepEqual(listPersonas(personaDir), ['测试人设'])
  assert.equal(personaSources(personaDir, '测试人设').md, path.join(personaDir, '测试人设.md'))
  assert.equal(personaSources(personaDir, '不存在').md, '')

  const mode = canSymlink(ws) ? 'symlink' : 'copy'
  const r = switchPersona({ workspaceDir: ws, personaDir, name: '测试人设', mode })
  assert.equal(r.ok, true)
  assert.equal(r.mode, mode)
  assert.ok(fs.existsSync(path.join(ws, 'AGENTS.local.md')))
  assert.ok(fs.existsSync(path.join(ws, 'lines.txt')))
  assert.ok(fs.existsSync(path.join(ws, 'wake.txt')))
  assert.equal(activePersona({ workspaceDir: ws }), '测试人设')
  // copy 模式下重新切换要能覆盖已有文件
  const r2 = switchPersona({ workspaceDir: ws, personaDir, name: '测试人设', mode: 'copy' })
  assert.equal(r2.mode, 'copy')
  assert.equal(activePersona({ workspaceDir: ws }), '测试人设')
  assert.equal(activePersona({ configured: '显式人设', workspaceDir: ws }), '显式人设')
})
