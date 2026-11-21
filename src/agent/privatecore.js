// ABI v40 adapter for the built-in decision core. Manifest assembly still stays in JS.
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')

const EXPECTED_SHA256 = '5e516f10037519270148b9bcc5c7d794301cc245b52eedfc5128a156fa67d02c'
let bytes
try {
  bytes = fs.readFileSync(path.join(__dirname, 'privatecore.wasm'))
} catch (cause) {
  throw new Error('SintBot binary core is missing or unreadable; reinstall the matching package', { cause })
}
if (createHash('sha256').update(bytes).digest('hex') !== EXPECTED_SHA256) {
  throw new Error('SintBot binary core does not match its loader; reinstall the matching package')
}
let core
let compiled
function boot() {
  compiled = compiled || new WebAssembly.Module(bytes)
  core = new WebAssembly.Instance(compiled).exports
}
let engineStepPoisoned = false
function resetBinaryCore() { boot(); engineStepPoisoned = false }
try {
  boot()
} catch (cause) {
  throw new Error('SintBot binary core cannot start on this runtime', { cause })
}
if (core.abi_version() !== 40) throw new Error('SintBot binary core ABI mismatch')
const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: true })

function callText(name, text, ...args) {
  const input = encoder.encode(String(text || ''))
  const ptr = core.alloc(input.length)
  try {
    new Uint8Array(core.memory.buffer).set(input, ptr)
    return core[name](ptr, input.length, ...args)
  } finally {
    new Uint8Array(core.memory.buffer).fill(0, ptr, ptr + input.length)
    core.dealloc(ptr, input.length)
    input.fill(0)
  }
}

const HUMAN = {
  overload: '模型这会儿排不上队(服务端过载)',
  ratelimit: '请求太密,被暂时限流了',
  gateway: '模型服务暂时不可用',
  network: '暂时连不上模型服务(网络故障)',
}

function classifyError(text) {
  const code = callText('classify_error', text)
  if (code >= 1 && code <= 4) return {
    quota: { kind: code === 4 ? 'account' : 'quota', window: code === 1 ? 'weekly' : code === 2 ? 'session' : null },
  }
  if (code === 9) return { sessionMissing: true }
  const kind = { 5: 'overload', 6: 'ratelimit', 7: 'gateway', 8: 'network' }[code]
  if (kind) return { transient: { kind, human: HUMAN[kind] } }
  if (code !== 0) throw new Error(`SintBot binary core returned unknown result ${code}`)
  return null
}

function routeBackend(runner, codexApp, codexSteer, codexProjectDocFallback) {
  const flags = (codexApp ? 1 : 0) | (codexSteer ? 2 : 0) | (codexProjectDocFallback ? 4 : 0)
  const code = callText('route_backend', runner, flags)
  const route = { 0: 'claude', 1: 'codex-exec', 2: 'codex-app' }[code]
  if (!route) throw new Error(`SintBot binary core returned unknown backend ${code}`)
  return route
}

function sandboxTier(permissionMode) {
  const code = callText('sandbox_tier', permissionMode)
  if (code === 0) return 'read-only'
  if (code === 1) return 'danger-full-access'
  throw new Error(`SintBot binary core returned unknown sandbox tier ${code}`)
}

function appErrorOverride(status, hasKind, hasQuota, sessionMissing, hasTransient) {
  const code = core.app_error_override(Number(status), Number(!!hasKind), Number(!!hasQuota), Number(!!sessionMissing), Number(!!hasTransient))
  if (code === 0) return null
  if (code === 1) return 'account'
  if (code === 2) return 'network'
  if (code === 3) return 'gateway'
  throw new Error(`SintBot binary core returned unknown App error decision ${code}`)
}

function codexBuildPrompt(prompt, appendSystemPrompt, isResume) {
  const promptBytes = encoder.encode(prompt)
  const appendixBytes = encoder.encode(appendSystemPrompt || '')
  const promptPtr = core.alloc(promptBytes.length)
  let appendixPtr = 0, outputPtr = 0, outputSize = 0
  try {
    appendixPtr = core.alloc(appendixBytes.length)
    new Uint8Array(core.memory.buffer).set(promptBytes, promptPtr)
    new Uint8Array(core.memory.buffer).set(appendixBytes, appendixPtr)
    outputPtr = core.codex_build_prompt(promptPtr, promptBytes.length, appendixPtr, appendixBytes.length, Number(!!isResume))
    if (!outputPtr) throw new Error('SintBot binary core could not build Codex prompt')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned an invalid Codex prompt')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned an invalid Codex prompt')
    return decoder.decode(new Uint8Array(buffer, outputPtr + 4, length))
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, promptPtr, promptPtr + promptBytes.length)
    core.dealloc(promptPtr, promptBytes.length)
    if (appendixPtr) {
      memory.fill(0, appendixPtr, appendixPtr + appendixBytes.length)
      core.dealloc(appendixPtr, appendixBytes.length)
    }
    promptBytes.fill(0)
    appendixBytes.fill(0)
  }
}

