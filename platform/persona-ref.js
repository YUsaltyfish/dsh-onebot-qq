/**
 * platform/persona-ref.js — 人设/句池文件的跨平台投递（软链 → 复制降级）。
 *
 * 现网约定（Linux）：`qq-lines/` 里四根软链指向 `personas/<名字>.{md,lines.txt,wake.txt}`。
 * Windows 默认没有创建文件软链的权限（需开发者模式/管理员），所以：
 *   · 启动时探测一次 symlink 能力；
 *   · 能软链 → symlink 模式（改人设只换链接，最省事）；
 *   · 不能 → copy 模式（切人设时复制文件 + 更新 mtime，DSH 当 updated instructions 重读）；
 *   · 两种情况都写 `qq-lines/.persona.json` 指针，`activePersona()` 优先读指针/配置。
 *
 * 文件约定（都在配置的 workspaceDir 下）：
 *   qq-lines/AGENTS.local.md      ← 人设正文
 *   qq-lines/lines.txt            ← 人设句池
 *   qq-lines/lines.default.txt    ← 共享底池（默认 _default.lines.txt）
 *   qq-lines/wake.txt             ← 人设唤醒词
 *   qq-lines/.persona.json        ← { name, mode, files? }（copy 投递指纹）
 */
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { ensureDir, normForCompare } from './paths.js'
import { readJsonFile, writeJsonFileSync } from './atomic.js'

export const PERSONA_LINK_FILES = ['AGENTS.local.md', 'lines.txt', 'lines.default.txt', 'wake.txt']
export const PERSONA_BASE_NAME = '_default.lines.txt'

/** 探测目录是否允许创建文件软链（结果不缓存，调用方按需缓存）。 */
export function canSymlink(dir) {
  const d = ensureDir(dir)
  const probe = path.join(d, `.symlink-probe-${process.pid}-${Date.now()}`)
  const link = `${probe}.lnk`
  try {
    fs.writeFileSync(probe, 'x')
    fs.symlinkSync(probe, link, 'file')
    fs.unlinkSync(link)
    fs.unlinkSync(probe)
    return true
  } catch {
    try {
      fs.unlinkSync(link)
    } catch {
      /* ignore */
    }
    try {
      fs.unlinkSync(probe)
    } catch {
      /* ignore */
    }
    return false
  }
}

