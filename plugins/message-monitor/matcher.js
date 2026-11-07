/** Literal message-monitor matching shared by the plugin and console dry runs. */
const LIMITS = { rules: 100, id: 64, name: 100, text: 1000, instruction: 8000, groups: 100 }

function boundedString(value, label, max) {
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw new Error(`${label} 必须是非空文本，且不超过 ${max} 字符`)
  return value.trim()
}

/** Strict validation, no coercion of rule objects/booleans/numeric group IDs. */
export function validateRules(rawRules) {
  if (!Array.isArray(rawRules) || rawRules.length > LIMITS.rules)
    throw new Error(`rules 必须是数组，且最多 ${LIMITS.rules} 条`)
  const ids = new Set()
  return rawRules.map((raw, index) => {
    const label = `规则 ${index + 1}`
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(`${label} 必须是对象`)
    const keys = ['id', 'name', 'enabled', 'match', 'text', 'groups', 'instruction', 'cooldownMs']
    if (Object.keys(raw).some((key) => !keys.includes(key))) throw new Error(`${label} 包含未知字段`)
    const id = boundedString(raw.id, `${label} id`, LIMITS.id)
    if (!/^[A-Za-z0-9_-]+$/.test(id) || ids.has(id)) throw new Error(`${label} id 不合法或重复`)
    ids.add(id)
    const name = raw.name === undefined || (typeof raw.name === 'string' && !raw.name.trim())
      ? id : boundedString(raw.name, `${label} name`, LIMITS.name)
    if (raw.enabled !== undefined && typeof raw.enabled !== 'boolean') throw new Error(`${label} enabled 必须是布尔值`)
    if (!['contains', 'exact'].includes(raw.match)) throw new Error(`${label} match 仅支持 contains/exact`)
    const text = boundedString(raw.text, `${label} text`, LIMITS.text)
    const instruction = boundedString(raw.instruction, `${label} instruction`, LIMITS.instruction)
    if (!Array.isArray(raw.groups) || raw.groups.length > LIMITS.groups
      || raw.groups.some((id) => !Number.isSafeInteger(id) || id <= 0 || id > 999999999999))
      throw new Error(`${label} groups 必须是数字群号数组，最多 ${LIMITS.groups} 个；空数组不生效`)
    const cooldownMs = raw.cooldownMs === undefined ? 30000 : raw.cooldownMs
    if (!Number.isSafeInteger(cooldownMs) || cooldownMs < 0 || cooldownMs > 86400000)
      throw new Error(`${label} cooldownMs 必须是 0–86400000 的整数毫秒`)
    return { id, name, enabled: raw.enabled !== false, match: raw.match, text,
      groups: [...new Set(raw.groups)], instruction, cooldownMs }
  })
}

/** First enabled literal match wins. Callers pass already validated rules. */
export function matchRule(rules, event = {}) {
  if (event.isGroup === false || event.notice || event._scratch?.notice || event.stopped
    || (event.selfId != null && event.sender?.qq != null && String(event.selfId) === String(event.sender.qq))) return null
  const text = String(event.text ?? '').trim()
  if (!text || event.groupId == null) return null
  return (Array.isArray(rules) ? rules : []).find((rule) => rule.enabled !== false
    && rule.groups.some((id) => String(id) === String(event.groupId))
    && (rule.match === 'exact' ? text === rule.text : rule.match === 'contains' && text.includes(rule.text))) || null
}