function codexBuildArgs(options) {
  const input = encoder.encode(JSON.stringify(options))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.codex_build_args(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not build Codex arguments')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid Codex arguments')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid Codex arguments')
    const args = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!Array.isArray(args) || !args.every((arg) => typeof arg === 'string')) {
      throw new Error('SintBot binary core returned invalid Codex arguments')
    }
    return args
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function appUsageFromTotal(total) {
  const input = encoder.encode(JSON.stringify(total ?? null))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.app_usage_from_total(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not map App usage')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid App usage')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid App usage')
    const usage = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (usage !== null && (typeof usage !== 'object' || Array.isArray(usage))) {
      throw new Error('SintBot binary core returned invalid App usage')
    }
    return usage
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function settleUsage(prior, sessionKey, result) {
  // Only numeric/accounting fields cross this ABI. A run result may also hold
  // model text or tool output, which the usage decision must never receive.
  const usage = result && result.usage
  const projection = {
    usage: usage ? {
      input_tokens: usage.input_tokens,
      cached_input_tokens: usage.cached_input_tokens,
      output_tokens: usage.output_tokens,
      cache_read_input_tokens: usage.cache_read_input_tokens,
      cache_creation_input_tokens: usage.cache_creation_input_tokens,
    } : null,
    usageCumulative: result && result.usageCumulative,
    contextTokens: result && result.contextTokens,
    contextCompacted: result && result.contextCompacted,
  }
  const input = encoder.encode(JSON.stringify({ prior, sessionKey, result: projection }))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.settle_usage(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not settle usage')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid usage decision')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid usage decision')
    const decision = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!decision || typeof decision !== 'object' || typeof decision.write !== 'boolean' ||
        (decision.tokens !== null && (typeof decision.tokens !== 'object' || Array.isArray(decision.tokens))) ||
        (decision.write && (!decision.stats || typeof decision.stats !== 'object' || Array.isArray(decision.stats)))) {
      throw new Error('SintBot binary core returned invalid usage decision')
    }
    return decision
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function appBuildRequest(options) {
  const input = encoder.encode(JSON.stringify(options))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.app_build_request(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not build App request')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid App request')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid App request')
    const request = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!request || !['thread/start', 'thread/resume', 'turn/start'].includes(request.method) ||
        !request.params || typeof request.params !== 'object' || Array.isArray(request.params)) {
      throw new Error('SintBot binary core returned invalid App request')
    }
    return request
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function claudeBaseSkillAllows() {
  const outputPtr = core.claude_base_skills()
  if (!outputPtr) throw new Error('SintBot binary core could not provide Claude base skills')
  let outputSize = 0
  try {
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude base skills')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude base skills')
    const skills = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!Array.isArray(skills) || !skills.every((s) => typeof s === 'string')) throw new Error('SintBot binary core returned invalid Claude base skills')
    return skills
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputSize) core.dealloc(outputPtr, outputSize)
  }
}

function claudeBuildArgs(options) {
  const input = encoder.encode(JSON.stringify(options))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.claude_build_args(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not build Claude arguments')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude arguments')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude arguments')
    const args = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!Array.isArray(args) || !args.every((a) => typeof a === 'string')) throw new Error('SintBot binary core returned invalid Claude arguments')
    return args
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function claudeNormalizeEvent(event) {
  const errorJson = event && event.is_error && Array.isArray(event.errors)
    ? event.errors.map((item) => JSON.stringify(item) ?? null) : null
  const input = encoder.encode(JSON.stringify({ event, errorJson }))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core.claude_normalize_event(inputPtr, input.length)
    if (!outputPtr) throw new Error('SintBot binary core could not normalize Claude event')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude event')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid Claude event')
    const normalized = JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
    if (!normalized || typeof normalized !== 'object' || Array.isArray(normalized)) {
      throw new Error('SintBot binary core returned invalid Claude event')
    }
    return normalized
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function coreJson(name, inputValue, context) {
  const input = encoder.encode(JSON.stringify(inputValue))
  const inputPtr = core.alloc(input.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(input, inputPtr)
    outputPtr = core[name](inputPtr, input.length)
    if (!outputPtr) throw new Error(`SintBot binary core could not ${context}`)
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error(`SintBot binary core returned invalid ${context}`)
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error(`SintBot binary core returned invalid ${context}`)
    return JSON.parse(decoder.decode(new Uint8Array(buffer, outputPtr + 4, length)))
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, inputPtr, inputPtr + input.length)
    core.dealloc(inputPtr, input.length)
    input.fill(0)
  }
}

function claudePluginAllowRules(mcpNames, skillNames) {
  if (!Array.isArray(mcpNames) || !Array.isArray(skillNames) ||
      [...mcpNames, ...skillNames].some((name) => typeof name !== 'string')) {
    throw new TypeError('invalid Claude plugin names')
  }
  const value = coreJson('claude_plugin_allow_rules', { mcpNames, skillNames }, 'decide Claude plugin permissions')
  if (!Array.isArray(value) || value.some((rule) => typeof rule !== 'string')) {
    throw new Error('SintBot binary core returned invalid Claude plugin permissions')
  }
  return value
}

function codexNormalizeEvent(event) {
  const value = coreJson('codex_normalize_event', event, 'normalize Codex event')
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('SintBot binary core returned invalid Codex event')
  return value
}

function codexParseError(raw) {
  const value = coreJson('codex_parse_error', String(raw || ''), 'parse Codex error')
  if (!value || typeof value.text !== 'string' || typeof value.param !== 'string') throw new Error('SintBot binary core returned invalid Codex error')
  return value
}

function appNormalizeItem(method, item) {
  const value = coreJson('app_normalize_item', { method, item }, 'normalize App item')
  if (value !== null && (typeof value !== 'object' || Array.isArray(value))) throw new Error('SintBot binary core returned invalid App item')
  return value
}

function appStreamTail(finalText, streamed) {
  const value = coreJson('app_stream_tail', { finalText, streamed }, 'reconcile App message deltas')
  if (value !== null && typeof value !== 'string') throw new Error('SintBot binary core returned invalid App message tail')
  return value
}

