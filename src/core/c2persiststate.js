'use strict'

const { isDeepStrictEqual } = require('node:util')

// This is a fail-closed disk projection for the prospective C2 v2 state.
// It is not a general JSON serializer. Adding a reducer field or lane needs
// an explicit privacy review here before that state can be committed.
const MAX_STATE_BYTES = 1024 * 1024
const MAX_SCOPES = 128
const MAX_QUEUE = 1024
const MAX_MESSAGES = 256
const MAX_LATE_REPORTS = 64
const SAFE_INTEGER = Number.MAX_SAFE_INTEGER
const HEX_RECEIPT = /^[0-9a-f]{32}$/
const HEX_DIGEST = /^[0-9a-f]{64}$/
const JOB_ID = /^receipt:job:([0-9a-f]{32})$/
const MEMBER_ID = /^receipt:member:([0-9a-f]{32})$/
const SOURCE_ID = /^[A-Za-z0-9_-]{1,128}$/
const MESSAGE_ID = /^(?:om_[A-Za-z0-9_-]{1,124}|[0-9a-f]{32})$/
const EVENT_ID = /^[A-Za-z0-9:_-]{1,256}$/
const TEXT_HANDLE = /^sbot-c2-text-v1:[0-9a-f]{32}$/

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Object.getOwnPropertySymbols(value).length ||
      Object.values(Object.getOwnPropertyDescriptors(value)).some(d => !Object.hasOwn(d, 'value') || !d.enumerable)) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  return value
}

function fields(value, names, label, { optional = [] } = {}) {
  plain(value, label)
  const allowed = new Set([...names, ...optional])
  if (Object.keys(value).some(key => !allowed.has(key)) || names.some(key => !Object.hasOwn(value, key))) {
    throw new TypeError(`${label} fields invalid`)
  }
  return value
}

function integer(value, label, { positive = false } = {}) {
  if (!Number.isSafeInteger(value) || value < (positive ? 1 : 0)) throw new TypeError(`${label} invalid`)
  return value
}

function bool(value, label) {
  if (typeof value !== 'boolean') throw new TypeError(`${label} invalid`)
  return value
}

function token(value, pattern, label) {
  if (typeof value !== 'string' || !pattern.test(value)) throw new TypeError(`${label} invalid`)
  return value
}

function nullable(value, validate) { return value === null ? null : validate(value) }

function boundedArray(value, max, label) {
  if (!Array.isArray(value) || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      !Array.from({ length: value.length }, (_, index) =>
        Object.getOwnPropertyDescriptor(value, index)).every(d => d && Object.hasOwn(d, 'value') && d.enumerable)) {
    throw new TypeError(`${label} invalid`)
  }
  return value
}

function unique(values, label) {
  if (new Set(values).size !== values.length) throw new TypeError(`${label} has duplicate IDs`)
  return values
}

function queueLane(raw) {
  fields(raw, ['queue'], 'queue lane')
  const ids = []
  const queue = boundedArray(raw.queue, MAX_QUEUE, 'queue').map((job) => {
    fields(job, ['id', 'quiet', 'polled', 'synthetic', 'wantsAck', 'resetSessionAfter',
      'emptyRetried', 'freshRetried', 'firstResumed', 'failedOver'], 'queue job', { optional: ['batch'] })
    const out = { id: token(job.id, JOB_ID, 'queue job ID') }
    ids.push(out.id)
    for (const key of ['quiet', 'polled', 'synthetic', 'wantsAck', 'resetSessionAfter',
      'emptyRetried', 'freshRetried', 'firstResumed', 'failedOver']) out[key] = bool(job[key], `queue ${key}`)
    if (Object.hasOwn(job, 'batch')) {
      out.batch = boundedArray(job.batch, MAX_MESSAGES, 'queue batch').map((member) => {
        fields(member, ['id', 'synthetic', 'wantsAck', 'resetSessionAfter'], 'queue member')
        const id = token(member.id, MEMBER_ID, 'queue member ID')
        ids.push(id)
        return { id, synthetic: bool(member.synthetic, 'member synthetic'),
          wantsAck: bool(member.wantsAck, 'member wantsAck'),
          resetSessionAfter: bool(member.resetSessionAfter, 'member resetSessionAfter') }
      })
    }
    return out
  })
  unique(ids, 'queue')
  return { queue }
}

