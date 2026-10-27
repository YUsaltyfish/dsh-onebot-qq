/**
 * platform/cq-file.js — OneBot/协议端的 CQ 码与本地文件引用（唯一实现）。
 *
 * 背景：
 *   · CQ 码参数用逗号分隔，路径里出现裸逗号会把整条消息拆坏；
 *     参数值要求转义 `&` `[` `]` `,`（`&amp;` `&#91;` `&#93;` `&#44;`）。
 *   · **普通文本**（正文/caption）只转义 `&` `[` `]`：逗号在文本里是普通字符，
 *     若也转义成 `&#44;` 且协议端不对文本段做实体还原，聊天里就会显示 `&#44;`。
 *   · Windows 本地路径含反斜杠，不同 OneBot 实现对 `file=` 形式接受度不同；
 *     统一由 `toNapCatFileRef()` 转换，真机验证后用 `DSH_QQ_MEDIA_REF` 切模式。
 *
 * 本文件是 `escapeCq` 的**唯一实现**（kernel/format.js 从这里再导出）。
 */
import path from 'node:path'
import { pathToFileURL, fileURLToPath } from 'node:url'
import { isWin } from './paths.js'

/** 普通文本转义：`&` `[` `]`（逗号保持原样）。 */
export function escapeCqText(input) {
  return String(input ?? '')
    .replace(/&/g, '&amp;')
    .replace(/\[/g, '&#91;')
    .replace(/\]/g, '&#93;')
}

/** CQ 参数值转义：`&` `[` `]` `,`（逗号必须转，否则参数会被拆坏）。 */
export function escapeCqParam(input) {
  return escapeCqText(input).replace(/,/g, '&#44;')
}

/** 向后兼容别名：文本语义（历史调用点都是正文/说明文字）。 */
export const escapeCq = escapeCqText

/** 媒体 file 引用模式：`fwd`（正斜杠绝对路径，默认）| `fileUri`（file:// URL）。 */
export function mediaRefMode(env = process.env) {
  const v = String(env.DSH_QQ_MEDIA_REF || '').trim()
  return v === 'fileUri' ? 'fileUri' : 'fwd'
}

/**
 * 本地绝对路径 → OneBot `file=` 参数值。
 * - 一律绝对化；
 * - Windows 反斜杠 → 正斜杠（默认模式，行为与 Linux 直传路径最接近）；
 * - `fileUri` 模式用 `pathToFileURL()`（唯一正确构造 file URL 的方式）。
 * 注意：调用方负责先做白名单校验，本函数不校验来源。
 */
export function toNapCatFileRef(file, opts = {}) {
  const abs = path.resolve(String(file))
  const mode = opts.mode || mediaRefMode()
  if (mode === 'fileUri') return pathToFileURL(abs).href
  return isWin ? abs.replace(/\\/g, '/') : abs
}

/** OneBot `file=` 参数值 → 本地路径（入站用；支持 file:// URL、普通路径）。 */
export function fromNapCatFileRef(ref) {
  const s = String(ref ?? '').trim()
  if (!s) return ''
  if (/^file:\/\//i.test(s)) {
    try {
      return fileURLToPath(s)
    } catch {
      return s
    }
  }
  return s
}

/** `[CQ:<kind>,file=<escaped>]`。 */
export function cqMedia(kind, file, opts = {}) {
  return `[CQ:${kind},file=${escapeCqParam(toNapCatFileRef(file, opts))}]`
}

export function cqImage(file, opts = {}) {
  return cqMedia('image', file, opts)
}

export function cqVideo(file, opts = {}) {
  return cqMedia('video', file, opts)
}