function appNoticeAction(method, { threadMatches, turnMatches, activeTurn, completed, codexApp, hasTurnId, hasItemId }) {
  const flags = (threadMatches ? 1 : 0) | (turnMatches ? 2 : 0) | (activeTurn ? 4 : 0) |
    (completed ? 8 : 0) | (codexApp ? 16 : 0) | (hasTurnId ? 32 : 0) | (hasItemId ? 64 : 0)
  const code = callText('app_notice_action', method, flags)
  if (code >= 0 && code <= 5) return code
  throw new Error(`SintBot binary core returned unknown App notification action ${code}`)
}

function appDeltaNext(previous, delta) {
  const previousBytes = new Uint8Array(previous.length * 2)
  const deltaBytes = new Uint8Array(delta.length * 2)
  for (let i = 0; i < previous.length; i++) {
    const unit = previous.charCodeAt(i)
    previousBytes[i * 2] = unit & 255
    previousBytes[i * 2 + 1] = unit >>> 8
  }
  for (let i = 0; i < delta.length; i++) {
    const unit = delta.charCodeAt(i)
    deltaBytes[i * 2] = unit & 255
    deltaBytes[i * 2 + 1] = unit >>> 8
  }
  const previousPtr = core.alloc(previousBytes.length)
  let deltaPtr = 0, outputPtr = 0, outputSize = 0
  try {
    deltaPtr = core.alloc(deltaBytes.length)
    new Uint8Array(core.memory.buffer).set(previousBytes, previousPtr)
    new Uint8Array(core.memory.buffer).set(deltaBytes, deltaPtr)
    outputPtr = core.app_delta_next(previousPtr, previousBytes.length, deltaPtr, deltaBytes.length)
    if (!outputPtr) {
      if (!delta.length) return null
      throw new Error('SintBot binary core could not accumulate App message delta')
    }
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid App delta')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (length !== previousBytes.length + deltaBytes.length || outputPtr + outputSize > buffer.byteLength) {
      throw new Error('SintBot binary core returned invalid App delta')
    }
    const bytes = new Uint8Array(buffer, outputPtr + 4, length)
    const units = new Uint16Array(length / 2)
    for (let i = 0; i < units.length; i++) units[i] = bytes[i * 2] | (bytes[i * 2 + 1] << 8)
    let result = ''
    for (let i = 0; i < units.length; i += 8192) result += String.fromCharCode(...units.subarray(i, i + 8192))
    return result
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, previousPtr, previousPtr + previousBytes.length)
    core.dealloc(previousPtr, previousBytes.length)
    if (deltaPtr) {
      memory.fill(0, deltaPtr, deltaPtr + deltaBytes.length)
      core.dealloc(deltaPtr, deltaBytes.length)
    }
    previousBytes.fill(0)
    deltaBytes.fill(0)
  }
}

function appLandedAction(itemType, done, hasClientId, alreadyLanded) {
  const flags = (done ? 1 : 0) | (hasClientId ? 2 : 0) | (alreadyLanded ? 4 : 0)
  const code = callText('app_landed_action', itemType, flags)
  if (code === 0) return false
  if (code === 1) return true
  throw new Error(`SintBot binary core returned unknown App landing action ${code}`)
}

function appCompletionAction(status, matchesTurn, completed, hasEffort, retriedEffort, effortRejected) {
  const flags = (matchesTurn ? 1 : 0) | (completed ? 2 : 0) | (hasEffort ? 4 : 0) |
    (retriedEffort ? 8 : 0) | (effortRejected ? 16 : 0)
  const code = callText('app_completion_action', status, flags)
  if (code >= 0 && code <= 4) return code
  throw new Error(`SintBot binary core returned unknown App completion action ${code}`)
}

// The host owns opaque turn IDs; the core selects which completion can settle
// the active turn or be retained until turn/start returns its ID.
function appCompletionNoticeAction({ threadMatches, hasTurnId, activeTurn, activeTurnMatches, pendingStart, completed }) {
  const flags = (threadMatches ? 1 : 0) | (hasTurnId ? 2 : 0) | (activeTurn ? 4 : 0) |
    (activeTurnMatches ? 8 : 0) | (pendingStart ? 16 : 0) | (completed ? 32 : 0)
  const code = core.app_completion_notice_action(flags)
  if (code >= 0 && code <= 2) return code
  throw new Error(`SintBot binary core returned unknown App completion notice action ${code}`)
}

function manifestFeatures(features) {
  const keys = ['boards', 'cardPinned', 'download', 'editRecall', 'history', 'imagen',
    'noticeCard', 'plainSend', 'react', 'skills', 'takeoverCard', 'mediaByPath']
  const projected = {}
  for (const key of keys) if (key !== 'mediaByPath') projected[key] = features ? features[key] : undefined
  projected.mediaMarker = features ? features.mediaMarker : undefined
  const value = coreJson('manifest_features', { features: projected }, 'select manifest platform features')
  if (!value || keys.some((key) => typeof value[key] !== 'boolean')) {
    throw new Error('SintBot binary core returned invalid manifest features')
  }
  return value
}

