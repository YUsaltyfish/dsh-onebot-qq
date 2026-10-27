/**
 * admin/store.js — 控制台写实例配置的**唯一入口**（备份 → 原子写 → 热重载 → 失败回滚）。
 *
 * 为什么单开一层：八个端点里一半要写配置，写盘纪律必须只有一份 ——
 *   ① 先在校验副本上 `validateConfig()`，不合法就**一个字节都不动**；
 *   ② `saveConfig()`（kernel/config-store.js）内部：备份 `*.bak-console-<ts>` → 原子写；
 *   ③ 写完 `kernel.reloadConfig()`（读盘 + 同步各插件 cfg + pacing 等热参数）；
 *   ④ 重载抛错 → 把备份拷回去、再重载一次老配置，然后抛中文错误。
 * 宁可这次没改成，也不能留半截/坏配置。
 */
import fs from 'node:fs'
import path from 'node:path'
import { loadConfig, saveConfig, validateConfig } from '../kernel/config-store.js'
import { readJsonFile } from '../platform/atomic.js'

const isPlainObject = (v) => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const clone = (v) => (typeof structuredClone === 'function' ? structuredClone(v) : JSON.parse(JSON.stringify(v)))
const maybe = async (v) => (v && typeof v.then === 'function' ? await v : v)

/**
 * 建一个配置存储句柄。
 *
 * @param {object} opts
 * @param {object} [opts.kernel]  内核对象（用 kernel.configPath / kernel.raw / kernel.reloadConfig）
 * @param {string} [opts.configPath] 显式配置路径（优先于 kernel.configPath）
 * @param {string} [opts.dataDir]  数据目录（kernel 没给 raw 时按它 loadConfig 兜底）
 * @param {object} [opts.log]
 * @returns {{read:()=>object, save:(nextRaw:object,opts?:{what?:string})=>Promise<object>, update:(mutate:(raw:object)=>unknown,opts?:{what?:string})=>Promise<object>, configPath:string}}
 */
