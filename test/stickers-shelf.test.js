/**
 * test/stickers-shelf.test.js — 表情库清单（shelf.catalog）。
 *
 * 2026-10-28 事故：清单按 lastUsed/入库顺序排，默认只列 30 行 → 新收的 54 张「赫萝」形象图
 * 长期排在第 195 行之后，模型一次都没见过，于是断言"库里没有角色标签"。
 * 主人定（2026-10-29）：不搞排序，整个文件夹随便挑 —— 清单改成从全库随机抽。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createShelf } from '../plugins/stickers/shelf.js'

test('表情清单：整个库随机抽，任何位置（含"最新那批"）的图都有机会出现', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sticker-shelf-'))
  const items = []
  for (let id = 1; id <= 40; id++) {
    const file = `${id}.jpg`
    fs.writeFileSync(path.join(dir, file), 'x')
    items.push({ id, hash: 'h' + id, file, tags: ['赫萝'], tagged: true, blocked: false, uses: 0, lastUsed: 0, ts: id * 1000 })
  }
  fs.writeFileSync(path.join(dir, 'index.json'), JSON.stringify({ items, nextId: 41 }))

  const shelf = createShelf({ dir })
  const first = shelf.catalog(30).split('\n')
  assert.equal(first.length, 30, '按 limit 抽')
  assert.equal(new Set(first).size, 30, '一次清单里不重复')

  // 每次只抽 30/40、抽 20 次：某一张从没被抽到的概率 ≈ (1/4)^20 ≈ 9e-13
  const seen = new Set()
  for (let k = 0; k < 20; k++) {
    for (const line of shelf.catalog(30).split('\n')) seen.add(Number(line.split(' ')[0].slice(1)))
  }
  assert.equal(seen.size, 40, `整个库都该能被抽到（实际 ${seen.size}/40）`)
})
