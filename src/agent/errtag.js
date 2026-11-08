// 出错原话 → 结果上的结构化标记:两个 runner 与 App Server 共用的**唯一入口**。
//
// 三类判据各住各的文件(签名表是 runner 层的知识),但**谁优先只在这里定一次**,第一个命中即止:
//   ① 额度 / 账号(quota)—— 要人处理或等重置,切备用模型、发告警;
//   ② 续接的会话已不存在(sessionMissing)—— 清死 id、新会话重做;
//   ③ 瞬时错(transient + transientKind:过载 / 限流 / 网关 / 网络)—— 群里说「稍后接着做」,网络档计连续失败。
// 之前三处各自往结果上挂字段,同一句原话可能两样都挂上(如「503 … your subscription has expired」):群里说
// 「稍后再试」、网络计数加一,同时又切模型、发账号告警 —— 互相矛盾。排他次序必须只有一份,所以收在这里。
// ⚠ 只挂标记,不改 r.text:账本的失败原因要留服务端原话。
const { classifyError } = require('./privatecore')

/** 按优先级给出错结果挂上 quota / sessionMissing / transient(+transientKind) 之一;返回 r。 */
function tagError(r, text) {
  const decision = classifyError(text)
  if (decision?.quota) { r.quota = decision.quota; return r }
  if (decision?.sessionMissing) { r.sessionMissing = true; return r }
  const t = decision?.transient
  if (t) { r.transient = t.human; r.transientKind = t.kind }
  return r
}

// 二进制核心失败的统一收尾:这一轮按出错结束、进程不受影响。文案进群,原因只进日志。
const CORE_FAILED_TEXT = '这一轮内部处理失败,已结束,请重新发送。'

function coreFailedResult(sessionId) {
  return { type: 'result', subtype: 'core_failed', text: CORE_FAILED_TEXT, isError: true, coreFailed: true, sessionId }
}

function isCoreFailure(error) {
  return error instanceof RangeError || error instanceof WebAssembly.RuntimeError ||
    String(error && error.message).startsWith('SintBot binary core')
}

module.exports = { tagError, CORE_FAILED_TEXT, coreFailedResult, isCoreFailure }