export function createConfigStore({ kernel = null, configPath = '', dataDir = '', log = console } = {}) {
  const logInfo = (m) => { try { log?.info?.(`[控制台] ${m}`) } catch { /* 日志失败不影响写配置 */ } }
  const logWarn = (m) => { try { log?.warn?.(`[控制台] ${m}`) } catch { /* ignore */ } }

  const fileOf = () => String(configPath || kernel?.configPath || '')
  const fallbackLoad = () => loadConfig({ dataDir: dataDir || kernel?.dataDir || '', configPath: fileOf(), createIfMissing: false })

  /** 读**磁盘上的原样配置**（v2 raw）；文件还没建时退回 kernel.raw / loadConfig 的默认结构。 */
  function read() {
    const file = fileOf()
    if (file) {
      try {
        const raw = readJsonFile(file)
        if (isPlainObject(raw)) return raw
        throw new Error(`配置文件不是 JSON 对象：${file}`)
      } catch (e) {
        if (e.code !== 'ENOENT') throw new Error(`配置文件读不了（${file}）：${e.message}`)
      }
    }
    if (isPlainObject(kernel?.raw)) return clone(kernel.raw)
    try {
      return fallbackLoad().raw
    } catch (e) {
      throw new Error(`读不到实例配置：${e.message}`)
    }
  }

  /**
   * 保存整份 raw 配置并热重载。
   *
   * 待配置模式（首次安装：只缺 adminQq）：`allowPending:true` 时容忍**唯一**的
   * 「adminQq 未配置」校验错误并照常落盘；内核支持 pending reload（只缺 adminQq 时热应用其余配置、
   * 不自动连接），所以照常 `reloadConfig()` —— 新用户先填协议端地址也能立刻生效/测试连接，
   * 填完主人 QQ 的最后一次保存自动连接。其它任何校验错误仍然拒绝写入。
   *
   * @param {object} nextRaw
   * @param {{what?:string, allowPending?:boolean}} [opts]
   * @returns {Promise<{ok:true, configPath:string, backup:string, what:string, pending?:boolean}>}
   */
  async function save(nextRaw, { what = '', allowPending = false } = {}) {
    const file = fileOf()
    if (!file) throw new Error('没有配置文件路径：控制台无法落盘（bundle 未配置 dataDir/configPath）')
    if (!isPlainObject(nextRaw)) throw new Error('要写入的配置不是 JSON 对象')
    const next = clone(nextRaw)

    // ① 先在副本上校验：不合法就别动磁盘（例外：待配置模式下唯一错误是缺 adminQq）
    const errors = validateConfig(next)
    const pendingOnly = errors.length === 1 && /^adminQq 未配置/.test(String(errors[0]))
    if (errors.length && !(allowPending && pendingOnly)) {
      throw new Error(`配置校验未通过：${errors.join('；')}`)
    }

    // ② 备份 + 原子写（saveConfig 内部已完成；失败会抛，磁盘保持原样）
    let saved
    try {
      saved = saveConfig(file, next)
    } catch (e) {
      throw new Error(`写配置失败（磁盘未改动）：${e.message}`)
    }

    // ②' 待配置模式：照常热重载（内核 pending 分支会热应用其余配置、不自动连接）。
    //     旧内核若不支持 pending reload 会抛错 → 降级为"只落盘不热重载"，不让新用户卡死。
    if (pendingOnly) {
      let applied = false
      let pendingErrors = []
      try {
        if (typeof kernel?.reloadConfig === 'function') {
          const r = await maybe(kernel.reloadConfig())
          applied = Boolean(r && r.pending === true)
          pendingErrors = Array.isArray(r?.pendingErrors) ? r.pendingErrors : []
        }
      } catch (e) {
        logWarn(`${what || '写配置'} 已落盘，但内核暂不支持 pending 热应用（${e.message}）；填完主人 QQ 后生效`)
      }
      logInfo(`${what || '写配置'} → 已保存${applied ? '并热应用其余配置' : ''}（待配置模式：填完主人 QQ 后自动连接）${saved.backup ? `（备份 ${saved.backup}）` : ''}`)
      return {
        ok: true, configPath: path.resolve(file), backup: saved.backup || '', what,
        pending: true, applied, configReady: false, pendingErrors,
      }
    }

    // ③ 热重载：失败 → 回滚 → 再尽力重载回老配置
    try {
      if (typeof kernel?.reloadConfig === 'function') await maybe(kernel.reloadConfig())
      // 二次保险（幂等）：让 adapter/kernel 级参数（napcat 地址、adminQq…）也重新应用
      if (typeof kernel?.applyRuntimeConfig === 'function') await maybe(kernel.applyRuntimeConfig(kernel.runtime))
    } catch (e) {
      let rolled = false
      try {
        if (saved.backup) {
          fs.copyFileSync(path.join(path.dirname(path.resolve(file)), saved.backup), path.resolve(file))
          rolled = true
        }
      } catch (rollbackErr) {
        logWarn(`配置回滚失败（${path.resolve(file)}）：${rollbackErr.message}`)
      }
      try {
        if (typeof kernel?.reloadConfig === 'function') await maybe(kernel.reloadConfig())
      } catch { /* 回滚后的重载失败只能留给下次启动 */ }
      if (rolled) logWarn(`${what || '写配置'} 热重载失败，已回滚：${e.message}`)
      throw new Error(`写入后热重载失败${rolled ? '，已回滚' : '（回滚也失败，请手工检查配置）'}：${e.message}`)
    }

    logInfo(`${what || '写配置'} → 已写入并热重载${saved.backup ? `（备份 ${saved.backup}）` : ''}`)
    return { ok: true, configPath: path.resolve(file), backup: saved.backup || '', what, pending: false, configReady: true }
  }

  /**
   * 读 → 深拷贝 → mutate(副本) → save。mutate 抛错则什么都不写。
   * @param {(raw:object)=>(unknown|Promise<unknown>)} mutate
   * @param {{what?:string}} [opts]
   */
  async function update(mutate, { what = '', allowPending = false } = {}) {
    if (typeof mutate !== 'function') throw new Error('update(mutate) 需要函数')
    const base = read()
    const next = clone(base)
    const extra = await mutate(next)
    const saved = await save(next, { what, allowPending })
    return {
      ...saved,
      ...(isPlainObject(extra) ? extra : {}),
      raw: next,
    }
  }

  return { read, save, update, get configPath() { return fileOf() } }
}
