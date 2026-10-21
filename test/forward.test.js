/**
 * 合并转发解析的测试（纯函数，不起 NapCat）。
 * 用法：node test/forward.test.js   （或随 node --test 一起跑）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractText, renderForward } from '../kernel/format.js'

const msg = (uid, name, ...segs) => ({ sender: { user_id: uid, nickname: name, card: null }, message: segs })
const t = (text) => ({ type: 'text', data: { text } })

test('extractText：转发段不再静默丢弃，留占位并收集 id', () => {
  const r = extractText([{ type: 'forward', data: { id: 'fwd-1' } }], 2363982681)
  assert.equal(r.text, '[合并转发]', '正文里要有占位，否则模型完全不知道有转发')
  assert.deepEqual(r.forwards, ['fwd-1'], '要收集转发 id 供后续取内容')
})

test('extractText：转发 + 正文混排', () => {
  const r = extractText([t('看这个'), { type: 'forward', data: { id: 'f1' } }], 1)
  assert.match(r.text, /看这个/)
  assert.match(r.text, /\[合并转发\]/)
  assert.deepEqual(r.forwards, ['f1'])
})

test('extractText：普通消息的 forwards 是空数组（别让下游判 undefined）', () => {
  const r = extractText([t('你好')], 1)
  assert.deepEqual(r.forwards, [])
})

test('renderForward：按「昵称(QQ:号): 内容」逐条渲染', () => {
  const fwd = {
    messages: [
      msg(1001, '老王', t('周五晚上老地方火锅')),
      msg(1002, '阿星', t('我去')),
      msg(1001, '老王', t('六点半')),
    ],
  }
  const out = renderForward(fwd)
  assert.match(out, /\[老王\(QQ:1001\)\]: 周五晚上老地方火锅/)
  assert.match(out, /\[阿星\(QQ:1002\)\]: 我去/)
  assert.match(out, /\[老王\(QQ:1001\)\]: 六点半/)
  assert.equal(out.split('\n').length, 3)
})

test('renderForward：图片段渲染成 [图片]（extractText 会给占位，不会吐出空行）', () => {
  const fwd = { messages: [msg(1001, '老王', { type: 'image', data: { file: 'x.jpg' } })] }
  const out = renderForward(fwd)
  assert.match(out, /\[老王\(QQ:1001\)\]: \[图片\]/, out)
})

test('renderForward：真·空内容才降级成 [非文字]', () => {
  const fwd = { messages: [msg(1001, '老王', { type: 'face', data: { id: '1' } })] }
  const out = renderForward(fwd)
  assert.match(out, /\[老王\(QQ:1001\)\]: \[非文字\]/, out)
})

test('renderForward：超量时明确写「还有 N 条未列出」（别让模型以为就这些）', () => {
  const messages = Array.from({ length: 50 }, (_, i) => msg(1000 + i, 'u' + i, t('第' + i + '条')))
  const out = renderForward({ messages }, { maxItems: 10 })
  assert.match(out, /还有 40 条未列出/, out.slice(-80))
  assert.match(out, /第0条/)
  assert.doesNotMatch(out, /第20条/, '超出 maxItems 的不该出现')
})

test('renderForward：单条正文按 perItemChars 截断', () => {
  const long = 'x'.repeat(500)
  const out = renderForward({ messages: [msg(1, 'a', t(long))] }, { perItemChars: 20 })
  assert.ok(out.length < 80, '单条要被截断，实际长度 ' + out.length)
})

test('renderForward：总字数超 totalChars 时整体截断并加省略号', () => {
  const messages = Array.from({ length: 30 }, (_, i) => msg(1000 + i, 'u' + i, t('内容'.repeat(20))))
  const out = renderForward({ messages }, { totalChars: 200 })
  assert.ok(out.length <= 210, '总长要受控，实际 ' + out.length)
  assert.match(out, /…$/)
})

test('renderForward：空/异常输入返回空串（调用方据此降级）', () => {
  assert.equal(renderForward(null), '')
  assert.equal(renderForward({}), '')
  assert.equal(renderForward({ messages: [] }), '')
})

test('renderForward：没有 QQ 号的发送者也别崩', () => {
  const out = renderForward({ messages: [{ sender: { nickname: '路人' }, message: [t('hi')] }] })
  assert.match(out, /\[路人\]: hi/, out)
})