function systemAppendix(noReply) {
  const bytes = encoder.encode(String(noReply))
  const ptr = core.alloc(bytes.length)
  let outputPtr = 0, outputSize = 0
  try {
    new Uint8Array(core.memory.buffer).set(bytes, ptr)
    outputPtr = core.system_appendix(ptr, bytes.length)
    if (!outputPtr) throw new Error('SintBot binary core could not render group appendix')
    const buffer = core.memory.buffer
    if (outputPtr + 4 > buffer.byteLength) throw new Error('SintBot binary core returned invalid group appendix')
    const length = new DataView(buffer).getUint32(outputPtr, true)
    outputSize = length + 4
    if (outputPtr + outputSize > buffer.byteLength) throw new Error('SintBot binary core returned invalid group appendix')
    return decoder.decode(new Uint8Array(buffer, outputPtr + 4, length))
  } finally {
    const memory = new Uint8Array(core.memory.buffer)
    if (outputPtr && outputSize && outputPtr + outputSize <= memory.length) memory.fill(0, outputPtr, outputPtr + outputSize)
    if (outputPtr && outputSize) core.dealloc(outputPtr, outputSize)
    memory.fill(0, ptr, ptr + bytes.length)
    core.dealloc(ptr, bytes.length)
    bytes.fill(0)
  }
}

function codexEffortRejection(result) {
  const value = result && { isError: result.isError, effortRejected: result.effortRejected, text: result.text }
  const code = callText('codex_effort_rejection', JSON.stringify(value))
  if (code === 0) return false
  if (code === 1) return true
  throw new Error(`SintBot binary core returned unknown Codex effort decision ${code}`)
}

function parseResetFields(text) {
  const value = coreJson('parse_reset_fields', String(text || ''), 'parse reset time')
  if (value !== null && (!value || typeof value !== 'object' || Array.isArray(value) ||
      (value.month !== null && !Number.isInteger(value.month)) ||
      (value.day !== null && !Number.isInteger(value.day)) ||
      !Number.isInteger(value.hour) || !Number.isInteger(value.minute) ||
      (value.zone !== null && typeof value.zone !== 'string'))) {
    throw new Error('SintBot binary core returned invalid reset time')
  }
  return value
}

function chooseResetEpoch(now, primary, nextYear, dated) {
  const result = core.choose_reset_epoch(now, primary, nextYear, Number(!!dated))
  return Number.isNaN(result) ? null : result
}

function wecomGatePrompt(input) {
  const value = coreJson('wecom_gate_prompt', input, 'render WeCom gate prompt')
  if (!value || typeof value.system !== 'string' || typeof value.user !== 'string') {
    throw new Error('SintBot binary core returned invalid WeCom gate prompt')
  }
  return value
}

function manifestHeader(input) {
  const lines = coreJson('manifest_header', input, 'render manifest header')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) {
    throw new Error('SintBot binary core returned invalid manifest header')
  }
  return lines
}

function manifestContext(input) {
  const lines = coreJson('manifest_context', input, 'render manifest context')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) {
    throw new Error('SintBot binary core returned invalid manifest context')
  }
  return lines
}

function manifestSkills(input) {
  const lines = coreJson('manifest_skills', input, 'render manifest platform skills')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) throw new Error('SintBot binary core returned invalid manifest platform skills')
  return lines
}

function manifestStyleBoard(input) {
  const lines = coreJson('manifest_style_board', input, 'render manifest style and board rules')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) throw new Error('SintBot binary core returned invalid manifest style and board rules')
  return lines
}

function manifestImagenAsset(input) {
  const lines = coreJson('manifest_imagen_asset', input, 'render manifest image and asset rules')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) throw new Error('SintBot binary core returned invalid manifest image and asset rules')
  return lines
}

function manifestRuntime(input) {
  const lines = coreJson('manifest_runtime', input, 'render manifest runtime rules')
  if (!Array.isArray(lines) || !lines.every((line) => typeof line === 'string')) throw new Error('SintBot binary core returned invalid manifest runtime rules')
  return lines
}

function imagenPrompt(input) {
  const value = coreJson('imagen_prompt', input, 'render image prompt')
  if (typeof value !== 'string') throw new Error('SintBot binary core returned invalid image prompt')
  return value
}

function turnPrompt(input) {
  const value = coreJson('turn_prompt', input, 'render turn prompt')
  if (typeof value !== 'string') throw new Error('SintBot binary core returned invalid turn prompt')
  return value
}

function compactEvent(subtype) {
  const code = callText('compact_event', subtype)
  if (code === 0) return false
  if (code === 1) return true
  throw new Error(`SintBot binary core returned unknown compaction decision ${code}`)
}

function engineQueueStep(state, event) {
  const value = coreJson('engine_queue_step', { state, event }, 'advance engine queue')
  if (!value || !value.state || !Array.isArray(value.state.queue) ||
      !Array.isArray(value.effects) || !Number.isInteger(value.runLen) ||
      !Number.isInteger(value.visibleQueue)) throw new Error('SintBot binary core returned invalid engine queue transition')
  return value
}

function engineSlotsStep(state, event) {
  const value = coreJson('engine_slots_step', { state, event }, 'advance engine slots')
  if (!value || !value.state || typeof value.state !== 'object' ||
      !Array.isArray(value.state.waiters) || !Array.isArray(value.effects) ||
      value.effects.some((effect) => !effect || !['grant', 'reject'].includes(effect.type) || typeof effect.id !== 'string')) {
    throw new Error('SintBot binary core returned invalid engine slots transition')
  }
  return value
}

function engineTurnStep(state, event) {
  const value = coreJson('engine_turn_step', { state, event }, 'advance engine turn identity')
  if (!value || !value.state || Array.isArray(value.state) || typeof value.state !== 'object' ||
      !Number.isSafeInteger(value.state.epoch) || value.state.epoch < 0 ||
      !(value.state.active === null || (Number.isSafeInteger(value.state.active) && value.state.active > 0)) ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect ||
        !['turnToken', 'effectAllowed'].includes(effect.type) ||
        !Number.isSafeInteger(effect.type === 'turnToken' ? effect.value : effect.turnToken))) {
    throw new Error('SintBot binary core returned invalid engine turn transition')
  }
  return value
}

