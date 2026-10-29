/** Stateless bounded media reads shared by inbound files and sticker collection. */
import fs from 'node:fs'

function limitError(maxBytes) {
  const error = new Error(`文件超过上限 ${maxBytes} 字节，未接收`)
  error.code = 'MEDIA_TOO_LARGE'
  return error
}

export async function readLocalBytes(file, { maxBytes = 0 } = {}) {
  const handle = await fs.promises.open(file, 'r')
  try {
    const stat = await handle.stat()
    if (!stat.isFile()) throw new Error('不是文件')
    if (maxBytes > 0 && stat.size > maxBytes) throw limitError(maxBytes)
    const chunks = []
    let size = 0
    for (;;) {
      // Read at most one excess byte, including when a file grows after stat.
      const chunk = Buffer.allocUnsafe(maxBytes > 0 ? Math.min(65536, maxBytes - size + 1) : 65536)
      const { bytesRead } = await handle.read(chunk)
      if (!bytesRead) break
      size += bytesRead
      if (maxBytes > 0 && size > maxBytes) throw limitError(maxBytes)
      chunks.push(chunk.subarray(0, bytesRead))
    }
    return Buffer.concat(chunks, size)
  } finally {
    await handle.close()
  }
}

export async function fetchBytes(url, { maxBytes = 0, timeoutMs = 15000 } = {}) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(new Error('下载超时')), timeoutMs)
  timer.unref?.()
  let reader
  try {
    const response = await fetch(url, { signal: controller.signal })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    if (response.body) reader = response.body.getReader()
    const declared = Number(response.headers?.get?.('content-length'))
    if (maxBytes > 0 && declared > maxBytes) throw limitError(maxBytes)
    if (!reader) return Buffer.alloc(0)
    const chunks = []
    let size = 0
    for (;;) {
      const { value, done } = await reader.read()
      if (done) break
      size += value.byteLength
      if (maxBytes > 0 && size > maxBytes) throw limitError(maxBytes)
      chunks.push(Buffer.from(value))
    }
    return Buffer.concat(chunks, size)
  } catch (error) {
    controller.abort(error)
    try { await reader?.cancel(error) } catch { /* abort may already close the body */ }
    throw error
  } finally {
    clearTimeout(timer)
    reader?.releaseLock()
  }
}
