/**
 * platform/sharp.js — 借用 DSH 自带 sharp 做图片缩放/压缩（入站长图、群上文小图）。
 *
 * 为什么不用插件依赖：DSH 安装目录里本来就带一份 sharp（`<dsh 包>/node_modules/sharp`），
 * 插件再装一份既翻体积又容易版本打架。这里按「运行中的 dsh 入口 → realpath → 逐级往上找
 * node_modules/sharp」发现；找不到就返回 null，调用方原样返回原图（降级，不阻塞聊天）。
 *
 * 注意 `process.argv[1]` 可能是软链（如 `/usr/bin/dsh -> <dsh 安装目录>/node_modules/@deepseek-ai/dsh/lib/bin.js`），
 * 必须先 realpath，否则按 argv[1] 的目录找不到 sharp。
 */
import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

/**
 * sharp 候选路径（纯函数，自检用；不读网络、不加载模块）。
 * @param {{argv1?:string, env?:object}} [opts]
 * @returns {string[]} 依次尝试的 require 目标（包名或绝对路径）
 */
export function sharpCandidatePaths({ argv1 = process.argv[1], env = process.env } = {}) {
  const out = []
  const configured = String(env?.DSH_QQ_SHARP || '').trim()
  if (configured) out.push(configured)   // 显式指定优先（自定义安装位置 / 排障）
  out.push('sharp')                       // 插件自己带的或宿主能解析到的
  if (argv1) {
    let real = String(argv1)
    try { real = fs.realpathSync(real) } catch { /* 路径不存在就按原样试 */ }
    let dir = path.dirname(path.resolve(real))
    for (let i = 0; i < 8; i += 1) {
      out.push(path.join(dir, 'node_modules', 'sharp'))
      const parent = path.dirname(dir)
      if (parent === dir) break
      dir = parent
    }
  }
  return [...new Set(out)]
}

let cached

/** 加载 sharp；找不到返回 null。不传 opts 时按进程环境探测一次并缓存。 */
export function loadSharp(opts) {
  const probe = opts !== undefined
  if (!probe && cached !== undefined) return cached
  let sharp = null
  for (const cand of sharpCandidatePaths(opts || {})) {
    try { sharp = require(cand); break } catch { /* 试下一个 */ }
  }
  if (!probe) cached = sharp
  return sharp
}
