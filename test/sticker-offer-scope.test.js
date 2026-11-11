/**
 * test/sticker-offer-scope.test.js — 表情「主动想起」的会话范围（群 + 私聊）。
 *
 * 2026-11-04 主人定：私聊也要掷骰提醒（旧实现私聊直接 return，导致私聊几乎不发）。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import stickers from '../plugins/stickers/index.js'

function boot(t, cfg = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qq-sticker-offer-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  const items = [
    { id: 1, hash: 'h1', file: '1.png', tags: ['无语'], tagged: true, blocked: false, uses: 0, lastUsed: 0, ts: 1 },
    { id: 2, hash: 'h2', file: '2.png', tags: ['夸人'], tagged: true, blocked: false, uses: 0, lastUsed: 0, ts: 2 },
  ]
  for (const it of items) fs.writeFileSync(path.join(dir, it.file), Buffer.alloc(2048, 1))
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items, nextId: 3 }))
  const hooks = {}
  const bot = {
    cfg: { enabled: true, dir, offerPercent: 100, offerCooldownMs: 0, maxPerTurn: 1, ...cfg },
    core: { dataDir: dir }, shared: {}, state: {}, onebot: {},
    log: Object.fromEntries(['info', 'warn', 'debug', 'error'].map((k) => [k, () => {}])),
    on: (stage, fn) => { hooks[stage] = fn },
    registerTool: () => {},
  }
  stickers.setup(bot)
  return { dir, hooks }
}

const ev = (chatKey, isGroup) => ({
  chatKey, isGroup, text: '', hint: [], _scratch: {}, wake: { kind: isGroup ? 'at' : 'private' },
})

test('表情主动想起：私聊与群聊都掷骰提醒（2026-11-04 起私聊不再被跳过）', (t) => {
  const h = boot(t)
  const dm = ev('private:10001', false)
  h.hooks['before-turn'](dm)
  assert.ok(dm.hint.some((x) => x.includes('[表情:')), `私聊应提示可发表情，实际 hint=${JSON.stringify(dm.hint)}`)
  assert.ok(dm._scratch.turnExtras?.stickerOffer, '私聊应记进本轮上下文')

  const grp = ev('group:20001', true)
  h.hooks['before-turn'](grp)
  assert.ok(grp.hint.some((x) => x.includes('[表情:')), '群聊照旧提醒')
})

test('表情主动想起：概率 0 时群聊私聊都不提醒', (t) => {
  const h = boot(t, { offerPercent: 0 })
  for (const [key, isGroup] of [['private:10001', false], ['group:20001', true]]) {
    const e = ev(key, isGroup)
    h.hooks['before-turn'](e)
    assert.equal(e.hint.length, 0, `${key} 概率 0 不应提醒`)
  }
})

test('表情主动想起：库为空时私聊也不提醒（不为空库白跑一趟）', (t) => {
  const h = boot(t)
  fs.writeFileSync(path.join(h.dir, 'index.json'), JSON.stringify({ items: [], nextId: 1 }))
  const dm = ev('private:10001', false)
  h.hooks['before-turn'](dm)
  assert.equal(dm.hint.length, 0)
})
