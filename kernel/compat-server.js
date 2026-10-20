/**
 * kernel/compat-server.js — 回环兼容网关（**默认不启动**，只给本机宿主机脚本用）。
 *
 * 背景：站点上可能有一批跟他绑定的旧脚本（探活/告警/群记忆工具/群卡片），它们请求
 * `http://127.0.0.1:<port>` 的 `/health`、`/send`、`/admin/*`。切流停掉旧进程后，这层把同样的
 * 端点重新挂出来 —— **脚本一行不改就能继续工作**。通用安装默认 `compatServer:false`，不监听端口。
 *
 * 三条纪律：
 *  1. **只绑 127.0.0.1**（loopback 安全边界）：这些端点能发消息、能改配置，绝不能暴露到公网。
 *  2. **端口占用必须优雅降级**：端口很可能已被旧进程占着（并跑模式）。EADDRINUSE 只记一条
 *     info，绝不 throw —— 兼容层起不来是小事，内核崩了是大事。
 *  3. 出站一律走 `kernel.deliver` / `kernel.sendMedia`（脱敏 / 长度 / 留档唯一实现），
 *     这里**不做**第二份脱敏、也不裸调 NapCat。
 *
 * 平台边界：图片白名单根由宿主传入（实例配置 `compat.imageRoots` + 临时目录），
 * 判定只走 `platform/paths.js` 的 `isInsidePath()`；媒体码只走 `platform/cq-file.js`。
 */

import http from 'node:http'
import fs from 'node:fs'
import { isInsidePath } from '../platform/paths.js'
import { cqImage } from '../platform/cq-file.js'

/** 读 JSON 请求体（带长度上限：这层是本机脚本用的，不接大文件） */
function readBody(req, limit = 65536) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > limit) { reject(new Error('请求体过大')); req.destroy() }
    })
    req.on('end', () => {
      try { resolve(data ? JSON.parse(data) : {}) } catch { reject(new Error('请求体不是合法 JSON')) }
    })
    req.on('error', reject)
  })
}

/**
 * @param {{host?: string, port?: number, kernel: object, log?: object, imageRoots?: string[]}} opts
 *   kernel 需要：`deliver / sendMedia / napcat / dsh / state / plugins / handleAdminRpc`
 *   imageRoots：允许 `/send-image` 读取的目录根（绝对路径，宿主按平台层解析）
 * @returns {{close(): void}}
 */
