/** Resolve only memory-task routing; never changes the ordinary QQ chat route. */
export function memoryModelSelection(cfg = {}) {
  const provider = String(cfg.accumulateModelProvider || '').trim()
  const model = String(cfg.accumulateModel || '').trim()
  if (!provider && !model) return undefined
  if (!provider || !model) throw new Error('记忆分析模型提供商与模型 ID 必须同时填写；未处理素材已保留')
  return { provider, model }
}