function lifecycleLane(raw) {
  const names = ['turnId', 'busy', 'forceReleaseAvailable', 'controller', 'reported', 'settled',
    'released', 'hardTimerArmed', 'stopRequested', 'recalled', 'interrupt',
    'turnTextHandle', 'msgIds', 'cancelled', 'lateReports']
  fields(raw, [], 'lifecycle lane', { optional: names })
  const out = {}
  for (const key of names) {
    if (!Object.hasOwn(raw, key)) continue
    if (key === 'turnId') out[key] = nullable(raw[key], v => integer(v, 'turn ID'))
    else if (key === 'turnTextHandle') out[key] = token(raw[key], TEXT_HANDLE, 'turn text handle')
    else if (key === 'msgIds') {
      out[key] = nullable(raw[key], v => unique(boundedArray(v, MAX_MESSAGES, 'message IDs')
        .map(id => token(id, MESSAGE_ID, 'message ID')), 'message IDs'))
    } else if (key === 'cancelled') {
      out[key] = nullable(raw[key], v => {
        fields(v, ['how', 'turnTextHandle'], 'cancellation')
        if (!['/stop', '/skip', '控制台停止', '发送者撤回了消息'].includes(v.how)) {
          throw new TypeError('cancellation reason invalid')
        }
        return { how: v.how, turnTextHandle: token(v.turnTextHandle, TEXT_HANDLE, 'cancellation handle') }
      })
    } else if (key === 'lateReports') {
      plain(raw[key], 'late reports')
      const entries = Object.entries(raw[key])
      if (entries.length > MAX_LATE_REPORTS) throw new TypeError('late reports too large')
      out[key] = Object.fromEntries(entries.sort(([a], [b]) => a.localeCompare(b)).map(([id, value]) => {
        if (!/^(0|[1-9][0-9]{0,15})$/.test(id) || Number(id) > SAFE_INTEGER || value !== true) {
          throw new TypeError('late report entry invalid')
        }
        return [id, true]
      }))
    } else out[key] = bool(raw[key], `lifecycle ${key}`)
  }
  if (out.busy && !out.turnTextHandle) throw new TypeError('busy lifecycle lacks text handle')
  return out
}

function turnLane(raw) {
  fields(raw, ['epoch', 'active'], 'turn lane')
  const epoch = integer(raw.epoch, 'turn epoch')
  const active = nullable(raw.active, v => integer(v, 'active turn', { positive: true }))
  if (active !== null && active !== epoch) throw new TypeError('active turn conflicts with epoch')
  return { epoch, active }
}

