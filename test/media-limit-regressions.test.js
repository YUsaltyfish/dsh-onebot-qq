import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import http from 'node:http'
import { readLocalBytes, fetchBytes } from '../kernel/media-bytes.js'
import stickers from '../plugins/stickers/index.js'
import files from '../plugins/file-transfer/index.js'
import { readIndex } from '../plugins/stickers/shelf.js'

function fixture(t, plugin, cfg) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-media-limit-'))
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir())
    fs.rmSync(dir, { recursive: true, force: true })
  })
  const hooks = {}, tools = {}
  const bot = {
    cfg, core: { dataDir: dir }, shared: {}, state: {}, onebot: {},
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map(k => [k, () => {}])),
    on: (stage, fn) => { hooks[stage] = fn },
    registerTool: (name, tool) => { tools[name] = tool },
  }
  plugin.setup(bot)
  return { dir, bot, hooks, tools }
}
const png = n => { const b = Buffer.alloc(1200, n); b.set([137, 80, 78, 71]); return b }
const event = (file, url) => ({ isGroup: true, sender: { name: 'Fixture', qq: '123456789' }, rawSegments: [{ type: 'image', data: { sub_type: 1, file, url } }] })
const drain = h => h.bot.state.stickersQueue.push(() => {})

function mockStream(t, chunks, length) {
  const original = globalThis.fetch
  let cancelled = false, reads = 0, signal
  globalThis.fetch = async (_url, options) => {
    signal = options.signal
    return {
      ok: true,
      headers: { get: () => length ?? null },
      body: new ReadableStream({
        pull(controller) { reads++; if (chunks.length) controller.enqueue(chunks.shift()); else controller.close() },
        cancel() { cancelled = true },
      }, { highWaterMark: 0 }),
    }
  }
  t.after(() => { globalThis.fetch = original })
  return { get cancelled() { return cancelled }, get reads() { return reads }, get signal() { return signal } }
}

test('bounded local reads allow exact limit, reject oversized file before reading, zero is unlimited', async t => {
  const h = fixture(t, files, { keepDays: 0 })
  const local = path.join(h.dir, 'fixture.bin')
  fs.writeFileSync(local, Buffer.alloc(128))
  assert.equal((await readLocalBytes(local, { maxBytes: 128 })).length, 128)
  await assert.rejects(readLocalBytes(local, { maxBytes: 127 }), { code: 'MEDIA_TOO_LARGE' })
  assert.equal((await readLocalBytes(local)).length, 128)
})

test('local growth after stat is counted and handle closes on overflow', async t => {
  let closed = false, reads = 0
  t.mock.method(fs.promises, 'open', async () => ({
    stat: async () => ({ isFile: () => true, size: 2 }),
    read: async buffer => { reads++; buffer.fill(1); return { bytesRead: buffer.length } },
    close: async () => { closed = true },
  }))
  await assert.rejects(readLocalBytes('synthetic-local', { maxBytes: 10 }), { code: 'MEDIA_TOO_LARGE' })
  assert.equal(reads, 1)
  assert.equal(closed, true)
})

for (const declared of [undefined, '1']) {
  test(`HTTP counts actual bytes and cancels on overflow (declared=${declared})`, async t => {
    const stream = mockStream(t, [Buffer.alloc(6), Buffer.alloc(6), Buffer.alloc(100)], declared)
    await assert.rejects(fetchBytes('https://fixture.invalid', { maxBytes: 10 }), { code: 'MEDIA_TOO_LARGE' })
    assert.equal(stream.cancelled, true)
    assert.equal(stream.signal.aborted, true)
    assert.equal(stream.reads, 2)
  })
}

test('HTTP excessive Content-Length aborts before stream reading', async t => {
  const stream = mockStream(t, [Buffer.alloc(100)], '100')
  await assert.rejects(fetchBytes('https://fixture.invalid', { maxBytes: 10 }), { code: 'MEDIA_TOO_LARGE' })
  assert.equal(stream.reads, 0)
  assert.equal(stream.cancelled, true)
  assert.equal(stream.signal.aborted, true)
})

test('HTTP stalled body aborts on timeout and cancels reader', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  let started, aborted = false
  const ready = new Promise(resolve => { started = resolve })
  t.mock.method(globalThis, 'fetch', async (_url, { signal }) => ({
    ok: true,
    headers: new Headers(),
    body: new ReadableStream({
      start(controller) {
        signal.addEventListener('abort', () => { aborted = true; controller.error(signal.reason) }, { once: true })
      },
      pull() { started() },
    }, { highWaterMark: 0 }),
  }))
  const rejected = assert.rejects(fetchBytes('https://fixture.invalid', { maxBytes: 10, timeoutMs: 100 }), /下载超时/)
  await ready
  t.mock.timers.tick(100)
  await rejected
  assert.equal(aborted, true, 'timeout abort must reach the stalled transport')
})

