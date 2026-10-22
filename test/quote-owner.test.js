/**
 * 回归：自动挂引用不能引错人。
 *
 * 线上真实踩到的现象：A 叫了机器人，机器人还在想的时候 B、C、D 聊了几句，
 * 于是出站把那句回复挂到了 A 的消息上 —— 但内容其实是在接 B/C/D 的话。
 * 引错人比不引更糟：群里看到的是一条答非所问的引用。
 *
 * 判据（本文件锁定的行为）：
 *   · 触发者在插话期间**再没开口** → 不挂引用
 *   · 触发者在插话期间**又说了话** → 允许挂
 *   · 老调用方不传 ownerQq（升级兼容）→ 按旧逻辑放行
 *   · need=0 → 永不自动挂（交回模型显式传 replyTo）
 *   · 中间没人插话（arrived < need）→ 不挂
 */
import test from 'node:test'
import assert from 'node:assert/strict'

import { ChatState } from '../kernel/state-pipeline.js'

const QQ_A = '10001'
const QQ_B = '20002'
const QQ_C = '30003'

const ev = (qq) => ({ sender: { qq } })

test('触发者说完就再没开口 → 不挂引用（原来的 bug）', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 100, QQ_A)
  s.countArrival('g', 101, ev(QQ_B))
  s.countArrival('g', 102, ev(QQ_C))
  s.countArrival('g', 103, ev(QQ_B))

  const r = s.quoteNeed('g', 1)
  assert.equal(r.arrived, 3, '三条插话都该计入')
  assert.equal(r.active, false, '触发者没再说话 → 不该算"仍然活跃"')
  assert.equal(r.allow, false, '这时挂引用就是引错人')
})

test('触发者在插话期间又开口 → 允许挂引用', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 200, QQ_A)
  s.countArrival('g', 201, ev(QQ_B))
  s.countArrival('g', 202, ev(QQ_A)) // 触发者本人补了一句

  const r = s.quoteNeed('g', 1)
  assert.equal(r.active, true)
  assert.equal(r.allow, true)
})

test('触发者自己就是"插话"的那条时也算再开口', () => {
  // 边界：arrived 只由别人贡献，但触发者本人出现要翻 active（不能被跳过规则吃掉）
  const s = new ChatState()
  s.markTurnAnchor('g', 300, QQ_A)
  s.countArrival('g', 301, ev(QQ_B))
  s.countArrival('g', 302, ev(QQ_A))
  s.countArrival('g', 303, ev(QQ_C))

  const r = s.quoteNeed('g', 1)
  assert.equal(r.arrived, 3, '三个人各算一次插话')
  assert.equal(r.allow, true)
})

test('老调用方不传 ownerQq → 向后兼容放行', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 400) // 不传第三个参数
  s.countArrival('g', 401, ev(QQ_B))

  const r = s.quoteNeed('g', 1)
  assert.equal(r.active, true, '没有 ownerQq 时不能因为"没记录"就永久禁止挂引用')
  assert.equal(r.allow, true)
})

test('need=0 → 永不自动挂', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 500, QQ_A)
  s.countArrival('g', 501, ev(QQ_A))

  const r = s.quoteNeed('g', 0)
  assert.equal(r.allow, false)
})

test('没到 need 条插话 → 不挂', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 600, QQ_A)
  s.countArrival('g', 601, ev(QQ_A))

  const r = s.quoteNeed('g', 2)
  assert.equal(r.arrived, 1)
  assert.equal(r.allow, false)
})

test('拿不到 sender 时不该崩，也不该误判成活跃', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 700, QQ_A)
  s.countArrival('g', 701, undefined) // 极端：连 ev 都没有
  s.countArrival('g', 702, {})

  const r = s.quoteNeed('g', 1)
  assert.equal(r.arrived, 2)
  assert.equal(r.allow, false, '拿不到 sender 就无法证明触发者还在，保守不挂')
})

test('多轮交错：后一轮的锚不影响前一轮的判定', () => {
  const s = new ChatState()
  s.markTurnAnchor('g', 800, QQ_A) // 第一轮，A 触发
  s.markTurnAnchor('g', 810, QQ_B) // 第二轮，B 触发（交错进来）
  s.countArrival('g', 811, ev(QQ_A)) // A 说话 → 只影响第一轮的 spokeAgain
  s.countArrival('g', 812, ev(QQ_C)) // C 说话 → 两个锚都 +1

  const first = s.quoteNeed('g', 1)
  // 队列取队首 = 最早那轮（A 的），A 说过话 → 可挂
  assert.equal(first.triggerId, 800, '出站取队首=最早那轮')
  assert.equal(first.arrived, 2, '第二轮自己的触发消息不算第一轮的插话')
  assert.equal(first.allow, true)
})
