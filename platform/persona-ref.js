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
 *   qq-lines/.persona.json        ← { name, mode }
 */
import fs from 'node:fs'
import path from 'node:path'
import { ensureDir } from './paths.js'
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

function writePointer(workspaceDir, name, mode) {
  ensureDir(workspaceDir)
  writeJsonFileSync(path.join(workspaceDir, '.persona.json'), { name, mode, updatedAt: Date.now() })
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

function writeModeFile(dest, src, mode) {
  try {
    fs.lstatSync(dest)
    fs.unlinkSync(dest)
  } catch {
    /* 不存在 */
  }
  if (mode === 'symlink') {
    fs.symlinkSync(path.relative(path.dirname(dest), src), dest, 'file')
    return
  }
  fs.copyFileSync(src, dest)
}

/**
 * 切人设：写 4 个投递文件 + 指针。
 * @returns {{ok:boolean, name:string, mode:'symlink'|'copy', changed:string[], missing:string[]}}
 */
export function switchPersona({ workspaceDir, personaDir, name, mode = 'auto' } = {}) {
  const ws = ensureDir(workspaceDir)
  const persona = String(name || '').trim()
  if (!persona) throw new Error('人设名不能为空')
  const sources = personaSources(personaDir, persona)
  if (!sources.md) throw new Error(`人设不存在：${path.join(String(personaDir), `${persona}.md`)}`)
  let resolvedMode = mode
  if (mode === 'auto') resolvedMode = canSymlink(ws) ? 'symlink' : 'copy'
  const plan = [
    ['AGENTS.local.md', sources.md],
    ['lines.txt', sources.lines],
    ['lines.default.txt', sources.baseLines],
    ['wake.txt', sources.wake],
  ]
  const changed = []
  const missing = []
  for (const [destName, src] of plan) {
    if (!src) {
      missing.push(destName)
      continue
    }
    writeModeFile(path.join(ws, destName), src, resolvedMode)
    changed.push(destName)
  }
  writePointer(ws, persona, resolvedMode)
  return { ok: true, name: persona, mode: resolvedMode, changed, missing }
}
