/**
 * 回归：表情包自动打标要真的跑得起来。
 *
 * 线上踩到的两件事（本文件各自锁一条）：
 *   ① **空闲判据不能看群消息量**。早期实现统计"最近窗口内群里几条消息"，
 *      活跃群永远 ≥ 阈值 → 打标一次都触发不了（实测 79 张、零打标）。
 *      正确语义：看**机器人自己**忙不忙 —— 群里一直有人聊，只要没叫它，就该打标。
 *   ② **只靠收图/掷骰触发不够**。那两个入口恰好是"群里有动静"的时刻；
 *      等群真安静下来，就再没人叫它，攒的图永远没标签。所以要有定时轮询。
 *
 * 用 `QQ_STICKER_VENDOR` 注入假 core（test/fake-sticker-shelf.mjs），
 * 不碰真实文件、不调模型，只验证判定与节流。
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
process.env.QQ_STICKER_VENDOR = path.join(HERE, 'fake-sticker-shelf.mjs')

// 必须在设置环境变量之后导入（插件在模块顶层读 VENDOR）
const { default: stickers } = await import('../plugins/stickers/index.js')

/** 把插件的 setup 跑起来，定时器换成可手动触发的桩。 */
function harness(overrides = {}) {
  const timers = []
  const stageFns = new Map()
  const tools = new Map()
  const logs = []

  const bot = {
    id: 'stickers',
    // 宿主会按 configSchema 把默认值填进 bot.cfg；测试台要自己补（tagging 默认 true）
    cfg: { dir: 'sticker-test-dir', tagging: true, ...(overrides.cfg ?? {}) },
    contractVersion: 1,
    log: {
      info: (m) => logs.push(['I', m]), warn: (m) => logs.push(['W', m]),
      error: (m) => logs.push(['E', m]), debug: (m) => logs.push(['D', m]),
    },
    on: (s, fn) => { if (!stageFns.has(s)) stageFns.set(s, []); stageFns.get(s).push(fn) },
    registerTool: (n, d) => tools.set(n, d),
    registerCommand: () => {},
    deliver: async () => {},
    onOutbound: () => {},
    state: { get: () => ({ _scratch: {} }) },
    napcat: { selfId: 1, getFile: async () => null },
    core: { dataDir: 'sticker-test-data' },
    dsh: {}, pacing: {}, shared: {}, credentials: {},
    describeImage: 'describeImage' in overrides
      ? overrides.describeImage
      : async () => '看：测试\n用：测试\n词：测试',
  }

  globalThis.__stickerShelfCalls = { tagPending: 0, remove: 0, resolve: 0 }
  globalThis.__stickerShelfTagCount = overrides.tagCount ?? 1

  const realSetInterval = globalThis.setInterval
  const realSetTimeout = globalThis.setTimeout
  globalThis.setInterval = (fn, ms) => { timers.push({ fn, ms, kind: 'interval' }); return { unref() {} } }
  globalThis.setTimeout = (fn, ms) => { timers.push({ fn, ms, kind: 'timeout' }); return { unref() {} } }
  try {
    stickers.setup(bot)
  } finally {
    globalThis.setInterval = realSetInterval
    globalThis.setTimeout = realSetTimeout
  }

  const fire = (stage, ev) => { for (const fn of stageFns.get(stage) ?? []) fn(ev) }
  // 注意：上面把 setTimeout 换成了桩，这里必须用保存下来的真定时器等待，
  // 否则 await 变成同步，队列里的异步打标还没跑完就断言了。
  const poll = async () => {
    const interval = timers.find((t) => t.kind === 'interval')
    interval.fn()
    await new Promise((r) => realSetTimeout(r, 80))
    return globalThis.__stickerShelfCalls
  }

  return { bot, stageFns, tools, logs, timers, fire, poll, calls: () => globalThis.__stickerShelfCalls }
}

test('setup 不抛错，并注册了轮询定时器', () => {
  const h = harness()
  assert.ok(h.stageFns.has('passive-tap'), '注册 passive-tap')
  assert.ok(h.stageFns.has('before-turn'), '注册 before-turn')
  assert.ok(h.tools.has('send_sticker'), '注册 send_sticker')

  const interval = h.timers.find((t) => t.kind === 'interval' && t.ms === 30 * 1000)
  assert.ok(interval, '必须有 30s 轮询 —— 没有它，群安静后就再没人叫打标')
  assert.ok(h.timers.some((t) => t.kind === 'timeout'), '启动后还要有一次首查')
})

test('打标的四个配置项都在 configSchema 里（不是死开关）', () => {
  const schema = Object.keys(stickers.configSchema ?? {})
  for (const k of ['tagging', 'tagIdleSeconds', 'tagGapSeconds', 'tagDailyMax']) {
    assert.ok(schema.includes(k), `configSchema 应含 ${k}`)
  }
})

test('内核没注入 describeImage 时只 warn 不崩', () => {
  const h = harness({ describeImage: undefined })
  const warn = h.logs.find(([lvl, m]) => lvl === 'W' && String(m).includes('describeImage'))
  assert.ok(warn, '应当 warn 一次，别做静默死开关')
})

test('机器人刚被叫醒 → 不算空闲，不打标', async () => {
  const h = harness()
  h.fire('before-turn', { wake: { kind: 'dm' }, isGroup: true, chatKey: 'g', hint: [] })
  const calls = await h.poll()
  assert.equal(calls.tagPending, 0, '它在忙，不该打标')
})

test('群里一直有人说话但没叫它 → 仍算空闲，会打标（原来的 bug）', async () => {
  const h = harness({ cfg: { tagIdleSeconds: 0 } })
  // 群里 50 条消息，都不唤醒机器人
  for (let i = 0; i < 50; i++) {
    h.fire('passive-tap', { isGroup: true, chatKey: 'g', messageId: i, rawSegments: [], sender: { qq: '9' } })
  }
  const calls = await h.poll()
  assert.ok(calls.tagPending >= 1, '群热闹 ≠ 机器人忙；没叫它就该打标')
})

test('日上限生效：达到 tagDailyMax 后不再打', async () => {
  const h = harness({ cfg: { tagIdleSeconds: 0, tagDailyMax: 2, tagGapSeconds: 0 }, tagCount: 2 })
  const first = await h.poll()
  assert.equal(first.tagPending, 1, '第一批应该打')

  const second = await h.poll()
  assert.equal(second.tagPending, 1, '日上限（2 张）已满，不该再调用 tagPending')
})

test('节流：TAG_INTERVAL_MS 内不重复打标', async () => {
  const h = harness({ cfg: { tagIdleSeconds: 0 } })
  const first = await h.poll()
  assert.equal(first.tagPending, 1)

  const second = await h.poll()
  assert.equal(second.tagPending, 1, '紧接着再触发应被节流挡下')
})

test('tagging=false 时完全不打标', async () => {
  const h = harness({ cfg: { tagging: false, tagIdleSeconds: 0 } })
  const calls = await h.poll()
  assert.equal(calls.tagPending, 0)
})

test('机器人没有看图能力时不打标（哪怕开关开着）', async () => {
  const h = harness({ cfg: { tagIdleSeconds: 0 }, describeImage: undefined })
  const calls = await h.poll()
  assert.equal(calls.tagPending, 0)
})
