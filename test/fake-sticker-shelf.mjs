/**
 * 假的上游 core（vendor/dsh-sticker-shelf.mjs 的替身），供测试用。
 *
 * 插件支持 `QQ_STICKER_VENDOR` 覆盖（作者留的本地调试口），本文件就是这个口子的替身：
 * 只实现插件真正调用的少数方法，并把调用次数记到 globalThis.__stickerShelfCalls，
 * 让测试能断言"打标到底跑没跑、跑了几次"。
 *
 * 这样测试不依赖真实文件系统写盘，也不会调模型。
 */
// 每次访问都从 globalThis 读，不要缓存对象 —— 测试会在每个用例里重置计数器，
// 缓存了就会往旧对象上累加，断言永远读到 0（踩过）。
const calls = () => {
  globalThis.__stickerShelfCalls ??= { tagPending: 0, remove: 0, resolve: 0 }
  return globalThis.__stickerShelfCalls
}

export function createShelf(opts = {}) {
  return {
    dir: opts.dir,

    async tagPending(limit) {
      const c = calls()
      c.tagPending += 1
      c.lastLimit = limit
      return globalThis.__stickerShelfTagCount ?? 1
    },

    async remove(id, reason) {
      calls().remove += 1
      return true
    },

    resolve(q) {
      calls().resolve += 1
      return null
    },

    size() { return 0 },
    catalog() { return { ok: true, items: [] } },
  }
}