test('HTTP accepts exact limit and follows redirect with final body bounded', async t => {
  const server = http.createServer((req, res) => {
    if (req.url === '/redirect') { res.writeHead(302, { location: '/body' }); res.end(); return }
    res.end(Buffer.alloc(16, 7))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve) }))
  const url = `http://127.0.0.1:${server.address().port}/redirect`
  assert.equal((await fetchBytes(url, { maxBytes: 16 })).length, 16)
  await assert.rejects(fetchBytes(url, { maxBytes: 15 }), { code: 'MEDIA_TOO_LARGE' })
})

test('file plugin limits direct, local and getFile paths and exposes live upload directory', async t => {
  const h = fixture(t, files, { keepDays: 0, maxFileMB: 10 / 1048576, downloadPolicy: 'woken' })
  const local = path.join(h.dir, 'large.bin')
  fs.writeFileSync(local, Buffer.alloc(11))
  h.bot.onebot.getFile = async () => ({ file: local })
  for (const file of [{ name: 'local.bin', url: local }, { name: 'resolved.bin', fileId: 'fixture' }]) {
    const ev = { files: [file], wake: true, hint: [] }
    await h.hooks['before-turn'](ev)
    assert.ok(ev.hint[0].includes('超过上限'))
  }
  const stream = mockStream(t, [Buffer.alloc(6), Buffer.alloc(6)], '1')
  const ev = { files: [{ name: 'remote.bin', url: 'https://fixture.invalid' }], wake: true, hint: [] }
  await h.hooks['before-turn'](ev)
  assert.equal(stream.cancelled, true)
  assert.ok(ev.hint[0].includes('未接收'))
  assert.deepEqual(fs.readdirSync(h.bot.shared.uploadDir()), [])
  h.bot.cfg.uploadDir = path.join(h.dir, 'changed')
  assert.equal(h.bot.shared.uploadDir(), h.bot.cfg.uploadDir)
})

test('sticker hot directory switch keeps in-flight and queued old jobs in old library', async t => {
  const h = fixture(t, stickers, { enabled: true, collect: true, max: 10 })
  const oldDir = h.bot.shared.stickerStats().dir
  const nextDir = path.join(h.dir, 'next')
  let resolveDownload, started
  const start = new Promise(resolve => { started = resolve })
  h.bot.onebot.getFile = async () => { started(); return new Promise(resolve => { resolveDownload = resolve }) }
  const first = path.join(h.dir, 'first.png'), second = path.join(h.dir, 'second.png'), third = path.join(h.dir, 'third.png')
  fs.writeFileSync(first, png(1)); fs.writeFileSync(second, png(2)); fs.writeFileSync(third, png(3))
  h.hooks['passive-tap'](event('fixture-id'))
  await start
  h.hooks['passive-tap'](event(second))
  h.bot.cfg.dir = nextDir
  assert.equal(h.bot.shared.stickerStats().dir, nextDir)
  h.hooks['passive-tap'](event(third))
  resolveDownload({ file: first })
  await drain(h)
  assert.equal(readIndex(oldDir).items.length, 2)
  assert.equal(readIndex(nextDir).items.length, 1)
  const catalog = await h.tools.sticker_catalog.execute({ limit: 30 })
  assert.equal(catalog.stats.dir, nextDir)
  assert.equal(catalog.stats.items, 1)
})

test('sticker max is dynamic without reinitializing directory', async t => {
  const h = fixture(t, stickers, { enabled: true, collect: true, max: 1 })
  const source = n => { const file = path.join(h.dir, `source-${n}.png`); fs.writeFileSync(file, png(n)); return file }
  h.hooks['passive-tap'](event(source(1)))
  await drain(h)
  h.hooks['passive-tap'](event(source(2)))
  await drain(h)
  assert.equal(h.bot.shared.stickerStats().count, 1)
  h.bot.cfg.max = 2
  h.hooks['passive-tap'](event(source(2)))
  await drain(h)
  assert.equal(h.bot.shared.stickerStats().count, 2)
  h.bot.cfg.max = 1
  h.hooks['passive-tap'](event(source(3)))
  await drain(h)
  assert.equal(h.bot.shared.stickerStats().count, 2, 'lowering cap must not evict existing files')
})

test('sticker download is bounded before shelf receives remote or local oversized data', async t => {
  const h = fixture(t, stickers, { enabled: true, collect: true })
  const stream = mockStream(t, [Buffer.alloc(1024 * 1024), Buffer.alloc(1024 * 1024 + 1), Buffer.alloc(10)])
  h.hooks['passive-tap'](event('', 'https://fixture.invalid'))
  await drain(h)
  assert.equal(stream.cancelled, true)
  assert.equal(h.bot.shared.stickerStats().count, 0)
  const local = path.join(h.dir, 'oversized.png')
  fs.writeFileSync(local, Buffer.alloc(2 * 1024 * 1024 + 1))
  h.hooks['passive-tap'](event(local))
  await drain(h)
  assert.equal(h.bot.shared.stickerStats().count, 0)
})