function engineSessionStep(state, event) {
  const value = coreJson('engine_session_step', { state, event }, 'advance engine session')
  const next = value && value.state
  if (!next || Array.isArray(next) || typeof next !== 'object' ||
      !Number.isSafeInteger(next.epoch) || next.epoch < 0 ||
      typeof next.closeSeen !== 'boolean' || typeof next.settled !== 'boolean' ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect ||
        !['writeSession', 'markTainted', 'resetSessionAndStats'].includes(effect.type))) {
    throw new Error('SintBot binary core returned invalid engine session transition')
  }
  return value
}

function engineHandoffStep(state, event) {
  const value = coreJson('engine_handoff_step', { state, event }, 'advance engine handoff')
  const next = value && value.state
  if (!next || Array.isArray(next) || typeof next !== 'object' ||
      !['idle', 'running', 'releasing', 'handoff', 'sealed'].includes(next.phase) ||
      !(next.turnToken === null || (Number.isSafeInteger(next.turnToken) && next.turnToken > 0)) ||
      ![0, 1].includes(next.attempt) || !Array.isArray(next.acceptedReceiptIds) ||
      !(next.nextJobId === null || typeof next.nextJobId === 'string') ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect ||
        !['attemptQueueRelease', 'retryQueueRelease', 'sealGroup', 'notifyAccepted',
          'holdHandoff', 'scheduleDispatch', 'clearHandoff', 'dispatch'].includes(effect.type))) {
    throw new Error('SintBot binary core returned invalid engine handoff transition')
  }
  return value
}

function engineIntakeStep(state, event) {
  const value = coreJson('engine_intake_step', { state, event }, 'advance engine intake')
  const next = value && value.state
  if (!next || Array.isArray(next) || typeof next !== 'object' ||
      !Number.isSafeInteger(next.watermark) || next.watermark < 0 ||
      !Array.isArray(next.seen) || typeof next.unboundNotified !== 'boolean' ||
      !(next.pending === null || (next.pending && typeof next.pending === 'object' &&
        typeof next.pending.key === 'string' && Number.isSafeInteger(next.pending.at) &&
        Number.isSafeInteger(next.pending.watermark))) ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect ||
        !['notifyOrphan', 'sendUnboundGuide', 'clearQueue', 'handleCommand',
          'persistReceipt', 'dispatch'].includes(effect.type))) {
    throw new Error('SintBot binary core returned invalid engine intake transition')
  }
  return value
}

function engineLifecycleStep(state, event) {
  const value = coreJson('engine_lifecycle_step', { state, event }, 'advance engine lifecycle')
  if (!value || !value.state || Array.isArray(value.state) || typeof value.state !== 'object' ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect || typeof effect.type !== 'string')) {
    throw new Error('SintBot binary core returned invalid engine lifecycle transition')
  }
  return value
}

function engineTerminalStep(state, event) {
  const value = coreJson('engine_terminal_step', { state, event }, 'advance engine terminal state')
  const next = value && value.state
  const outcome = next && next.outcome
  const fields = ['silent', 'nothingProduced', 'sideEffects', 'sessionMissing',
    'lostRetry', 'network', 'quotaError', 'resumed']
  if (!next || next.finalized !== true || !outcome ||
      !['stopped', 'error', 'no-reply', 'empty', 'ok'].includes(outcome.status) ||
      fields.some((field) => typeof outcome[field] !== 'boolean') ||
      !Array.isArray(value.effects) || value.effects.some((effect) => !effect ||
        !['markTainted', 'clearTainted', 'clearExhausted', 'verifyTurn'].includes(effect.type) ||
        (effect.type === 'verifyTurn' && typeof effect.success !== 'boolean'))) {
    throw new Error('SintBot binary core returned invalid engine terminal transition')
  }
  return value
}

function engineSteerStep(state, event) {
  const value = coreJson('engine_steer_step', { state, event }, 'advance Codex follow-up')
  if (!value || !value.state || Array.isArray(value.state) || typeof value.state !== 'object' ||
      !Array.isArray(value.state.entries) || !Array.isArray(value.effects) ||
      value.effects.some((effect) => !effect || typeof effect.type !== 'string')) {
    throw new Error('SintBot binary core returned invalid Codex follow-up transition')
  }
  return value
}

function engineRecoveryStep(event) {
  const value = coreJson('engine_recovery_step', event, 'advance engine recovery')
  if (!value || !Array.isArray(value.effects)) throw new Error('SintBot binary core returned invalid engine recovery transition')
  return value
}

function engineFailoverStep(event) {
  const value = coreJson('engine_failover_step', event, 'advance engine failover')
  if (!value || !Array.isArray(value.effects)) throw new Error('SintBot binary core returned invalid engine failover transition')
  return value
}

