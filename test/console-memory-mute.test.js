/**
 * test/console-memory-mute.test.js — 群记忆「静音开关」服务端化回归（A4）。
 *
 * 为什么放到服务端：以前前端用「当前列表里 muted 的群」重建整串再整体写回，
 * 不在列表里的静音会话会被静默抹掉（记忆被重新打开），两个标签页并发时也会互相覆盖。
 * 现在前端只传 {chat, muted}，整串名单由后端在配置事务里重读 + 增删 + 回写。
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { bootKernel } from './helpers.mjs'

async function fixture(t, config = {}) {
  const h = await bootKernel({
    config: { pacing: { merge: { enabled: false }, reply: { enabled: false } }, ...config },
  })
  t.after(() => h.dispose())
  return h
}

const mutedRaw = (h) => String(h.kernel.raw.pluginConfig?.['group-memory']?.mutedChats ?? '')
const parse = (text) => new Set(String(text || '').split(/[\s,，]+/).filter(Boolean))

const mute = (h, chat, muted) => h.kernel.handleAdminRpc('memory', { op: 'mute', chat, muted })

test('静音写入配置并在 list 里可见；再次打开即移除', async (t) => {
  const h = await fixture(t)
  const on = await mute(h, 'group:20001', true)
  assert.equal(on.ok, true, JSON.stringify(on))
  assert.deepEqual(parse(mutedRaw(h)), new Set(['group:20001']))

  const list = await h.kernel.handleAdminRpc('memory', { op: 'list' })
  assert.deepEqual(parse(list.mutedChats), new Set(['group:20001']), 'list 返回的权威名单要同步')

  const off = await mute(h, 'group:20001', false)
  assert.equal(off.ok, true, JSON.stringify(off))
  assert.equal(mutedRaw(h), '', '取消静音后名单应清空')
})

test('只改目标会话：其它静音会话（含不在当前列表里的）不会被抹掉', async (t) => {
  const h = await fixture(t, { pluginConfig: { 'group-memory': { mutedChats: 'group:111111, private:222222' } } })
  const r = await mute(h, 'group:333333', true)
  assert.equal(r.ok, true, JSON.stringify(r))
  assert.deepEqual(parse(mutedRaw(h)), new Set(['group:111111', 'private:222222', 'group:333333']))
})

test('异形旧值（多空格 / 中文逗号 / 换行）读进来会归一，不重复不丢项', async (t) => {
  const h = await fixture(t, { pluginConfig: { 'group-memory': { mutedChats: 'group:1001,  private:2002，group:3003\n group:4004 ' } } })
  const r = await mute(h, 'group:1001', true) // 已静音的再关一次：幂等
  assert.equal(r.ok, true, JSON.stringify(r))
  const set = parse(mutedRaw(h))
  assert.deepEqual(set, new Set(['group:1001', 'private:2002', 'group:3003', 'group:4004']), '既不能重复也不能丢')
})

test('非法会话拒绝且不改配置', async (t) => {
  const h = await fixture(t)
  const before = mutedRaw(h)
  const r = await mute(h, 'group:abc', true)
  assert.equal(r.ok, false, JSON.stringify(r))
  assert.equal(mutedRaw(h), before)
})