export function startCompatServer({ host = '127.0.0.1', port = 3971, kernel, log = console, imageRoots = [] }) {
  const imgRoots = (Array.isArray(imageRoots) ? imageRoots : []).map((r) => String(r || '').trim()).filter(Boolean)

  /** 校验本地图片路径：必须在白名单目录下的真实文件（软链先 realpath，穿不出去） */
  function resolveCompatImage(raw) {
    const p = String(raw || '').trim()
    if (!p) throw new Error('file 不能为空（服务器上的本地图片绝对路径）')
    if (!fs.existsSync(p)) throw new Error(`图片文件不存在: ${p}`)
    const real = fs.realpathSync(p)
    if (!fs.statSync(real).isFile()) throw new Error(`不是文件: ${p}`)
    if (!imgRoots.length) throw new Error('未配置兼容网关图片白名单（实例配置 compat.imageRoots）')
    if (!imgRoots.some((root) => isInsidePath(root, real))) {
      throw new Error(`禁止发送白名单目录外的图片: ${real}`)
    }
    return real
  }

  // 与 gate-wake 共享同一份运行时屏蔽集合（gate-wake 未启用时兜底挂一份 Set）
  const getRuntimeIgnore = () => {
    if (kernel.state?.runtimeIgnore) return kernel.state.runtimeIgnore
    if (!kernel._fallbackRuntimeIgnore) kernel._fallbackRuntimeIgnore = new Set()
    return kernel._fallbackRuntimeIgnore
  }

  /** 静态屏蔽群（gate-wake 配置里的 ignoreGroups）：/ignore/list 里跟 runtime 分开展示 */
  const staticIgnore = () =>
    (kernel.plugins?.find((p) => p?.id === 'gate-wake')?.cfg?.ignoreGroups || []).map(Number)

  const health = () => {
    const nh = kernel.napcat?.health?.() ?? {}
    return {
      ok: true,
      dshLinked: Boolean(kernel.dsh?.health?.()?.linked ?? true),
      napcatLinked: Boolean(nh.linked),
      napcatLastFrameAgoMs: nh.lastFrameAgoMs,
      napcatStale: nh.stale,
      follows: kernel.dsh?.sessions?.size ?? 0,
      remoteEventsReady: true,
      sessions: kernel.dsh?.sessions?.size ?? 0,
      lastEventAt: Date.now(),
    }
  }

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8' })
      res.end(JSON.stringify(obj))
    }
    try {
      const u = new URL(req.url, 'http://x')
      const p = u.pathname
      const isGet = req.method === 'GET'
      const isPost = req.method === 'POST'

      if (isGet && p === '/health') return send(200, health())

      if (isPost && p === '/send') {
        const b = await readBody(req)
        const r = await kernel.deliver(b.target, b.text, { replyTo: b.reply_to, ats: b.at_qq })
        return send(200, { ok: true, target: r.target, message_id: r.messageId, mode: r.mode, redacted: r.hits })
      }

      if (isPost && p === '/send-image') {
        const b = await readBody(req)
        const real = resolveCompatImage(b.file)
        const r = await kernel.sendMedia(String(b.target || ''), cqImage(real), b.text || '')
        return send(200, { ok: true, target: r.target, message_id: r.messageId })
      }

      if (isPost && p === '/recall') {
        const b = await readBody(req)
        const id = Number(b.message_id)
        if (!Number.isInteger(id) || id <= 0) throw new Error('message_id 无效')
        const r = await kernel.napcat.recall(id)
        if (!r.ok) throw new Error(r.msg || '撤回失败')
        return send(200, { ok: true, recalled: id })
      }

      // ── 运行时屏蔽群（GET/POST 都收：老脚本混用两种姿势） ──
      if ((isGet || isPost) && /^\/ignore\/(add|remove|list)$/.test(p)) {
        const op = p.slice('/ignore/'.length)
        const body = isPost ? await readBody(req) : {}
        const rt = getRuntimeIgnore()
        const listRt = () => (typeof rt.list === 'function' ? rt.list().map(Number) : [...rt].map(Number))
        if (op === 'list') return send(200, { ok: true, static: staticIgnore(), runtime: listRt() })
        const gid = Number(u.searchParams.get('group_id') ?? body.group_id)
        if (!Number.isInteger(gid) || gid <= 0) throw new Error('group_id 无效')
        if (op === 'add') rt.add(gid)
        else if (typeof rt.remove === 'function') rt.remove(gid)
        else rt.delete?.(gid)
        log.info(`compat-server: 运行时${op === 'add' ? '屏蔽' : '解除屏蔽'}群 ${gid}`)
        return send(200, { ok: true, op, group_id: gid, runtime: listRt() })
      }

      // ── 控制台：转发给内核的 admin RPC（8 端点）──
      if (p === '/admin/schema' && isGet) return send(200, await kernel.handleAdminRpc('schema', {}))
      if (p === '/admin/status' && isGet) return send(200, await kernel.handleAdminRpc('status', {}))
      if (isPost && /^\/admin\/(set|module|group|action|memory|persona)$/.test(p)) {
        const ep = p.slice('/admin/'.length)
        const out = await kernel.handleAdminRpc(ep, await readBody(req))
        if (!out) throw new Error(`未实现的管理端点: ${ep}`)
        return send(200, out)
      }

      return send(404, { ok: false, error: `未知端点: ${req.method} ${p}` })
    } catch (e) {
      // 业务错（target 格式 / 超长 / NapCat 失败）按旧口径回 400 + 可读原因，脚本照旧判 ok
      send(400, { ok: false, error: String(e?.message || e) })
    }
  })

  server.on('error', (e) => {
    // 并跑模式：旧进程还占着端口 → 跳过监听，让宿主机脚本继续找旧服务；内核不受影响。
    if (e?.code === 'EADDRINUSE') log.info(`compat-server: 端口 ${port} 已被旧服务占用，跳过监听（并跑模式）`)
    else log.warn(`compat-server: 监听失败（忽略，不影响内核）: ${e.message}`)
  })
  server.listen(port, host, () => log.info(`compat-server: 已监听 http://${host}:${port}（只对本机脚本开放）`))

  return {
    close() {
      // listen 可能还在挂起（或 EADDRINUSE 迟到成功）：不能只看 server.listening，
      // 否则监听迟到生效会占住端口、拖住测试/重载进程退出。
      const shutdown = () => {
        try {
          server.close()
          server.closeAllConnections?.()
        } catch {
          /* 已关 */
        }
      }
      try {
        if (server.listening) shutdown()
        else server.once('listening', shutdown)
        server.on('error', shutdown) // 迟到的 EADDRINUSE 不应留下 half-open 状态
      } catch {
        /* 已关 */
      }
    },
  }
}
