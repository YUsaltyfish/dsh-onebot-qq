/**
 * 合并转发解析的测试（纯函数，不起 OneBot）。
 * 用法：node test/forward.test.js   （或随 node --test 一起跑）
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractText, renderForward } from '../kernel/format.js'

const msg = (uid, name, ...segs) => ({ sender: { user_id: uid, nickname: name, card: null }, message: segs })
const t = (text) => ({ type: 'text', data: { text } })

test('extractText：转发段不再静默丢弃，留占位并收集 {id, content}', () => {
  const r = extractText([{ type: 'forward', data: { id: 'fwd-1' } }], 10000)
  assert.equal(r.text, '[合并转发]', '正文里要有占位，否则模型完全不知道有转发')
  assert.deepEqual(r.forwards, [{ id: 'fwd-1', content: null }], '要收集转发 id（没有内联内容时 content 为 null）')
})

test('extractText：转发 + 正文混排', () => {
  const r = extractText([t('看这个'), { type: 'forward', data: { id: 'f1' } }], 1)
  assert.match(r.text, /看这个/)
  assert.match(r.text, /\[合并转发\]/)
  assert.deepEqual(r.forwards, [{ id: 'f1', content: null }])
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

// ─────────────────────────────────────────────────────────────
// 真机回归：get_msg 已经把转发内容内联在 forward.data.content 里
//
// 现象：群里发合并转发 + @机器人，模型只看到「[合并转发]」，底下什么都没有。
// 原因：代码只取了 d.id 去调 get_forward_msg，而那个接口对这类消息直接失败 ——
//       实测返回 status:failed「消息已过期或者为内层消息，无法获取转发消息」。
//       可内容其实早就随 get_msg 一起回来了，只是没人读。
//
// 下面的形状照真机返回抄的（三条、其中一条 message 是空数组），
// QQ 号与昵称已换成占位值 —— 测试只需要形状，不需要真实身份。
// ─────────────────────────────────────────────────────────────
const ONEBOT_INLINE_FORWARD = {
  type: 'forward',
  data: {
    id: 'fwd-inline-1',
    content: [
      {
        user_id: 10001,
        sender: { user_id: 10001, nickname: '群友A', card: '' },
        raw_message: '第一条原文',
        message: [{ type: 'text', data: { text: '第一条原文' } }],
      },
      {
        user_id: 10002,
        sender: { user_id: 10002, nickname: '群友B', card: '' },
        raw_message: '第二条原文',
        message: [{ type: 'text', data: { text: '第二条原文' } }],
      },
      {
        // ⚠️ 真机上这条的 message 是空数组，正文只在 raw_message 里
        user_id: 10002,
        sender: { user_id: 10002, nickname: '群友B', card: '' },
        raw_message: '第三条原文',
        message: [],
      },
    ],
  },
}

test('真机回归：extractText 要把内联 content 一起带出来（不能只给 id）', () => {
  const r = extractText([ONEBOT_INLINE_FORWARD], 10000)
  assert.equal(r.forwards.length, 1)
  const f = r.forwards[0]
  assert.equal(f.id, 'fwd-inline-1', 'id 仍然要有（回退请求可能用到）')
  assert.ok(Array.isArray(f.content), 'content 必须带出来 —— 这是这次修复的核心')
  assert.equal(f.content.length, 3)
  assert.equal(r.text, '[合并转发]', '正文占位不变')
})

test('真机回归：只靠内联 content 就能渲染出全部三条（不再依赖 get_forward_msg）', () => {
  const r = extractText([ONEBOT_INLINE_FORWARD], 10000)
  const out = renderForward({ content: r.forwards[0].content })

  assert.ok(out.length > 0, '不能是空串（原来就是空串 → 模型什么都没看到）')
  assert.match(out, /\[群友A\(QQ:10001\)\]: 第一条原文/, out)
  assert.match(out, /\[群友B\(QQ:10002\)\]: 第二条原文/, out)
  assert.match(out, /\[群友B\(QQ:10002\)\]: 第三条原文/, out)
  assert.equal(out.split('\n').length, 3, '三条都要在，一条都不能丢')
})

test('真机回归：message 为空数组时回退 raw_message（否则会渲染成 [非文字]）', () => {
  const onlyEmptyMessage = {
    content: [{
      sender: { user_id: 1, nickname: '李', card: '' },
      raw_message: '正文只在 raw_message 里',
      message: [],
    }],
  }
  const out = renderForward(onlyEmptyMessage)
  assert.match(out, /正文只在 raw_message 里/, out)
  assert.doesNotMatch(out, /\[非文字\]/, '有空正文时不该退化成 [非文字]')
})

test('renderForward：仍然兼容 get_forward_msg 的 { messages } 形状（老路径不能坏）', () => {
  const fromApi = { messages: [msg(1001, '老王', t('走接口那条路'))] }
  const out = renderForward(fromApi)
  assert.match(out, /\[老王\(QQ:1001\)\]: 走接口那条路/, out)
})

test('renderForward：{ content: [] } 返回空串（调用方据此回退请求或提示取不到）', () => {
  assert.equal(renderForward({ content: [] }), '')
})