function terminalLane(raw) {
  fields(raw, ['finalized', 'outcome'], 'terminal lane',
    { optional: ['finalEventId', 'pendingEffectIds', 'batchReceiptIds',
      'replyTargetReceiptId', 'steerReceiptIds'] })
  const finalized = bool(raw.finalized, 'terminal finalized')
  if (!finalized) {
    if (raw.outcome !== null || Object.hasOwn(raw, 'finalEventId') ||
        Object.hasOwn(raw, 'pendingEffectIds') ||
        Object.hasOwn(raw, 'batchReceiptIds') ||
        Object.hasOwn(raw, 'replyTargetReceiptId') ||
        Object.hasOwn(raw, 'steerReceiptIds')) throw new TypeError('unfinalized terminal outcome invalid')
    return { finalized, outcome: null }
  }
  if (!Object.hasOwn(raw, 'finalEventId') || !Object.hasOwn(raw, 'pendingEffectIds')) {
    throw new TypeError('finalized terminal lacks effect identity')
  }
  const keys = ['status', 'silent', 'nothingProduced', 'sideEffects', 'sessionMissing',
    'lostRetry', 'network', 'quotaError', 'resumed']
  fields(raw.outcome, keys, 'terminal outcome')
  if (!['ok', 'no-reply', 'error', 'empty', 'stopped'].includes(raw.outcome.status)) {
    throw new TypeError('terminal status invalid')
  }
  const outcome = { status: raw.outcome.status }
  for (const key of keys.slice(1)) outcome[key] = bool(raw.outcome[key], `terminal ${key}`)
  const finalEventId = token(raw.finalEventId, EVENT_ID, 'terminal final event ID')
  const pendingEffectIds = boundedArray(raw.pendingEffectIds, 4, 'terminal pending effects')
    .map((effectId, index) => {
      const expected = `sbot-c2-effect-v1:${Buffer.byteLength(finalEventId)}:${finalEventId}:${index}`
      if (effectId !== expected) throw new TypeError('terminal effect ID mismatch')
      return effectId
    })
  const out = { finalized, outcome, finalEventId, pendingEffectIds }
  if (Object.hasOwn(raw, 'batchReceiptIds')) {
    const batch = unique(boundedArray(raw.batchReceiptIds, MAX_MESSAGES,
      'terminal batch receipts').map(id => token(id, HEX_RECEIPT,
      'terminal batch receipt ID')), 'terminal batch receipts')
    if (batch.length < 2) throw new TypeError('terminal batch receipts too small')
    out.batchReceiptIds = batch
    const target = token(raw.replyTargetReceiptId, HEX_RECEIPT,
      'terminal batch reply target')
    if (!batch.includes(target)) {
      throw new TypeError('terminal batch reply target is not a member')
    }
    out.replyTargetReceiptId = target
  } else if (Object.hasOwn(raw, 'replyTargetReceiptId')) {
    throw new TypeError('single receipt terminal has batch reply target')
  }
  if (Object.hasOwn(raw, 'steerReceiptIds')) {
    out.steerReceiptIds = unique(boundedArray(raw.steerReceiptIds, 32,
      'steer terminal receipts').map(id => token(id, HEX_RECEIPT, 'steer receipt')), 'steer receipts')
    if (!out.steerReceiptIds.length || out.steerReceiptIds.some(id => out.batchReceiptIds?.includes(id))) {
      throw new TypeError('steer terminal receipts invalid')
    }
  }
  return out
}

function steerLane(raw) {
  fields(raw, ['parentReceiptId', 'turnToken', 'generation', 'entries'], 'steer lane')
  const parentReceiptId = token(raw.parentReceiptId, HEX_RECEIPT, 'steer parent')
  const entries = boundedArray(raw.entries, 32, 'steer entries').map(entry => {
    fields(entry, ['receiptId', 'effectId', 'status'], 'steer entry')
    if (!['pending', 'accepted', 'landed'].includes(entry.status)) throw new TypeError('steer status invalid')
    if (entry.receiptId === parentReceiptId) throw new TypeError('steer repeats parent')
    return { receiptId: token(entry.receiptId, HEX_RECEIPT, 'steer receipt'),
      effectId: token(entry.effectId, /^sbot-c2-effect-v1:[0-9]+:[A-Za-z0-9:_-]+:0$/, 'steer effect'), status: entry.status }
  })
  if (!entries.length) throw new TypeError('empty steer lane')
  unique(entries.map(entry => entry.receiptId), 'steer receipts')
  unique(entries.map(entry => entry.effectId), 'steer effects')
  return { parentReceiptId, turnToken: integer(raw.turnToken, 'steer turn', { positive: true }),
    generation: token(raw.generation, HEX_RECEIPT, 'steer generation'), entries }
}