// This stateful C2 entry is deliberately outside guarded(): a failed step may
// have mutated WASM memory before throwing, so later events must wait for an
// explicit instance rebuild from the host's last committed state.
function engineStep(state, event, admission = null) {
  if (engineStepPoisoned) throw new Error('SintBot binary core C2 state needs recovery')
  if (!state || ![1, 2].includes(state.version) || !Number.isSafeInteger(state.seq) || state.seq < 0 ||
      !state.lanes || typeof state.lanes !== 'object' || Array.isArray(state.lanes) ||
      !event || typeof event.id !== 'string' || !event.id ||
      typeof event.domain !== 'string' || !event.domain ||
      typeof event.scope !== 'string' || !event.scope ||
      !Number.isSafeInteger(event.expectedCursor) || event.expectedCursor !== state.seq ||
      !event.payload || typeof event.payload !== 'object' || Array.isArray(event.payload) ||
      (state.version === 1 && admission !== null) ||
      (state.version === 2 && (!admission || admission.version !== 1 ||
        admission.cursor !== state.seq || admission.eventId !== event.id ||
        admission.unseen !== true || Object.keys(admission).length !== 4))) {
    throw new TypeError('invalid C2 step input')
  }
  try {
    const input = state.version === 2 ? { state, event, admission } : { state, event }
    const value = coreJson('engine_step', input, 'advance C2 engine')
    if (!value || !value.state || value.state.version !== state.version ||
        !Number.isSafeInteger(value.state.seq) || value.state.seq !== state.seq + 1 ||
        !value.state.lanes || typeof value.state.lanes !== 'object' || Array.isArray(value.state.lanes) ||
        value.cursor !== value.state.seq || value.eventId !== event.id ||
        !Array.isArray(value.effects) || value.effects.some((effect, index) =>
          !effect || typeof effect !== 'object' || typeof effect.type !== 'string' ||
          effect.effectId !== `sbot-c2-effect-v1:${Buffer.byteLength(event.id)}:${event.id}:${index}`) ||
        !value.decision || typeof value.decision !== 'object' || Array.isArray(value.decision)) {
      throw new Error('SintBot binary core returned invalid C2 engine transition')
    }
    return value
  } catch (error) {
    engineStepPoisoned = true
    throw error
  }
}

function manifestPolicy(permissionMode, isCodex, allowedTools, disallowedTools) {
  const value = coreJson('manifest_policy', { permissionMode, isCodex, allowedTools, disallowedTools }, 'decide manifest permissions')
  if (!value || !Number.isInteger(value.tier) || value.tier < 0 || value.tier > 3 ||
      typeof value.full !== 'boolean' || typeof value.pushDenied !== 'boolean') {
    throw new Error('SintBot binary core returned invalid manifest policy')
  }
  return value
}

// ABI 36 JSON decisions. Each wrapper only
// checks the envelope shape the host relies on; the core owns the rules and wording.
const isObject = value => !!value && typeof value === 'object' && !Array.isArray(value)

function connectManifest(basic, userName, version) {
  const value = coreJson('connect_manifest', { basic: !!basic, userName: String(userName || ''), version: String(version || '') }, 'build the Feishu connect manifest')
  if (!isObject(value) || !isObject(value.appPreset) || !isObject(value.addons) ||
      !Array.isArray(value.addons.scopes) || !Array.isArray(value.addons.events) ||
      !Array.isArray(value.addons.callbacks) || typeof value.hint !== 'string') {
    throw new Error('SintBot binary core returned an invalid connect manifest')
  }
  return value
}

// The Slack app manifest and its prefilled "create app" link. The core owns
// the scopes and events; the host only opens the link.
const SLACK_CREATE_PREFIX = 'https://api.slack.com/apps?new_app=1&manifest_json='
// The core's answer for one request. Declaring an Agent cannot be undone in
// Slack, so the manifest, the link Slack opens and the events must all say
// exactly what was asked (`agentView`), or the answer is refused.
function slackManifestShapeOk(value, agentView) {
  if (!isObject(value) || value.platform !== 'slack' || !isObject(value.manifest) || !isObject(value.manifest.features) ||
      typeof value.name !== 'string' || !value.name || typeof value.hint !== 'string' ||
      typeof value.createUrl !== 'string' || !value.createUrl.startsWith(SLACK_CREATE_PREFIX) ||
      !Array.isArray(value.scopes) || !value.scopes.every(scope => typeof scope === 'string') ||
      !Array.isArray(value.events) || typeof value.command !== 'string') return false
  const wanted = agentView === true
  let linked = null
  try { linked = JSON.parse(decodeURIComponent(value.createUrl.slice(SLACK_CREATE_PREFIX.length))) } catch { return false }
  return value.agentView === wanted && ('agent_view' in value.manifest.features) === wanted &&
    isObject(linked) && isObject(linked.features) && ('agent_view' in linked.features) === wanted &&
    value.events.includes('agent_session_stopped') === wanted
}

// `agentView` declares the app as a Slack Agent; it is opt-in and off by default.
function connectSlackManifest(name = '', { agentView = false } = {}) {
  const value = coreJson('connect_manifest', { platform: 'slack', name: String(name || ''), agentView: agentView === true }, 'build the Slack app manifest')
  if (!slackManifestShapeOk(value, agentView)) throw new Error('SintBot binary core returned an invalid Slack app manifest')
  return value
}

function connectPlan(step, { basic = false, status = null, code = null, msg = '', observed = {} } = {}) {
  const value = coreJson('connect_plan', { step, basic: !!basic, status, code, msg: String(msg || ''), observed: isObject(observed) ? observed : {} }, `decide the connect step ${step}`)
  if (!isObject(value) || !['ok', 'stop', 'wait', 'warn'].includes(value.verdict) || typeof value.notice !== 'string' ||
      !(value.next === null || typeof value.next === 'string') ||
      !(value.retryAfterMs === null || Number.isSafeInteger(value.retryAfterMs)) ||
      (step === 'slack-proxy' && !(value.verdict === 'ok'
        ? isObject(value.proxy) && typeof value.proxy.url === 'string' && typeof value.proxy.noProxy === 'string'
        : value.verdict === 'stop' && value.notice !== '' && value.proxy === null))) {
    throw new Error('SintBot binary core returned an invalid connect decision')
  }
  return value
}

