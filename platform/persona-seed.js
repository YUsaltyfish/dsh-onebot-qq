/**
 * platform/persona-seed.js — 「安装即用」的默认人设投递（内核启动与 CLI init 共用）。
 *
 * 随包提供一个极简默认人设（`examples/personas/蓝色大肥鱼.*`）和人设模板（`_模板.md`）：
 *   · 人设库（personas/）里没有投递过、配置里也没指定人设 → 复制三件套 + 底池 + 模板，投递到 QQ 线工作区；
 *   · 已经投递过 / 已经配置了人设（含用户自己写的）→ 直接跳过，**绝不覆盖用户文件**。
 * 这件事不依赖控制台按钮，首次启动就完成；想换人设按安装说明写文件即可。
 */
import fs from 'node:fs'
import path from 'node:path'

import { ensureDir } from './paths.js'
import { activePersona, switchPersona } from './persona-ref.js'

/** 随包默认人设名（examples/personas/ 下有同名 .md / .lines.txt / .wake.txt） */
export const DEFAULT_PERSONA_NAME = '蓝色大肥鱼'

/**
 * 首次安装投递默认人设（幂等）。
 * @param {{dataDir:string, personaDir?:string, workspaceDir?:string, examplesDir:string,
 *   name?:string, configured?:string}} opts
 *   configured = 实例配置里已指定的 activePersona（非空 = 用户已经选过人设，直接跳过）
 * @returns {{skipped?:boolean, ok?:boolean, name?:string, copied?:number, mode?:string, changed?:string[], missing?:string[], error?:string}}
 */
export function ensureDefaultPersona({
  dataDir, personaDir, workspaceDir, examplesDir, name = DEFAULT_PERSONA_NAME, configured = '',
} = {}) {
  const personaRoot = personaDir || path.join(dataDir, 'personas')
  const workspaceRoot = workspaceDir || path.join(dataDir, 'workspace')

  const configuredName = String(configured || '').trim()
  const delivered = ['AGENTS.local.md', 'lines.txt', 'wake.txt']
    .filter((f) => fs.existsSync(path.join(workspaceRoot, f))).length
  if (configuredName || fs.existsSync(path.join(workspaceRoot, '.persona.json')) || delivered === 3) {
    let active = configuredName
    try { active = active || activePersona({ workspaceDir: workspaceRoot, personaDir: personaRoot }) } catch { /* 解析失败就给空 */ }
    return { skipped: true, name: active || name }
  }

  // 复制内置人设三件套 + 底池（已有同名文件不覆盖）
  let copied = 0
  ensureDir(personaRoot)
  for (const suffix of ['.md', '.lines.txt', '.wake.txt']) {
    const src = path.join(examplesDir, `${name}${suffix}`)
    const dst = path.join(personaRoot, `${name}${suffix}`)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.copyFileSync(src, dst)
    copied += 1
  }
  // 人设模板也放一份进人设库，方便用户（或让 AI 照着模板）写自己的
  for (const extra of ['_模板.md', '_template.md', '_default.lines.txt', '_默认.lines.txt']) {
    const src = path.join(examplesDir, extra)
    const dst = path.join(personaRoot, extra)
    if (!fs.existsSync(src) || fs.existsSync(dst)) continue
    fs.copyFileSync(src, dst)
    copied += 1
  }
  if (!fs.existsSync(path.join(personaRoot, `${name}.md`))) {
    return { ok: false, error: `内置默认人设缺失：${path.join(examplesDir, `${name}.md`)}（安装包不完整？）` }
  }

  let switched
  try {
    switched = switchPersona({ workspaceDir: workspaceRoot, personaDir: personaRoot, name, mode: 'auto' })
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
  return { ok: true, name, copied, mode: switched.mode, changed: switched.changed, missing: switched.missing }
}
