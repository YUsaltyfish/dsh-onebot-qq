/**
 * test/fake-napcat.mjs — 最小 OneBot v11 假协议端（HTTP API + 正向 WS），只给测试用。
 *
 * 为什么自己写：包内**不能**依赖 `ws`（运行期无第三方依赖），而 Node 22 只有 WebSocket 客户端、
 * 没有服务端。这里手写约 100 行 WS 服务端（RFC 6455 握手 + 文本帧），够测试用：
 *   · WS：内核连上来后，测试用 `pushEvent()` 推入站事件；内核通过 WS 发的 API 会收到回包；
 *   · HTTP：接收 `send_group_msg` / `send_private_msg` 等，记录到 `sent[]` 供断言。
 *
 * 不实现：分片帧、压缩、TLS、鉴权校验（token 可发可不发，假服务端不校验）。
 */
import http from 'node:http'
import crypto from 'node:crypto'

const WS_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

/** 从缓冲区解析一帧（客户端→服务端必须带 mask，这里也兼容未 mask）。 */
function parseFrame(buf) {
  if (buf.length < 2) return null
  const opcode = buf[0] & 0x0f
  const masked = (buf[1] & 0x80) !== 0
  let len = buf[1] & 0x7f
  let offset = 2
  if (len === 126) {
    if (buf.length < 4) return null
    len = buf.readUInt16BE(2)
    offset = 4
  } else if (len === 127) {
    if (buf.length < 10) return null
    len = Number(buf.readBigUInt64BE(2))
    offset = 10
  }
  const maskOffset = offset
  if (masked) offset += 4
  if (buf.length < offset + len) return null
  let payload = Buffer.from(buf.subarray(offset, offset + len))
  if (masked) {
    const mask = buf.subarray(maskOffset, maskOffset + 4)
    for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4]
  }
  return { opcode, payload, totalLength: offset + len }
}

function encodeFrame(text) {
  const payload = Buffer.from(String(text), 'utf8')
  let header
  if (payload.length < 126) {
    header = Buffer.from([0x81, payload.length])
  } else if (payload.length < 65536) {
    header = Buffer.alloc(4)
    header[0] = 0x81
    header[1] = 126
    header.writeUInt16BE(payload.length, 2)
  } else {
    header = Buffer.alloc(10)
    header[0] = 0x81
    header[1] = 127
    header.writeBigUInt64BE(BigInt(payload.length), 2)
  }
  return Buffer.concat([header, payload])
}

function readBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    req.on('data', (c) => chunks.push(c))
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8')
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        resolve({})
      }
    })
    req.on('error', () => resolve({}))
  })
}

/**
 * @param {{selfId?:number, adminQq?:number, groupId?:number, groupName?:string}} opts
 */