function connectConfig(input) {
  const value = coreJson('connect_config', input, 'build the Feishu connect configuration')
  if (!isObject(value) || typeof value.ok !== 'boolean' ||
      (value.ok && (!isObject(value.config) || typeof value.readme !== 'string')) ||
      (!value.ok && typeof value.error !== 'string')) {
    throw new Error('SintBot binary core returned an invalid connect configuration')
  }
  return value
}

function qrMatrix(text, ec = 'M') {
  const value = coreJson('qr_matrix', { text: String(text), ec }, 'encode a QR code')
  if (!isObject(value) || !Number.isInteger(value.size) || !Array.isArray(value.rows) ||
      value.rows.length !== value.size || value.rows.some(row => typeof row !== 'string' || row.length !== value.size)) {
    throw new Error('SintBot binary core returned an invalid QR matrix')
  }
  return value
}

function usageParse(provider, source, status, body, now = Date.now()) {
  const value = coreJson('usage_parse', { provider, source, status, body, now }, `parse ${provider} ${source} usage`)
  if (!isObject(value) || typeof value.ok !== 'boolean' ||
      (value.ok && !Array.isArray(value.windows)) || (!value.ok && typeof value.error !== 'string')) {
    throw new Error('SintBot binary core returned an invalid usage result')
  }
  return value
}

// ABI 37: idle compaction rules. The host
// only spawns, stops and logs; start/skip and settle outcomes are decided here.
function idleCompactPlan(input) {
  const value = coreJson('idle_compact_plan', input, 'plan idle compaction')
  if (!isObject(value) || typeof value.start !== 'boolean' || !Number.isFinite(value.at) ||
      typeof value.reason !== 'string' || typeof value.keep !== 'string' || !Number.isFinite(value.maxMs)) {
    throw new Error('SintBot binary core returned an invalid idle compaction plan')
  }
  return value
}

function idleCompactSettle(input) {
  const value = coreJson('idle_compact_settle', input, 'settle idle compaction')
  if (!isObject(value) || !['compacted', 'stopped', 'failed'].includes(value.status) ||
      !Number.isFinite(value.fails) || typeof value.notice !== 'string' ||
      (value.ctx !== null && !Number.isFinite(value.ctx)) || (value.restUntil !== null && !Number.isFinite(value.restUntil))) {
    throw new Error('SintBot binary core returned an invalid idle compaction result')
  }
  return value
}

function envConflicts(input) {
  const value = coreJson('env_conflicts', input, 'check environment conflicts')
  if (!isObject(value) || !Array.isArray(value.warnings) ||
      value.warnings.some(w => !isObject(w) || typeof w.key !== 'string' || typeof w.where !== 'string' || typeof w.reason !== 'string')) {
    throw new Error('SintBot binary core returned an invalid environment check')
  }
  return value
}

// ABI 38: Slack display rules. Each wrapper only checks the envelope shape the
// host relies on; which messages are marked or noted, what the record says
// and when a shared app connection is reported are decided by the core.
const isStringList = value => Array.isArray(value) && value.every(item => typeof item === 'string')
const LEFTOVER_EFFECT = {
  mark: effect => typeof effect.chatId === 'string' && isStringList(effect.ids),
  record: effect => typeof effect.key === 'string' && ['noticed', 'attempting'].includes(effect.status) &&
    typeof effect.required === 'boolean',
  note: effect => typeof effect.key === 'string' && typeof effect.chatId === 'string' &&
    typeof effect.target === 'string' && ['message', 'direct'].includes(effect.wording),
}

// input.type 'scan' → { effects: [mark], stop: null | 'unreadable', need: [index] };
// 'plan' → { effects: [mark | record | note], keep: [key], compact }.
function leftoverStep(input) {
  const value = coreJson('leftover_step', input, 'decide the leftover notes')
  const effectsOk = (list, types) => Array.isArray(list) &&
    list.every(effect => isObject(effect) && types.includes(effect.type) && LEFTOVER_EFFECT[effect.type](effect))
  const ok = isObject(value) && (input?.type === 'scan'
    ? effectsOk(value.effects, ['mark']) && (value.stop === null || value.stop === 'unreadable') &&
      Array.isArray(value.need) && value.need.every(i => Number.isSafeInteger(i) && i >= 0 && i < input.sealed.length)
    : effectsOk(value.effects, ['mark', 'record', 'note']) && isStringList(value.keep) && typeof value.compact === 'boolean')
  if (!ok) throw new Error('SintBot binary core returned invalid leftover notes')
  return value
}

// The host keeps the warning by `change` alone and passes it back as
// `flagged`, so the two must tell the same story: each change names the state
// it leaves (and the one it starts from); `none` leaves it as it was.
const SHARED_CHANGE = { none: null, first: [false, false], raised: [false, true], still: [true, true], cleared: [true, false] }
const sharedChangeOk = (change, before, after) => Object.hasOwn(SHARED_CHANGE, change) &&
  (SHARED_CHANGE[change] ? SHARED_CHANGE[change][0] === before && SHARED_CHANGE[change][1] === after : after === before)