/** 人设库目录下的所有人设名（*.md，去掉 _模板/_template/README）。 */
export function listPersonas(personaDir) {
  const dir = String(personaDir || '')
  if (!dir || !fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((n) => n.toLowerCase().endsWith('.md'))
    .map((n) => n.slice(0, -3))
    .filter((n) => !/^(readme|_模板|_template)/i.test(n))
    .sort()
}

function firstExisting(candidates) {
  for (const p of candidates) {
    try {
      if (fs.statSync(p).isFile()) return p
    } catch {
      /* try next */
    }
  }
  return ''
}

/** 某套人设对应的源文件（缺文件时给出 ''）。 */
export function personaSources(personaDir, name) {
  const dir = String(personaDir || '')
  const base = path.join(dir, String(name))
  return {
    md: firstExisting([`${base}.md`]),
    lines: firstExisting([`${base}.lines.txt`]),
    wake: firstExisting([`${base}.wake.txt`]),
    baseLines: firstExisting([
      path.join(dir, PERSONA_BASE_NAME),
      path.join(dir, '_默认.lines.txt'),
    ]),
  }
}

export function readPersonaPointer(workspaceDir) {
  const file = path.join(String(workspaceDir || ''), '.persona.json')
  try {
    const v = readJsonFile(file)
    return v && typeof v === 'object' ? v : null
  } catch {
    return null
  }
}

/**
 * 当前生效的人设名，优先级：显式配置 → 指针文件 → 软链反推（Linux 迁移兼容）→ ''。
 * 注意：不读旧站点的私有路径，全部由调用方传入。
 */
export function activePersona({ configured = '', workspaceDir = '', personaDir = '' } = {}) {
  const fixed = String(configured || '').trim()
  if (fixed) return fixed
  const pointer = readPersonaPointer(workspaceDir)
  if (pointer && pointer.name) return String(pointer.name)
  // 软链反推（老部署迁移过来时仍然是软链）
  for (const [link, suffix] of [
    ['AGENTS.local.md', '.md'],
    ['lines.txt', '.lines.txt'],
    ['wake.txt', '.wake.txt'],
  ]) {
    try {
      const target = fs.realpathSync(path.join(String(workspaceDir), link))
      const base = path.basename(target)
      if (base.toLowerCase().endsWith(suffix.toLowerCase())) return base.slice(0, -suffix.length)
    } catch {
      /* 下一条 */
    }
  }
  return ''
}

function lstat(file) {
  try { return fs.lstatSync(file) } catch (e) {
    if (e.code === 'ENOENT') return null
    throw e
  }
}

const fingerprint = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex')

/** 旧 copy 指针没有指纹时，只认与旧来源仍一致的文件；不能证明归属就保留。 */
function managedFile(dest, stat, pointer, oldSources) {
  if (!stat) return false
  if (stat.isSymbolicLink()) {
    const target = normForCompare(path.resolve(path.dirname(dest), fs.readlinkSync(dest)))
    return oldSources.some((src) => target === normForCompare(path.resolve(src)))
  }
  if (!stat.isFile() || pointer?.mode !== 'copy') return false
  const hash = fingerprint(dest)
  if (pointer.files) return pointer.files[path.basename(dest)] === hash
  return oldSources.some((src) => {
    try { return hash === fingerprint(src) } catch (e) {
      if (e.code === 'ENOENT') return false
      throw e
    }
  })
}

/**
 * 切人设：完整计算投递集合，仅替换/撤销可证明归属的文件。
 * 立即投递四个文件和指针，保留精确备份直到调用方保存配置完成。
 * 调用方必须串行覆盖 begin 到 commit/rollback 的整个区间，不能交错同一工作区的事务。
 * commit/rollback 为同步、幂等终结操作；rollback 不重读人设源文件。
 * @returns {{result:object, commit:Function, rollback:Function}}
 */
export function beginPersonaSwitch({ workspaceDir, personaDir, name, mode = 'auto' } = {}) {
  const ws = ensureDir(workspaceDir)
  const persona = String(name || '').trim()
  if (!persona) throw new Error('人设名不能为空')
  const sources = personaSources(personaDir, persona)
  if (!sources.md) throw new Error(`人设不存在：${path.join(String(personaDir), `${persona}.md`)}`)
  if (!['auto', 'symlink', 'copy'].includes(mode)) throw new Error(`未知人设投递模式：${mode}`)
  const resolvedMode = mode === 'auto' ? (canSymlink(ws) ? 'symlink' : 'copy') : mode
  const pointerFile = path.join(ws, '.persona.json')
  const pointerStat = lstat(pointerFile)
  if (pointerStat && !pointerStat.isFile()) throw new Error('人设指针不是普通文件')
  const pointer = readPersonaPointer(ws)
  if (pointerStat && !pointer) throw new Error('人设指针无法读取，未修改投递文件')
  const previous = pointer?.name || activePersona({ workspaceDir: ws, personaDir })
  const oldBase = path.resolve(String(personaDir), String(previous || ''))
  const oldSources = [
    previous ? [`${oldBase}.md`] : [],
    previous ? [`${oldBase}.lines.txt`] : [],
    [path.resolve(String(personaDir), PERSONA_BASE_NAME), path.resolve(String(personaDir), '_默认.lines.txt')],
    previous ? [`${oldBase}.wake.txt`] : [],
  ]
  const plan = [sources.md, sources.lines, sources.baseLines, sources.wake].map((src, i) => {
    const destName = PERSONA_LINK_FILES[i]
    const dest = path.join(ws, destName)
    const stat = lstat(dest)
    const managed = managedFile(dest, stat, pointer, oldSources[i])
    // init 会先复制共享底池模板：内容完全相同的用户普通文件原样保留，不接管归属。
    const identical = src && stat?.isFile() && fingerprint(dest) === fingerprint(src)
    if (src && stat && !managed && !identical) throw new Error(`人设投递冲突，保留用户文件：${destName}`)
    return { destName, dest, src, stat, change: Boolean(src ? !stat || managed : managed) }
  })
  const changed = plan.filter((item) => item.change).map((item) => item.destName)
  const missing = plan.filter((item) => !item.src).map((item) => item.destName)
  // 同目录暂存以保持 rename 跨平台/同文件系统语义；备份保存原 inode、权限及链接文字。
  const staging = fs.mkdtempSync(path.join(ws, '.persona-'))
  const operations = []
  let settled = false
  const cleanup = () => {
    // 清理残留不能把已提交的成功反报为失败，也不能遮住原始错误。
    try {
      for (const entry of fs.readdirSync(staging)) fs.unlinkSync(path.join(staging, entry))
      fs.rmdirSync(staging)
    } catch { /* Windows 文件占用等清理失败时保留暂存目录 */ }
  }
  const rollback = () => {
    if (settled) return
    settled = true
    const failures = []
    for (const operation of [...operations].reverse()) {
      try {
        if (operation.installed) fs.unlinkSync(operation.dest)
        if (operation.backedUp) fs.renameSync(operation.backup, operation.dest)
      } catch (e) { failures.push(e) }
    }
    if (failures.length) throw new AggregateError(failures, `人设回滚失败，原文件备份保留于：${staging}`)
    cleanup()
  }
  const commit = () => {
    if (settled) return
    settled = true
    cleanup()
  }
  try {
    const files = {}
    for (const item of plan) {
      if (!item.change) continue
      item.staged = path.join(staging, item.destName)
      if (item.src) {
        if (resolvedMode === 'symlink') {
          // 链接最终位于 ws，而不是暂存子目录。
          fs.symlinkSync(path.relative(ws, path.resolve(item.src)), item.staged, 'file')
        } else {
          fs.copyFileSync(item.src, item.staged)
          files[item.destName] = fingerprint(item.staged)
        }
      }
    }
    const stagedPointer = path.join(staging, '.persona.json')
    writeJsonFileSync(stagedPointer, { name: persona, mode: resolvedMode, files, updatedAt: Date.now() })
    for (const item of [
      ...plan.filter((entry) => entry.change),
      { destName: '.persona.json', dest: pointerFile, stat: pointerStat, src: stagedPointer, staged: stagedPointer },
    ]) {
      const operation = { ...item, backup: path.join(staging, `${item.destName}.bak`), backedUp: false, installed: false }
      operations.push(operation)
      if (item.stat) {
        fs.renameSync(item.dest, operation.backup)
        operation.backedUp = true
      }
      if (item.src) {
        fs.renameSync(item.staged, item.dest)
        operation.installed = true
      }
    }
  } catch (error) {
    try { rollback() } catch (rollbackError) {
      throw new AggregateError([error, ...rollbackError.errors], rollbackError.message)
    }
    throw error
  }
  return { result: { ok: true, name: persona, mode: resolvedMode, changed, missing }, commit, rollback }
}

/** 独立切换的同步兼容入口；跨配置事务使用 beginPersonaSwitch 保留回滚备份。 */
export function switchPersona(options = {}) {
  const transaction = beginPersonaSwitch(options)
  transaction.commit()
  return transaction.result
}