export function createFakeNapCat(opts = {}) {
  const selfId = Number(opts.selfId ?? 999999)
  const adminQq = Number(opts.adminQq ?? 10001)
  const groupId = Number(opts.groupId ?? 20001)
  const groupName = String(opts.groupName ?? '测试群')
  const sent = [] // { action, params, at }
  const calls = [] // 所有收到的 action（含只读查询，供断言参数形状）
  const clients = new Set()
  let messageSeq = 10000
  // get_status 的可变返回值：测试用 setStatus({online, good}) 造"在线但接收链路停滞"等状态
  const status = { online: true, good: true }

  const ok = (data = {}) => ({ status: 'ok', retcode: 0, data })

  /** 每个 OneBot action 的假实现（HTTP 与 WS 共用）。 */
  function answer(action, params = {}) {
    calls.push({ action, params })
    switch (action) {
      case 'send_group_msg':
      case 'send_private_msg':
      case 'send_msg':
      case 'send_forward_msg': {
        const messageId = messageSeq++
        sent.push({ action, params, at: Date.now(), messageId })
        return ok({ message_id: messageId })
      }
      case 'get_login_info':
        return ok({ user_id: selfId, nickname: '测试机器人' })
      case 'get_status':
        return ok({ ...status })
      case 'get_group_list':
        return ok([{ group_id: groupId, group_name: groupName }])
      case 'get_friend_list':
        return ok([{ user_id: adminQq, nickname: '主人', remark: '' }])
      case 'get_group_member_list':
        return ok([
          { user_id: selfId, nickname: '测试机器人', card: '' },
          { user_id: adminQq, nickname: '主人', card: '群主' },
          { user_id: 10002, nickname: '路人', card: '' },
        ])
      case 'get_group_member_info':
        return ok({ user_id: Number(params.user_id) || adminQq, nickname: '主人', card: '群主' })
      case 'get_group_msg_history':
        return ok({ messages: [] })
      case 'get_msg':
        return ok({
          message_id: Number(params.message_id) || 0,
          user_id: adminQq,
          sender: { user_id: adminQq, nickname: '主人' },
          message: '被引用的原消息',
          time: Math.floor(Date.now() / 1000),
        })
      case 'get_file':
        return ok({ file: `/tmp/qqbot-fake-${Date.now()}.png`, file_name: 'fake.png', file_size: 3 })
      case 'delete_msg':
      case 'send_poke':
      case 'set_msg_emoji_like':
        return ok({})
      default:
        return ok({})
    }
  }

  const httpServer = http.createServer(async (req, res) => {
    const action = String(req.url || '/').replace(/^\/+/, '').split('?')[0]
    const params = await readBody(req)
    if (action === '' || action === 'health') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true }))
      return
    }
    const result = answer(action, params)
    res.writeHead(200, { 'content-type': 'application/json' })
    res.end(JSON.stringify(result))
  })

  const wsServer = http.createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  wsServer.on('upgrade', (req, socket) => {
    const key = req.headers['sec-websocket-key']
    const accept = crypto.createHash('sha1').update(String(key) + WS_GUID).digest('base64')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n'
      + 'Upgrade: websocket\r\n'
      + 'Connection: Upgrade\r\n'
      + `Sec-WebSocket-Accept: ${accept}\r\n\r\n`,
    )
    const client = {
      socket,
      send(obj) {
        try {
          socket.write(encodeFrame(JSON.stringify(obj)))
        } catch {
          /* 已断开 */
        }
      },
    }
    clients.add(client)
    let buf = Buffer.alloc(0)
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk])
      for (;;) {
        const frame = parseFrame(buf)
        if (!frame) break
        buf = buf.subarray(frame.totalLength)
        if (frame.opcode === 0x8) {
          clients.delete(client)
          socket.end()
          return
        }
        if (frame.opcode === 0x9) continue // ping：忽略（测试不需要 pong）
        if (frame.opcode !== 0x1) continue
        let data
        try {
          data = JSON.parse(frame.payload.toString('utf8'))
        } catch {
          continue
        }
        // WS API 请求：回包带 echo
        if (data.action) {
          const result = answer(data.action, data.params || {})
          client.send({ ...result, echo: data.echo })
        }
        // 其它（客户端不会发事件）忽略
      }
    })
    const drop = () => clients.delete(client)
    socket.on('close', drop)
    socket.on('error', drop)
  })

  return {
    selfId,
    adminQq,
    groupId,
    groupName,
    sent,
    calls,
    /** 改 get_status 返回值（默认 {online:true, good:true}）。 */
    setStatus(next = {}) {
      Object.assign(status, next)
    },
    /** 当前连上来的 WS 客户端数（判断"有没有发起连接"用） */
    get clientCount() {
      return clients.size
    },
    get url() {
      const httpPort = httpServer.address()?.port
      const wsPort = wsServer.address()?.port
      return { wsUrl: `ws://127.0.0.1:${wsPort}`, httpUrl: `http://127.0.0.1:${httpPort}`, wsPort, httpPort }
    },
    /** 启动 HTTP + WS（端口用 listen(0) 动态分配，绝不写死）。 */
    async start() {
      await Promise.all([
        new Promise((resolve) => httpServer.listen(0, '127.0.0.1', resolve)),
        new Promise((resolve) => wsServer.listen(0, '127.0.0.1', resolve)),
      ])
      return this.url
    },
    /** 等内核 WS 连上来（最多 timeoutMs）。 */
    async waitForClient(timeoutMs = 10000) {
      const started = Date.now()
      while (clients.size === 0) {
        if (Date.now() - started > timeoutMs) throw new Error('fake OneBot: 等待 WS 连接超时')
        await new Promise((r) => setTimeout(r, 20))
      }
      return clients.size
    },
    /** 向所有已连接客户端推送一个 OneBot 事件。 */
    pushEvent(event) {
      const payload = { time: Math.floor(Date.now() / 1000), self_id: selfId, ...event }
      for (const client of clients) client.send(payload)
      return clients.size
    },
    /** 造一个群消息事件。 */
    groupMessage({ userId = adminQq, messageId = 5001, text = '你好', nickname = '主人', atSelf = false, replyTo = null } = {}) {
      const message = []
      if (replyTo != null) message.push({ type: 'reply', data: { id: String(replyTo) } })
      if (atSelf) message.push({ type: 'at', data: { qq: String(selfId) } })
      message.push({ type: 'text', data: { text } })
      return {
        post_type: 'message',
        message_type: 'group',
        group_id: groupId,
        user_id: userId,
        message_id: messageId,
        sender: { user_id: userId, nickname, card: '' },
        message,
      }
    },
    /** 造一个私聊消息事件。 */
    privateMessage({ userId = adminQq, messageId = 6001, text = '你好', nickname = '主人' } = {}) {
      return {
        post_type: 'message',
        message_type: 'private',
        user_id: userId,
        message_id: messageId,
        sender: { user_id: userId, nickname },
        message: [{ type: 'text', data: { text } }],
      }
    },
    async close() {
      for (const client of clients) {
        try {
          client.socket.destroy()
        } catch {
          /* ignore */
        }
      }
      clients.clear()
      await Promise.all([
        new Promise((resolve) => httpServer.close(resolve)),
        new Promise((resolve) => wsServer.close(resolve)),
      ])
    },
  }
}