// One greeting's count of the app's connections against the host's own.
function sharedConnectionStep(input) {
  const value = coreJson('shared_connection_step', input, 'check the shared app connections')
  if (!isObject(value) || !['ok', 'wait', 'warn'].includes(value.verdict) ||
      !Number.isSafeInteger(value.streak) || value.streak < 0 || typeof value.flagged !== 'boolean' ||
      !sharedChangeOk(value.change, input?.flagged === true, value.flagged) ||
      !(value.others === null || Number.isFinite(value.others)) ||
      !Number.isFinite(value.recheckMs) || value.recheckMs < 0) {
    throw new Error('SintBot binary core returned an invalid shared connection check')
  }
  return value
}

// A trap or exhausted stack can leave the instance's own stack pointer wrong, and
// C1 calls hold no state, so the next call simply gets a fresh instance.
function guarded(fn) {
  return (...args) => {
    try {
      return fn(...args)
    } catch (error) {
      if (error instanceof WebAssembly.RuntimeError || error instanceof RangeError) boot()
      throw error
    }
  }
}

function followupCall(name, value) {
  let ptr = 0, size = 0
  try {
    ptr = callText(name, JSON.stringify(value))
    if (!ptr) throw new Error('Follow-up core rejected protocol state')
    size = new DataView(core.memory.buffer).getUint32(ptr, true) + 4
    return JSON.parse(decoder.decode(new Uint8Array(core.memory.buffer, ptr + 4, size - 4)))
  } finally {
    if (ptr && size) { new Uint8Array(core.memory.buffer).fill(0, ptr, ptr + size); core.dealloc(ptr, size) }
  }
}
function followupEnabled(group, runner) { return followupCall('followup_policy', { group, runner }) }
function claudeFollowupStep(state, event) { return followupCall('claude_followup_step', { state, event }) }

const entries = { followupEnabled, claudeFollowupStep, classifyError, routeBackend, sandboxTier, appErrorOverride, appNormalizeItem, appStreamTail, appNoticeAction, appDeltaNext, appLandedAction, appCompletionAction, appCompletionNoticeAction, manifestFeatures, manifestHeader, manifestContext, manifestSkills, manifestStyleBoard, manifestImagenAsset, manifestRuntime, manifestPolicy, systemAppendix, codexEffortRejection, wecomGatePrompt, imagenPrompt, turnPrompt, compactEvent, engineQueueStep, engineSlotsStep, engineTurnStep, engineSessionStep, engineHandoffStep, engineIntakeStep, engineLifecycleStep, engineTerminalStep, engineSteerStep, engineRecoveryStep, engineFailoverStep, parseResetFields, chooseResetEpoch, codexBuildPrompt, codexBuildArgs, appUsageFromTotal, settleUsage, appBuildRequest, claudeBaseSkillAllows, claudeBuildArgs, claudePluginAllowRules, claudeNormalizeEvent, codexNormalizeEvent, codexParseError, connectManifest, connectSlackManifest, connectPlan, connectConfig, qrMatrix, usageParse, envConflicts, idleCompactPlan, idleCompactSettle, leftoverStep, sharedConnectionStep }
for (const name of Object.keys(entries)) entries[name] = guarded(entries[name])


// ABI 39: scheduled tasks. The host keeps
// the task definitions and the fire ledger and tells the time; the core
// decides whether a due occurrence fires ("due"), what a turn started by a
// scheduled task may do ("turn") and how a finished occurrence reads
// ("result"). Malformed input is refused.
function scheduleStep(input) {
  const value = coreJson('schedule_step', input, 'decide a scheduled task step')
  const type = input && input.type
  const ok = isObject(value) && (
    type === 'due' ? ['fire', 'skip'].includes(value.decision) &&
      (value.reason === null || typeof value.reason === 'string') &&
      typeof value.record === 'boolean' && typeof value.retire === 'boolean'
    : type === 'turn' ? typeof value.followups === 'boolean' &&
      (value.speed === null || ['fast', 'standard'].includes(value.speed))
    : type === 'result' ? ['ok', 'failed', 'unknown', 'skipped'].includes(value.status) && value.retry === false
    : false)
  if (!ok) throw new Error('SintBot binary core returned an invalid schedule decision')
  return value
}

// ABI 40: unfinished turns. The host reports what it saw when a start failed
// before the executor began ("prestart") or when a turn a crash cut off is
// still running at the next start ("restart"); the core decides whether the
// turn is closed with one notice or held as unknown, and writes the notice.
// Nothing it answers grants a retry. Malformed input is refused.
const UNFINISHED_PRESTART = ['not-started', 'unknown']
const UNFINISHED_RESTART = ['interrupted', 'hold']
function unfinishedStep(input) {
  const value = coreJson('unfinished_step', input, 'decide an unfinished turn')
  const type = input && input.type
  const closes = type === 'prestart' ? value?.decision === 'not-started' : value?.decision === 'interrupted'
  const ok = isObject(value) && typeof value.reason === 'string' && value.reason !== '' &&
    (type === 'prestart' ? UNFINISHED_PRESTART.includes(value.decision) && typeof value.resetSession === 'boolean'
      : type === 'restart' ? UNFINISHED_RESTART.includes(value.decision) : false) &&
    // A closing answer always carries its notice; a hold or an unknown never does.
    (closes ? typeof value.notice === 'string' && value.notice.trim() !== '' : value.notice === null)
  if (!ok) throw new Error('SintBot binary core returned an invalid unfinished-turn decision')
  return value
}

module.exports = { ...entries, scheduleStep: guarded(scheduleStep), unfinishedStep: guarded(unfinishedStep), engineStep, resetBinaryCore, HUMAN_BY_KIND: HUMAN, slackManifestShapeOk }