function handoffLane(raw) {
  fields(raw, ['phase', 'turnToken', 'attempt', 'acceptedReceiptIds', 'nextJobId'], 'handoff lane')
  if (!['idle', 'running', 'releasing', 'handoff', 'sealed'].includes(raw.phase)) {
    throw new TypeError('handoff phase invalid')
  }
  const turnToken = nullable(raw.turnToken, v => integer(v, 'handoff turn token', { positive: true }))
  const attempt = integer(raw.attempt, 'handoff attempt')
  if (attempt > 1) throw new TypeError('handoff attempt invalid')
  const acceptedReceiptIds = unique(boundedArray(raw.acceptedReceiptIds, 1024, 'accepted receipts')
    .map(id => token(id, HEX_RECEIPT, 'accepted receipt ID')), 'accepted receipts')
  // The handoff reducer carries the receipt token, while the queue lane
  // stores the same token behind the receipt:job: handle prefix.
  const nextJobId = nullable(raw.nextJobId, v => token(v, HEX_RECEIPT, 'next job ID'))
  if (raw.phase !== 'idle' && turnToken === null ||
      !['releasing', 'sealed', 'handoff', 'running'].includes(raw.phase) &&
        (attempt || acceptedReceiptIds.length) ||
      raw.phase === 'handoff' && (attempt || acceptedReceiptIds.length > MAX_MESSAGES ||
        acceptedReceiptIds.length && !acceptedReceiptIds.includes(nextJobId)) ||
      raw.phase === 'running' && (attempt ||
        acceptedReceiptIds.length === 1 || acceptedReceiptIds.length > MAX_MESSAGES) ||
      (raw.phase === 'handoff') !== (nextJobId !== null)) throw new TypeError('handoff fields conflict')
  return { phase: raw.phase, turnToken, attempt, acceptedReceiptIds, nextJobId }
}

function intakeLane(raw) {
  fields(raw, ['watermark', 'seen', 'unboundNotified', 'pending'], 'intake lane')
  const watermark = integer(raw.watermark, 'intake watermark')
  const seen = boundedArray(raw.seen, 8192, 'intake seen').map(item => {
    fields(item, ['key', 'at'], 'intake seen item')
    return { key: token(item.key, HEX_RECEIPT, 'intake key'),
      at: integer(item.at, 'intake seen time', { positive: true }) }
  })
  const keys = seen.map(item => item.key)
  unique(keys, 'intake seen')
  const pending = nullable(raw.pending, item => {
    fields(item, ['key', 'at', 'watermark'], 'intake pending')
    const value = { key: token(item.key, HEX_RECEIPT, 'intake pending key'),
      at: integer(item.at, 'intake pending time', { positive: true }),
      watermark: integer(item.watermark, 'intake pending watermark') }
    if (value.watermark < watermark) throw new TypeError('intake pending watermark regressed')
    return value
  })
  return { watermark, seen, unboundNotified: bool(raw.unboundNotified, 'intake unbound flag'), pending }
}

function sessionLane(raw) {
  fields(raw, ['epoch', 'closeSeen', 'settled'], 'session lane')
  const epoch = integer(raw.epoch, 'session epoch')
  const closeSeen = bool(raw.closeSeen, 'session close flag')
  const settled = bool(raw.settled, 'session settled flag')
  if (settled && !closeSeen) throw new TypeError('session settled before close')
  return { epoch, closeSeen, settled }
}

function stopIntentLane(raw) {
  fields(raw, ['phase', 'controlReceiptId', 'runningReceiptId', 'turnToken',
    'runnerGeneration'], 'stop intent lane', { optional: ['batchReceiptIds'] })
  if (raw.phase !== 'intent') throw new TypeError('stop intent phase invalid')
  const controlReceiptId = token(raw.controlReceiptId, HEX_RECEIPT, 'stop control receipt')
  const runningReceiptId = token(raw.runningReceiptId, HEX_RECEIPT, 'stop running receipt')
  if (controlReceiptId === runningReceiptId) throw new TypeError('stop receipts must differ')
  const batchReceiptIds = Object.hasOwn(raw, 'batchReceiptIds')
    ? unique(boundedArray(raw.batchReceiptIds, MAX_MESSAGES,
      'stop batch receipts').map(id => token(id, HEX_RECEIPT,
      'stop batch receipt')), 'stop batch receipts')
    : null
  if (batchReceiptIds && (batchReceiptIds.length < 2 ||
      !batchReceiptIds.includes(runningReceiptId) ||
      batchReceiptIds.includes(controlReceiptId))) {
    throw new TypeError('stop batch receipts invalid')
  }
  return { phase: 'intent', controlReceiptId, runningReceiptId,
    turnToken: integer(raw.turnToken, 'stop turn token', { positive: true }),
    runnerGeneration: token(raw.runnerGeneration, HEX_RECEIPT, 'stop runner generation'),
    ...(batchReceiptIds ? { batchReceiptIds } : {}) }
}

function cardCleanupLane(raw) {
  fields(raw, ['phase', 'receiptId', 'turnToken', 'runnerGeneration',
    'cardTargetDigest', 'deleteOperationId', 'cleanupEffectId',
    'cardOperations'], 'card cleanup lane')
  if (!['intent', 'acked'].includes(raw.phase)) {
    throw new TypeError('card cleanup phase invalid')
  }
  const receiptId = token(raw.receiptId, HEX_RECEIPT, 'card cleanup receipt')
  const turnToken = integer(raw.turnToken, 'card cleanup turn token', { positive: true })
  const runnerGeneration = token(raw.runnerGeneration, HEX_RECEIPT,
    'card cleanup generation')
  const cardTargetDigest = token(raw.cardTargetDigest, HEX_DIGEST,
    'card cleanup target digest')
  const deleteOperationId = token(raw.deleteOperationId, HEX_DIGEST,
    'card cleanup delete operation')
  const eventId = `sbot-c2-card-v1:${receiptId}:${turnToken}:${deleteOperationId}`
  const expectedEffectId = `sbot-c2-effect-v1:${Buffer.byteLength(eventId)}:${eventId}:0`
  if (raw.cleanupEffectId !== expectedEffectId) {
    throw new TypeError('card cleanup effect identity invalid')
  }
  return { phase: raw.phase, receiptId, turnToken, runnerGeneration,
    cardTargetDigest, deleteOperationId, cleanupEffectId: expectedEffectId,
    cardOperations: integer(raw.cardOperations, 'prior card operation count',
      { positive: true }) }
}

const LANE_VALIDATORS = Object.freeze({
  queue: queueLane,
  steer: steerLane,
  lifecycle: lifecycleLane,
  turn: turnLane,
  terminal: terminalLane,
  handoff: handoffLane,
  intake: intakeLane,
  session: sessionLane,
  stopIntent: stopIntentLane,
  cardCleanup: cardCleanupLane,
})

function projectPersistentState(state) {
  plain(state, 'C2 state')
  if (state.version !== 2) throw new TypeError('only C2 v2 state may be persisted')
  const seq = integer(state.seq, 'C2 cursor')
  fields(state, ['version', 'seq', 'lanes'], 'C2 state', { optional: seq ? ['lastEventId'] : [] })
  if (seq && !Object.hasOwn(state, 'lastEventId')) throw new TypeError('last event ID missing')
  const out = { version: 2, seq, lanes: {} }
  if (seq) out.lastEventId = token(state.lastEventId, EVENT_ID, 'last event ID')
  plain(state.lanes, 'C2 lanes')
  for (const domain of Object.keys(state.lanes).sort()) {
    const validator = LANE_VALIDATORS[domain]
    if (!validator) throw new TypeError(`C2 lane ${domain} is not approved for persistence`)
    const scopes = plain(state.lanes[domain], `${domain} scopes`)
    const entries = Object.entries(scopes)
    if (entries.length > MAX_SCOPES) throw new TypeError(`${domain} has too many scopes`)
    const result = {}
    for (const [scope, value] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      const key = token(scope, SOURCE_ID, `${domain} scope`)
      if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new TypeError('C2 scope invalid')
      result[key] = validator(value)
    }
    out.lanes[domain] = result
  }
  if (Buffer.byteLength(JSON.stringify(out)) > MAX_STATE_BYTES) throw new TypeError('C2 durable state too large')
  return out
}

function validatePersistentState(state) {
  const projected = projectPersistentState(state)
  if (!isDeepStrictEqual(state, projected)) throw new TypeError('C2 durable state is not canonical')
  return true
}

module.exports = { projectPersistentState, validatePersistentState }
