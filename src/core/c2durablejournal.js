'use strict'

// Development-only C2 authority. The daemon lock must be held by the caller.
// No Engine path uses this journal until state and receipt projections are wired.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { callbackRegistrationId } = require('./c2eventidentity')
const { validatePersistentReceipts } = require('./c2persistrelation')

const MAGIC = Buffer.from('SBOT-C2-JOURNAL-v1\n')
const FRAME_HEADER = 36 // uint32be payload length, then SHA-256 of payload
const MAX_RECORD_BYTES = 8 * 1024 * 1024
const MAX_CHECKPOINT_BYTES = 64 * 1024 * 1024
const MAX_CHECKPOINT_ITEMS = 1_000_000
const REGISTRATION_ID = /^sbot-c2-registration-v1:[0-9a-f]{64}$/
const RECEIPT_ID = /^[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const RUNNER_CLOSED_ID = /^sbot-c2-runner-closed-v1:[0-9a-f]{32}:[0-9a-f]{32}$/
const RUNNER_NOT_STARTED_ID = /^sbot-c2-runner-not-started-v1:[0-9a-f]{32}:[0-9a-f]{32}$/
const DESCRIPTOR_TYPES = Object.fromEntries(Object.entries({
  queue: 'dispatch dropQueued interruptMissingPayload recalledQueued queueNotice',
  lifecycle: 'turnStarted noActiveTask clearQueue abortController forceRelease continueBatch recallAccepted recordDone armHardTimer clearHardTimer releaseLock dequeue clearSession',
  recovery: 'enqueueFront freshSession sayFreshRetry sayEmpty markExhausted alertDown notifyNoTarget probeHome applyFailover notifySwitched',
  failover: 'clearExhausted markExhausted alertUp alertDown setPending clearPending applyFailover clearExhaustedHome notifyBack notifySwitched probeHome setProbing touchCheckedAt callProbe setPendingBack touchUntil logProbeError',
  intake: 'notifyOrphan sendUnboundGuide clearQueue handleCommand persistReceipt dispatch',
  slots: 'grant reject',
  session: 'writeSession markTainted resetSessionAndStats',
  steer: 'followupKind eligible acceptControl drainQueued callSteer enqueue pullForSteer relocateCard replyQueued propagateSteerError replySteered applyLanded markLandedRecalled forgetUnconfirmed enqueueFront clearControl',
  terminal: 'markTainted clearTainted clearExhausted verifyTurn finalReply quietCompletion',
  outbound: 'card.create message.reply message.create cardElement.content card.update card.settings message.delete',
  turn: 'turnToken effectAllowed',
  handoff: 'attemptQueueRelease retryQueueRelease sealGroup notifyAccepted holdHandoff scheduleDispatch clearHandoff dispatch',
  atomicHandoff: 'dispatch attemptQueueRelease clearHandoff dropQueued holdHandoff scheduleDispatch',
  control: 'stopAck',
}).map(([domain, types]) => [domain, new Set(types.split(' '))]))
const DESCRIPTOR_FIELDS = ['effectId', 'domain', 'scope', 'type', 'turnToken',
  'receiptId', 'targetId']
const REGISTRATION_FIELDS = new Set(['id', 'receiptId', 'generation', 'domain', 'kind',
  'ordinal', 'registeredAt'])

function id(value, name, max = 256) {
  if (typeof value !== 'string' || !value || Buffer.byteLength(value) > max) {
    throw new TypeError(`invalid C2 ${name}`)
  }
  return value
}

function effectDescriptor(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== DESCRIPTOR_FIELDS.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        !DESCRIPTOR_FIELDS.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('invalid C2 effect descriptor fields')
  }
  const copy = exactJson(value)
  id(copy.effectId, 'effect ID', 512)
  if (!Object.hasOwn(DESCRIPTOR_TYPES, copy.domain) ||
      typeof copy.scope !== 'string' || !/^[A-Za-z0-9:_-]{1,256}$/.test(copy.scope) ||
      !DESCRIPTOR_TYPES[copy.domain].has(copy.type) ||
      !(copy.turnToken === null || Number.isSafeInteger(copy.turnToken) && copy.turnToken > 0) ||
      !(copy.receiptId === null || typeof copy.receiptId === 'string' && RECEIPT_ID.test(copy.receiptId)) ||
      !(copy.targetId === null || typeof copy.targetId === 'string' &&
        (['queue', 'handoff', 'atomicHandoff'].includes(copy.domain) &&
          copy.type === 'dispatch' && copy.receiptId !== null &&
          (copy.targetId === copy.receiptId || copy.targetId === `receipt:job:${copy.receiptId}`) ||
          copy.domain === 'control' && copy.type === 'stopAck' &&
          copy.receiptId !== null && copy.targetId === `receipt:control:${copy.receiptId}`)) ||
      (copy.domain === 'control' &&
        (copy.type !== 'stopAck' || copy.turnToken !== null ||
          copy.receiptId === null || copy.targetId !== `receipt:control:${copy.receiptId}`)) ||
      (['terminal', 'outbound'].includes(copy.domain) &&
        (copy.domain !== 'terminal' || ['finalReply', 'quietCompletion'].includes(copy.type)) &&
        (copy.turnToken === null || copy.receiptId === null || copy.targetId !== null))) {
    throw new TypeError('invalid C2 effect descriptor identity')
  }
  return copy
}

function exactJson(value) {
  const bytes = JSON.stringify(value)
  if (typeof bytes !== 'string') throw new TypeError('C2 journal value is not JSON')
  const copy = JSON.parse(bytes)
  if (!isDeepStrictEqual(value, copy)) throw new TypeError('C2 journal value is not exact JSON')
  function check(item) {
    if (item && typeof item === 'object') {
      if (Object.hasOwn(item, '__proto__')) throw new TypeError('unsafe C2 journal key')
      for (const child of Object.values(item)) check(child)
    }
  }
  check(copy)
  return copy
}

function frame(record, maxBytes = MAX_RECORD_BYTES) {
  const payload = Buffer.from(JSON.stringify(record))
  if (!payload.length || payload.length > maxBytes) throw new RangeError('C2 journal record too large')
  const result = Buffer.allocUnsafe(FRAME_HEADER + payload.length)
  result.writeUInt32BE(payload.length, 0)
  createHash('sha256').update(payload).digest().copy(result, 4)
  payload.copy(result, FRAME_HEADER)
  return result
}

function identity(stat) { return `${stat.dev}:${stat.ino}` }

function writeAll(fd, bytes, position) {
  let written = 0
  while (written < bytes.length) {
    const size = fs.writeSync(fd, bytes, written, bytes.length - written, position + written)
    if (size <= 0) throw new Error('short C2 journal write')
    written += size
  }
}

function readAll(fd, bytes, position) {
  let read = 0
  while (read < bytes.length) {
    const size = fs.readSync(fd, bytes, read, bytes.length - read, position + read)
    if (size <= 0) throw new Error('short C2 journal read')
    read += size
  }
}

function validateSnapshots(record, validateState, validateReceipts, validateRelation) {
  const state = exactJson(record.state)
  const receipts = exactJson(record.receipts)
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      !receipts || typeof receipts !== 'object' || Array.isArray(receipts)) {
    throw new TypeError('C2 journal snapshots must be objects')
  }
  if (validateState(state) !== true || validateReceipts(receipts) !== true ||
      validateRelation(state, receipts) !== true) {
    throw new TypeError('C2 journal projection rejected')
  }
  return { state, receipts }
}

function validateReceiptProgress(before, after) {
  const oldPending = new Map(before.pending.map(item => [item.id, item]))
  const oldCompleted = new Map(before.completed.map(item => [item.id, item]))
  const newPending = new Map(after.pending.map(item => [item.id, item]))
  const newCompleted = new Map(after.completed.map(item => [item.id, item]))
  for (const [receiptId, item] of oldCompleted) {
    if (!isDeepStrictEqual(newCompleted.get(receiptId), item)) {
      throw new Error('C2 completed receipt cannot disappear or change')
    }
  }
  for (const [receiptId, item] of oldPending) {
    const current = newPending.get(receiptId)
    if (!current) {
      if (!newCompleted.has(receiptId)) throw new Error('C2 pending receipt cannot disappear')
      continue
    }
    const { notifiedAt: oldNotice, ...oldStable } = item
    const { notifiedAt: newNotice, ...newStable } = current
    if (!isDeepStrictEqual(oldStable, newStable) ||
        (oldNotice !== undefined && oldNotice !== newNotice)) {
      throw new Error('C2 pending receipt identity cannot change')
    }
  }
  for (const receiptId of newPending.keys()) {
    if (oldCompleted.has(receiptId)) throw new Error('C2 completed receipt cannot be reopened')
  }
  for (const receiptId of newCompleted.keys()) {
    if (!oldPending.has(receiptId) && !oldCompleted.has(receiptId)) {
      throw new Error('C2 receipt cannot complete without prior acceptance')
    }
  }
}

function validateRegistration(value, receipts, registrations) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== REGISTRATION_FIELDS.size ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !REGISTRATION_FIELDS.has(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('invalid C2 callback registration')
  }
  const registration = exactJson(value)
  if (registration.id !== callbackRegistrationId(registration) ||
      !Number.isSafeInteger(registration.registeredAt) || registration.registeredAt <= 0 ||
      registrations.has(registration.id)) {
    throw new Error('invalid or duplicate C2 callback registration')
  }
  const receipt = receipts.pending.find(item => item.id === registration.receiptId)
  if (!receipt) throw new Error('C2 callback registration requires matching pending receipt')
  validatePersistentReceipts({ pending: [receipt], completed: [] })
  if (/^local:/i.test(receipt.sourceId) || Buffer.byteLength(receipt.sourceId) > 256 ||
      Buffer.byteLength(receipt.chatId) > 256) {
    throw new Error('C2 callback registration requires durable source receipt')
  }
  return registration
}

function noticeFields(value, names) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== names.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !names.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError('invalid C2 notice fields')
  }
  return value
}

function noticeIdentity(receiptId, chatId) {
  if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId) ||
      typeof chatId !== 'string' || !chatId || Buffer.byteLength(chatId) > 256) {
    throw new TypeError('invalid C2 notice target')
  }
}

function noticeTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('invalid C2 notice time')
}

function runnerClosedId(receiptId, generation) {
  if (!RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '')) {
    throw new TypeError('invalid C2 runner closure identity')
  }
  return `sbot-c2-runner-closed-v1:${receiptId}:${generation}`
}

function runnerNotStartedId(receiptId, generation) {
  if (!RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '')) {
    throw new TypeError('invalid C2 runner not-started identity')
  }
  return `sbot-c2-runner-not-started-v1:${receiptId}:${generation}`
}

function completedReceipt(receipts, receiptId, settledAt) {
  return { pending: receipts.pending.filter(item => item.id !== receiptId),
    completed: [...receipts.completed, { id: receiptId, settledAt }] }
}

function completedBatch(receipts, receiptIds, settledAt) {
  const ids = new Set(receiptIds)
  return { pending: receipts.pending.filter(item => !ids.has(item.id)),
    completed: [...receipts.completed,
      ...receiptIds.map(id => ({ id, settledAt }))] }
}

function terminalEffectForReceipt(descriptors, receiptId) {
  return [...descriptors.values()].some(item =>
    (item.domain === 'terminal' && ['finalReply', 'quietCompletion'].includes(item.type) ||
      item.domain === 'control' && item.type === 'stopAck') &&
    item.receiptId === receiptId)
}

function terminalBatchOwnsReceipt(state, receiptId) {
  return Object.values(state.lanes.terminal || {}).some(lane =>
    lane.finalized === true && lane.batchReceiptIds?.includes(receiptId))
}

function validateStopAckAuthority(state, receipts, effects, descriptors, attempts) {
  for (const descriptor of descriptors.values()) {
    if (descriptor.domain !== 'control' || descriptor.type !== 'stopAck') continue
    const status = effects.get(descriptor.effectId)
    const pending = receipts.pending.find(item => item.id === descriptor.receiptId)
    const completed = receipts.completed.some(item => item.id === descriptor.receiptId)
    if (descriptor.targetId !== `receipt:control:${descriptor.receiptId}` ||
        descriptor.turnToken !== null ||
        (status === 'acked' ? !completed || pending || !attempts.has(descriptor.effectId) :
          !pending || completed || pending.chatId !== descriptor.scope ||
          pending.source !== 'message' || pending.quiet ||
          state.lanes.stopIntent?.[descriptor.scope] !== undefined)) {
      throw new Error('C2 stop acknowledgement lacks exact durable receipt authority')
    }
  }
}

function stopAckAttemptAllowed(state, receipts, descriptor) {
  if (descriptor?.domain !== 'control' || descriptor.type !== 'stopAck') return true
  const receipt = receipts.pending.find(item => item.id === descriptor.receiptId)
  return !!receipt && receipt.chatId === descriptor.scope &&
    receipt.source === 'message' && receipt.quiet === false &&
    descriptor.targetId === `receipt:control:${receipt.id}` &&
    state.lanes.stopIntent?.[descriptor.scope] === undefined &&
    state.lanes.turn?.[descriptor.scope]?.active == null &&
    state.lanes.handoff?.[descriptor.scope]?.phase === 'idle' &&
    (state.lanes.queue?.[descriptor.scope]?.queue?.length ?? 0) === 0
}

function stopAckSettlementCandidate(record, authority, requireLocal) {
  const { state, receipts, effects, attempts, descriptors, notices, local,
    validateState, validateReceipts, validateRelation } = authority
  if (Object.keys(record).sort().join(',') !==
      'chatId,cursor,effectId,kind,receiptId,settledAt' ||
      record.kind !== 'stopAckSettlement' || record.cursor !== state.seq) {
    throw new Error('invalid C2 stop acknowledgement settlement')
  }
  id(record.effectId, 'effect ID', 512)
  noticeIdentity(record.receiptId, record.chatId)
  noticeTime(record.settledAt)
  const descriptor = descriptors.get(record.effectId)
  const receipt = receipts.pending.find(item => item.id === record.receiptId)
  if (!descriptor || descriptor.domain !== 'control' || descriptor.type !== 'stopAck' ||
      descriptor.scope !== record.chatId || descriptor.receiptId !== record.receiptId ||
      descriptor.targetId !== `receipt:control:${record.receiptId}` ||
      descriptor.turnToken !== null || !receipt || receipt.chatId !== record.chatId ||
      receipt.source !== 'message' || receipt.quiet || notices.has(record.receiptId) ||
      effects.get(record.effectId) !== 'attempting' ||
      !attempts.has(record.effectId) || record.settledAt < attempts.get(record.effectId) ||
      requireLocal && !local.has(record.effectId) ||
      !stopAckAttemptAllowed(state, receipts, descriptor)) {
    throw new Error('C2 stop acknowledgement lacks confirmed local attempt')
  }
  const candidate = completedReceipt(receipts, record.receiptId, record.settledAt)
  validateSnapshots({ state, receipts: candidate }, validateState,
    validateReceipts, validateRelation)
  validateReceiptProgress(receipts, candidate)
  return candidate
}

function terminalAttemptAllowed(state, receipts, effects, descriptor) {
  if (descriptor?.domain !== 'terminal' || descriptor.type !== 'finalReply') return true
  const receipt = receipts.pending.find(item => item.id === descriptor.receiptId)
  const handoff = state.lanes.handoff?.[descriptor.scope]
  const lane = state.lanes.terminal?.[descriptor.scope]
  return !!receipt && receipt.chatId === descriptor.scope && !receipt.quiet &&
    lane?.finalized === true && lane.outcome?.silent === false &&
    lane.pendingEffectIds?.at(-1) === descriptor.effectId &&
    lane.pendingEffectIds.slice(0, -1).every(id => effects.get(id) === 'acked') &&
    state.lanes.turn?.[descriptor.scope]?.active === descriptor.turnToken &&
    handoff?.phase === 'running' && handoff.turnToken === descriptor.turnToken
}

function queueNoticeAttemptAllowed(state, receipts, descriptor) {
  if (descriptor?.domain !== 'queue' || descriptor.type !== 'queueNotice') return true
  const receipt = receipts.pending.find(item => item.id === descriptor.receiptId)
  const queue = state.lanes.queue?.[descriptor.scope]?.queue
  const turn = state.lanes.turn?.[descriptor.scope]
  const handoff = state.lanes.handoff?.[descriptor.scope]
  return !!receipt && receipt.chatId === descriptor.scope &&
    receipt.source === 'message' && receipt.quiet === false &&
    descriptor.targetId === null && descriptor.turnToken === null &&
    Array.isArray(queue) && queue.some(item =>
      item.id === `receipt:job:${receipt.id}` && item.quiet === false &&
      item.polled === false && item.batch === undefined) &&
    Number.isSafeInteger(turn?.active) && turn.active > 0 &&
    handoff?.phase === 'running' && handoff.turnToken === turn.active
}

function runnerAcceptanceAuthority(effectId, registrationId, authority,
  { effectStatus = 'acked', requireRunning = true } = {}) {
  const { state, receipts, effects, attempts, descriptors, registrations } = authority
  id(effectId, 'effect ID', 512)
  if (typeof registrationId !== 'string' || !REGISTRATION_ID.test(registrationId)) {
    throw new TypeError('invalid C2 runner acceptance registration')
  }
  const descriptor = descriptors.get(effectId)
  const registration = registrations.get(registrationId)
  const receipt = [...receipts.pending, ...receipts.completed]
    .find(item => item.id === descriptor?.receiptId)
  if (effects.get(effectId) !== effectStatus || !attempts.has(effectId) ||
      descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
      !RECEIPT_ID.test(descriptor.receiptId || '') ||
      !Number.isSafeInteger(descriptor.turnToken) || descriptor.turnToken <= 0 ||
      !receipt || (receipt.chatId !== undefined && receipt.chatId !== descriptor.scope) ||
      registration?.receiptId !== descriptor.receiptId ||
      registration.domain !== 'atomicHandoff' || registration.kind !== 'runnerAccepted' ||
      registration.ordinal !== 0 ||
      registration.registeredAt > attempts.get(effectId) ||
      (requireRunning && (state.lanes.turn?.[descriptor.scope]?.active !== descriptor.turnToken ||
        state.lanes.handoff?.[descriptor.scope]?.phase !== 'running' ||
        state.lanes.handoff[descriptor.scope].turnToken !== descriptor.turnToken ||
        !receipts.pending.some(item => item.id === descriptor.receiptId &&
          item.chatId === descriptor.scope)))) {
    throw new Error('C2 runner acceptance lacks exact durable dispatch')
  }
  return { descriptor, registration }
}

function runnerClosureCandidate(record, authority, requireRunning = true) {
  if (Object.keys(record).sort().join(',') !==
      'chatId,closedAt,cursor,dispatchEffectId,evidenceId,generation,kind,receiptId,turnToken' ||
      record.kind !== 'runnerClosed' || record.cursor !== authority.state.seq ||
      record.evidenceId !== runnerClosedId(record.receiptId, record.generation) ||
      typeof record.chatId !== 'string' || !record.chatId ||
      !Number.isSafeInteger(record.turnToken) || record.turnToken <= 0 ||
      authority.closures.has(record.evidenceId)) {
    throw new Error('invalid C2 runner closure record')
  }
  noticeTime(record.closedAt)
  const registrationId = authority.acceptances.get(record.dispatchEffectId)
  const { descriptor, registration } = runnerAcceptanceAuthority(
    record.dispatchEffectId, registrationId, authority, { requireRunning })
  if (descriptor.receiptId !== record.receiptId || descriptor.scope !== record.chatId ||
      descriptor.turnToken !== record.turnToken ||
      registration.generation !== record.generation ||
      record.closedAt < authority.attempts.get(record.dispatchEffectId)) {
    throw new Error('C2 runner closure differs from accepted dispatch')
  }
  return { receiptId: record.receiptId, chatId: record.chatId,
    turnToken: record.turnToken, generation: record.generation,
    dispatchEffectId: record.dispatchEffectId, closedAt: record.closedAt }
}

function runnerNotStartedCandidate(record, authority, requireRunning = true) {
  if (Object.keys(record).sort().join(',') !==
      'chatId,cursor,dispatchEffectId,evidenceId,generation,kind,receiptId,resolvedAt,turnToken' ||
      record.kind !== 'runnerNotStarted' || record.cursor !== authority.state.seq ||
      record.evidenceId !== runnerNotStartedId(record.receiptId, record.generation) ||
      typeof record.chatId !== 'string' || !record.chatId ||
      !Number.isSafeInteger(record.turnToken) || record.turnToken <= 0 ||
      authority.notStarts.has(record.evidenceId)) {
    throw new Error('invalid C2 runner not-started record')
  }
  noticeTime(record.resolvedAt)
  const descriptor = authority.descriptors.get(record.dispatchEffectId)
  const registrationId = callbackRegistrationId({ receiptId: record.receiptId,
    generation: record.generation, domain: 'atomicHandoff', kind: 'runnerAccepted' })
  const registration = authority.registrations.get(registrationId)
  if (authority.effects.get(record.dispatchEffectId) !== (requireRunning ? 'attempting' : 'notStarted') ||
      !authority.attempts.has(record.dispatchEffectId) ||
      record.resolvedAt < authority.attempts.get(record.dispatchEffectId) ||
      descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
      descriptor.scope !== record.chatId || descriptor.receiptId !== record.receiptId ||
      descriptor.turnToken !== record.turnToken ||
      registration?.receiptId !== record.receiptId ||
      registration.generation !== record.generation ||
      registration.domain !== 'atomicHandoff' || registration.kind !== 'runnerAccepted' ||
      registration.ordinal !== 0 ||
      registration.registeredAt > authority.attempts.get(record.dispatchEffectId) ||
      authority.acceptances.has(record.dispatchEffectId) ||
      [...authority.closures.values()].some(item => item.dispatchEffectId === record.dispatchEffectId) ||
      !(requireRunning ? authority.receipts.pending :
        [...authority.receipts.pending, ...authority.receipts.completed])
        .some(item => item.id === record.receiptId &&
          (item.chatId === undefined || item.chatId === record.chatId))) {
    throw new Error('C2 runner not-started proof differs from dispatch')
  }
  if (requireRunning) {
    const turn = authority.state.lanes.turn?.[record.chatId]
    const handoff = authority.state.lanes.handoff?.[record.chatId]
    if (turn?.epoch !== record.turnToken || turn.active !== record.turnToken ||
        handoff?.phase !== 'running' || handoff.turnToken !== record.turnToken ||
        handoff.attempt !== 0 || handoff.nextJobId !== null ||
        !Array.isArray(handoff.acceptedReceiptIds) || handoff.acceptedReceiptIds.length ||
        ['terminal', 'session', 'outbound', 'cardCleanup', 'stopIntent']
          .some(domain => Object.hasOwn(authority.state.lanes[domain] || {}, record.chatId))) {
      throw new Error('C2 runner not-started proof has active side effects')
    }
  }
  return { receiptId: record.receiptId, chatId: record.chatId,
    turnToken: record.turnToken, generation: record.generation,
    dispatchEffectId: record.dispatchEffectId, resolvedAt: record.resolvedAt }
}

function terminalSettlementCandidate(record, authority, requireLocal) {
  const { state, receipts, effects, attempts, descriptors, notices, local,
    validateState, validateReceipts, validateRelation } = authority
  const batchRecord = Object.hasOwn(record, 'batchReceiptIds')
  const steerRecord = Object.hasOwn(record, 'steerReceiptIds')
  if (Object.keys(record).filter(key => key !== 'steerReceiptIds').sort().join(',') !==
      (batchRecord
        ? 'batchReceiptIds,chatId,cursor,effectId,kind,receiptId,settledAt,status,turnToken'
        : 'chatId,cursor,effectId,kind,receiptId,settledAt,status,turnToken') ||
      record.kind !== 'terminalSettlement' || record.status !== 'acked' ||
      record.cursor !== state.seq) throw new Error('invalid C2 terminal settlement record')
  id(record.effectId, 'effect ID', 512)
  noticeIdentity(record.receiptId, record.chatId)
  noticeTime(record.settledAt)
  if (!Number.isSafeInteger(record.turnToken) || record.turnToken <= 0) {
    throw new Error('invalid C2 terminal settlement turn token')
  }
  const descriptor = descriptors.get(record.effectId)
  const receipt = receipts.pending.find(item => item.id === record.receiptId)
  const lane = state.lanes.terminal?.[record.chatId]
  const handoff = state.lanes.handoff?.[record.chatId]
  const receiptIds = lane?.batchReceiptIds || [record.receiptId]
  if (batchRecord !== !!lane?.batchReceiptIds ||
      !Array.isArray(receiptIds) || !receiptIds.length ||
      new Set(receiptIds).size !== receiptIds.length ||
      !receiptIds.includes(record.receiptId) ||
      lane?.replyTargetReceiptId !== undefined &&
        lane.replyTargetReceiptId !== record.receiptId ||
      batchRecord && !isDeepStrictEqual(record.batchReceiptIds, receiptIds) ||
      receiptIds.some(id => !RECEIPT_ID.test(id) ||
        receipts.pending.find(item => item.id === id)?.chatId !== record.chatId ||
        notices.has(id))) {
    throw new Error('C2 terminal batch settlement receipt authority invalid')
  }
  if (!descriptor || descriptor.domain !== 'terminal' ||
      !['finalReply', 'quietCompletion'].includes(descriptor.type) ||
      descriptor.scope !== record.chatId ||
      descriptor.turnToken !== record.turnToken ||
      descriptor.receiptId !== record.receiptId || descriptor.targetId !== null ||
      !receipt || receipt.chatId !== record.chatId || notices.has(record.receiptId) ||
      !lane || lane.finalized !== true || !Array.isArray(lane.pendingEffectIds) ||
      lane.pendingEffectIds.at(-1) !== record.effectId ||
      !lane.pendingEffectIds.slice(0, -1).every(effectId => effects.get(effectId) === 'acked') ||
      state.lanes.turn?.[record.chatId]?.active !== null ||
      !handoff || !['idle', 'handoff'].includes(handoff.phase) ||
      handoff.turnToken !== record.turnToken ||
      handoff.nextJobId === record.receiptId ||
      handoff.acceptedReceiptIds?.includes(record.receiptId)) {
    throw new Error('C2 terminal settlement lacks released effect and receipt authority')
  }
  const shouldQuiet = receipt.quiet || lane.outcome?.silent === true
  if (descriptor.type === 'quietCompletion' ?
      !shouldQuiet || effects.get(record.effectId) !== 'pending' ||
        attempts.has(record.effectId) :
      shouldQuiet || effects.get(record.effectId) !== 'attempting' ||
        !attempts.has(record.effectId) ||
        record.settledAt < attempts.get(record.effectId) ||
        requireLocal && !local.has(record.effectId)) {
    throw new Error('C2 terminal settlement effect attempt invalid')
  }
  const steered = lane.steerReceiptIds || []
  if (steerRecord !== !!lane.steerReceiptIds || steerRecord && !isDeepStrictEqual(record.steerReceiptIds, steered) ||
      steered.some(id => receiptIds.includes(id) || notices.has(id) ||
        receipts.pending.find(item => item.id === id)?.chatId !== record.chatId ||
        ![...descriptors.values()].some(effect => effect.domain === 'steer' && effect.type === 'callSteer' &&
          effect.scope === record.chatId && effect.turnToken === record.turnToken && effect.receiptId === id &&
          effects.get(effect.effectId) === 'acked'))) throw new Error('terminal steer settlement invalid')
  const candidate = completedBatch(receipts, [...receiptIds, ...steered], record.settledAt)
  validateSnapshots({ state, receipts: candidate }, validateState, validateReceipts,
    validateRelation)
  validateReceiptProgress(receipts, candidate)
  return candidate
}

class C2DurableJournal {
  #file
  #validateState
  #validateReceipts
  #validateRelation
  #cursor = 0
  #state
  #receipts
  #eventIds = new Set()
  #effects = new Map()
  #effectAttempts = new Map()
  #effectDescriptors = new Map()
  #terminalSettlements = new Map()
  #registrations = new Map()
  #runnerAcceptances = new Map()
  #runnerClosures = new Map()
  #runnerNotStarts = new Map()
  #notices = new Map()
  // Only the process that durably began a notice may confirm its ACK. A
  // restarted process sees an attempt as ambiguous and must never resend it.
  #localNoticeIntents = new Set()
  // An effect ACK belongs only to the process that fsynced its attempt.
  #localEffectIntents = new Set()
  #offset = 0
  #fileIdentity = null
  #blocked = false

  constructor(file, { validateState, validateReceipts, validateRelation } = {}) {
    if (typeof file !== 'string' || !path.isAbsolute(file) ||
        typeof validateState !== 'function' || typeof validateReceipts !== 'function' ||
        typeof validateRelation !== 'function') {
      throw new TypeError('C2 journal needs an absolute file and strict projection validators')
    }
    this.#file = file
    this.#validateState = validateState
    this.#validateReceipts = validateReceipts
    this.#validateRelation = validateRelation
  }

  // Explicit install/migration step only. Opening an absent journal never
  // initializes an empty authority or silently adopts an older checkpoint.
  static initialize(file, { state, receipts }, options) {
    const journal = new C2DurableJournal(file, options)
    const snapshots = validateSnapshots({ state, receipts }, journal.#validateState,
      journal.#validateReceipts, journal.#validateRelation)
    if (snapshots.state.seq !== 0) throw new TypeError('C2 journal genesis must have cursor zero')
    const genesis = frame({ kind: 'genesis', ...snapshots })
    const fd = fs.openSync(file, 'wx', 0o600)
    try {
      writeAll(fd, MAGIC, 0)
      writeAll(fd, genesis, MAGIC.length)
      fs.fsyncSync(fd)
      const dirFd = fs.openSync(path.dirname(file), 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } finally { fs.closeSync(fd) }
    return C2DurableJournal.open(file, options)
  }

  static open(file, options) {
    const journal = new C2DurableJournal(file, options)
    journal.#replay()
    return journal
  }

  get blocked() { return this.#blocked }
  get cursor() { return this.#cursor }
  get byteLength() { return this.#offset }
  hasEvent(eventId) { return this.#eventIds.has(id(eventId, 'event ID')) }
  effectStatus(effectId) { return this.#effects.get(id(effectId, 'effect ID', 512)) ?? null }
  effectDescriptor(effectId) {
    const value = this.#effectDescriptors.get(id(effectId, 'effect ID', 512))
    return value ? structuredClone(value) : null
  }
  terminalSettlement(effectId) {
    const value = this.#terminalSettlements.get(id(effectId, 'effect ID', 512))
    return value ? { effectId, ...structuredClone(value) } : null
  }
  noticeStatus(receiptId) {
    if (typeof receiptId !== 'string' || !RECEIPT_ID.test(receiptId)) {
      throw new TypeError('invalid C2 notice receipt ID')
    }
    return this.#notices.get(receiptId)?.status ?? null
  }
  lookupRegistration(registrationId) {
    if (typeof registrationId !== 'string' || !REGISTRATION_ID.test(registrationId)) {
      throw new TypeError('invalid C2 callback registration ID')
    }
    const registration = this.#registrations.get(registrationId)
    return registration ? structuredClone(registration) : null
  }
  lookupRunnerClosed(evidenceId) {
    if (typeof evidenceId !== 'string' || !RUNNER_CLOSED_ID.test(evidenceId)) {
      throw new TypeError('invalid C2 runner closure evidence ID')
    }
    const proof = this.#runnerClosures.get(evidenceId)
    return proof ? { evidenceId, ...structuredClone(proof) } : null
  }
  runnerClosedProofs() {
    return [...this.#runnerClosures].map(([evidenceId, proof]) =>
      ({ evidenceId, ...structuredClone(proof) }))
  }
  lookupRunnerNotStarted(evidenceId) {
    if (typeof evidenceId !== 'string' || !RUNNER_NOT_STARTED_ID.test(evidenceId)) {
      throw new TypeError('invalid C2 runner not-started evidence ID')
    }
    const proof = this.#runnerNotStarts.get(evidenceId)
    return proof ? { evidenceId, ...structuredClone(proof) } : null
  }
  runnerNotStartedProofs() {
    return [...this.#runnerNotStarts].map(([evidenceId, proof]) =>
      ({ evidenceId, ...structuredClone(proof) }))
  }
  snapshot() {
    return { cursor: this.#cursor, state: structuredClone(this.#state),
      receipts: structuredClone(this.#receipts), eventCount: this.#eventIds.size,
      effects: new Map(this.#effects), notices: new Map(this.#notices) }
  }

  // Bounded diagnostics: the console must not clone all effects and history
  // at progress-event frequency. This is never accepted as recovery authority.
  consoleSnapshot() {
    return { cursor: this.#cursor, state: { lanes: {
      queue: structuredClone(this.#state.lanes?.queue || {}),
      stopIntent: structuredClone(this.#state.lanes?.stopIntent || {}) } },
      receipts: { pending: structuredClone(this.#receipts.pending),
        completed: structuredClone(this.#receipts.completed.slice(-30)) } }
  }

  #settlementAuthority() {
    return { state: this.#state, receipts: this.#receipts, effects: this.#effects,
      attempts: this.#effectAttempts, descriptors: this.#effectDescriptors,
      notices: this.#notices, local: this.#localEffectIntents,
      validateState: this.#validateState, validateReceipts: this.#validateReceipts,
      validateRelation: this.#validateRelation }
  }

  #runnerAuthority() {
    return { state: this.#state, receipts: this.#receipts,
      effects: this.#effects, attempts: this.#effectAttempts,
      descriptors: this.#effectDescriptors, registrations: this.#registrations,
      acceptances: this.#runnerAcceptances, closures: this.#runnerClosures }
  }

  #notStartedAuthority() {
    return { ...this.#runnerAuthority(), notStarts: this.#runnerNotStarts }
  }

  appendTransition({ eventId, before, after, state, receipts, effectIds = [], effectDescriptors }) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    if ([...this.#notices.values()].some(item => item.status === 'attempting' || item.status === 'unknown')) {
      throw new Error('C2 transition blocked by ambiguous notice')
    }
    id(eventId, 'event ID')
    if (this.#eventIds.has(eventId)) throw new Error('C2 event already committed')
    if (before !== this.#cursor || after !== before + 1 || !Number.isSafeInteger(after)) {
      throw new Error('C2 journal cursor discontinuity')
    }
    if (!Array.isArray(effectIds) || effectIds.length > 4096) throw new TypeError('invalid C2 effects')
    for (const effectId of effectIds) {
      id(effectId, 'effect ID', 512)
      if (this.#effects.has(effectId)) throw new Error('C2 effect already committed')
    }
    if (new Set(effectIds).size !== effectIds.length) throw new Error('duplicate C2 effect ID')
    let descriptors
    if (effectDescriptors !== undefined) {
      if (!Array.isArray(effectDescriptors) || effectDescriptors.length !== effectIds.length) {
        throw new TypeError('C2 effect descriptors must match effect IDs')
      }
      descriptors = effectDescriptors.map((raw, index) => {
        const descriptor = effectDescriptor(raw)
        if (descriptor.effectId !== effectIds[index]) {
          throw new Error('C2 effect descriptor ID or order mismatch')
        }
        return descriptor
      })
    }
    const snapshots = validateSnapshots({ state, receipts }, this.#validateState,
      this.#validateReceipts, this.#validateRelation)
    if (snapshots.state.seq !== after) throw new Error('C2 state cursor mismatch')
    validateReceiptProgress(this.#receipts, snapshots.receipts)
    const nextEffects = new Map(this.#effects)
    const nextDescriptors = new Map(this.#effectDescriptors)
    for (const effectId of effectIds) nextEffects.set(effectId, 'pending')
    for (const descriptor of descriptors || []) {
      nextDescriptors.set(descriptor.effectId, descriptor)
    }
    validateStopAckAuthority(snapshots.state, snapshots.receipts,
      nextEffects, nextDescriptors, this.#effectAttempts)
    const record = { kind: 'transition', eventId, before, after, ...snapshots,
      effectIds: [...effectIds], ...(descriptors ? { effectDescriptors: descriptors } : {}) }
    this.#append(record)
    this.#apply(record)
    return this.snapshot()
  }

  // Legacy confirmation for effects with no durable external attempt. It does
  // not grant permission to perform an external send. External effect runners
  // must use beginEffectAttempt/recordEffectOutcome instead.
  recordEffect(effectId, status) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    id(effectId, 'effect ID', 512)
    if (!['acked', 'unknown'].includes(status) || this.#effects.get(effectId) !== 'pending' ||
        ['finalReply', 'quietCompletion', 'stopAck', 'queueNotice'].includes(this.#effectDescriptors.get(effectId)?.type)) {
      throw new Error('invalid C2 effect confirmation')
    }
    const record = { kind: 'effect', effectId, status, cursor: this.#cursor }
    this.#append(record)
    this.#apply(record)
    return status
  }

  // Resolve the external target and verify the active turn before this fsync.
  // Only after it succeeds may the caller attempt the effect. A replayed
  // attempting status is ambiguous and can never authorize another send.
  beginEffectAttempt(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    noticeFields(value, ['effectId', 'attemptedAt'])
    const { effectId, attemptedAt } = value
    id(effectId, 'effect ID', 512)
    noticeTime(attemptedAt)
    if (this.#effects.get(effectId) !== 'pending' || this.#effectAttempts.has(effectId) ||
        this.#effectDescriptors.get(effectId)?.type === 'quietCompletion' ||
        !terminalAttemptAllowed(this.#state, this.#receipts, this.#effects,
          this.#effectDescriptors.get(effectId)) ||
        !queueNoticeAttemptAllowed(this.#state, this.#receipts,
          this.#effectDescriptors.get(effectId)) ||
        !stopAckAttemptAllowed(this.#state, this.#receipts,
          this.#effectDescriptors.get(effectId))) {
      throw new Error('C2 effect has no unattempted durable authority')
    }
    const record = { kind: 'effectIntent', cursor: this.#cursor, effectId, attemptedAt }
    this.#append(record)
    this.#apply(record)
    this.#localEffectIntents.add(effectId)
    return 'attempting'
  }

  // ACK or unknown must be persisted by the process that began the attempt.
  // An outcome write failure blocks this writer; reopen retains ambiguity.
  recordEffectOutcome(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    const keys = value?.registrationId === undefined
      ? ['effectId', 'status', 'resolvedAt']
      : ['effectId', 'status', 'resolvedAt', 'registrationId']
    noticeFields(value, keys)
    const { effectId, status, resolvedAt, registrationId } = value
    id(effectId, 'effect ID', 512)
    noticeTime(resolvedAt)
    if (!['acked', 'unknown'].includes(status) ||
        status === 'acked' && ['finalReply', 'stopAck'].includes(this.#effectDescriptors.get(effectId)?.type) ||
        !this.#localEffectIntents.has(effectId) ||
        this.#effects.get(effectId) !== 'attempting' ||
        resolvedAt < this.#effectAttempts.get(effectId)) {
      throw new Error('C2 effect has no current local attempt')
    }
    if (registrationId !== undefined) {
      if (status !== 'acked' || this.#runnerAcceptances.has(effectId)) {
        throw new Error('C2 runner acceptance must ACK one dispatch')
      }
      runnerAcceptanceAuthority(effectId, registrationId, this.#runnerAuthority(),
        { effectStatus: 'attempting' })
    }
    const record = { kind: 'effectOutcome', cursor: this.#cursor, effectId,
      status, resolvedAt, ...(registrationId === undefined ? {} : { registrationId }) }
    this.#append(record)
    this.#apply(record)
    this.#localEffectIntents.delete(effectId)
    return status
  }

  // This fsynced record is a host assertion that the accepted runner has
  // closed. It never authorizes a new model launch or outward effect. The host
  // must prove process exit/close before calling and keep the single-writer
  // lease; the journal validates exact durable acceptance and active turn.
  recordRunnerClosed({ receiptId, chatId, turnToken, generation,
    dispatchEffectId, closedAt } = {}) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    const evidenceId = runnerClosedId(receiptId, generation)
    const record = { kind: 'runnerClosed', cursor: this.#cursor,
      evidenceId, receiptId, chatId, turnToken, generation,
      dispatchEffectId, closedAt }
    runnerClosureCandidate(record, this.#runnerAuthority())
    this.#append(record)
    this.#apply(record)
    return evidenceId
  }

  // Only the process which began this dispatch attempt may assert that its
  // child never spawned. The independent status survives a crash before the
  // Rust lane transition; it is neither an ACK nor an unknown external result.
  recordRunnerNotStarted({ receiptId, chatId, turnToken, generation,
    dispatchEffectId, resolvedAt } = {}) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    if (!this.#localEffectIntents.has(dispatchEffectId)) {
      throw new Error('C2 runner not-started proof lacks local attempt')
    }
    const evidenceId = runnerNotStartedId(receiptId, generation)
    const record = { kind: 'runnerNotStarted', cursor: this.#cursor,
      evidenceId, receiptId, chatId, turnToken, generation,
      dispatchEffectId, resolvedAt }
    runnerNotStartedCandidate(record, this.#notStartedAuthority())
    this.#append(record)
    this.#apply(record)
    this.#localEffectIntents.delete(dispatchEffectId)
    return evidenceId
  }

  // Final reply delivery (or quiet zero-call completion) and receipt closure
  // share one fsynced record. The old turn must first release its queue/handoff
  // authority while the receipt remains pending. A successor may begin only
  // after this settlement and terminal prune.
  settleTerminalEffect(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    noticeFields(value, ['effectId', 'receiptId', 'chatId', 'turnToken', 'status', 'settledAt',
      ...(value?.batchReceiptIds === undefined ? [] : ['batchReceiptIds']),
      ...(value?.steerReceiptIds === undefined ? [] : ['steerReceiptIds'])])
    const record = { kind: 'terminalSettlement', cursor: this.#cursor, ...value }
    terminalSettlementCandidate(record, this.#settlementAuthority(), true)
    this.#append(record)
    this.#apply(record)
    this.#localEffectIntents.delete(value.effectId)
    return 'acked'
  }

  // The stop reply and its distinct control receipt close in one fsynced
  // record after a confirmed attempt in this process.
  settleStopAck({ effectId, receiptId, chatId, settledAt } = {}) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    const record = { kind: 'stopAckSettlement', cursor: this.#cursor,
      effectId, receiptId, chatId, settledAt }
    stopAckSettlementCandidate(record, this.#settlementAuthority(), true)
    this.#append(record)
    this.#apply(record)
    this.#localEffectIntents.delete(effectId)
    return 'acked'
  }

  // The caller must resolve the platform reply target before this fsync and
  // must not send unless this call succeeds. An attempt left on disk after a
  // crash is ambiguous; beginNotice will never authorize a second send.
  beginNotice(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    noticeFields(value, ['receiptId', 'chatId', 'attemptedAt'])
    const { receiptId, chatId, attemptedAt } = value
    noticeIdentity(receiptId, chatId)
    noticeTime(attemptedAt)
    const receipt = this.#receipts.pending.find(item => item.id === receiptId)
    if (!receipt || receipt.chatId !== chatId || receipt.quiet ||
        this.#notices.has(receiptId) ||
        terminalEffectForReceipt(this.#effectDescriptors, receiptId) ||
        terminalBatchOwnsReceipt(this.#state, receiptId)) {
      throw new Error('C2 notice requires an unattempted nonquiet pending receipt in this group')
    }
    validatePersistentReceipts({ pending: [receipt], completed: [] })
    // Reject before sending if current state still owns the receipt (queue or
    // handoff). Completion must already be legal at the instant of intent.
    const candidate = completedReceipt(this.#receipts, receiptId, attemptedAt)
    validateSnapshots({ state: this.#state, receipts: candidate }, this.#validateState,
      this.#validateReceipts, this.#validateRelation)
    const record = { kind: 'noticeIntent', cursor: this.#cursor, receiptId, chatId, attemptedAt }
    this.#append(record)
    this.#apply(record)
    this.#localNoticeIntents.add(receiptId)
    return 'attempting'
  }

  // An acknowledged reply and receipt completion share one checksummed,
  // fsynced record. A failed write leaves the journal blocked; reopening may
  // reveal acked or an ambiguous attempt, never permission to resend.
  recordNoticeOutcome(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    const names = value?.status === 'acked'
      ? ['receiptId', 'chatId', 'status', 'settledAt']
      : ['receiptId', 'chatId', 'status', 'resolvedAt']
    noticeFields(value, names)
    const { receiptId, chatId, status } = value
    noticeIdentity(receiptId, chatId)
    if (!['acked', 'unknown'].includes(status) || !this.#localNoticeIntents.has(receiptId) ||
        this.#notices.get(receiptId)?.status !== 'attempting' ||
        this.#notices.get(receiptId)?.chatId !== chatId) {
      throw new Error('C2 notice has no current local attempt')
    }
    const at = status === 'acked' ? value.settledAt : value.resolvedAt
    noticeTime(at)
    if (at < this.#notices.get(receiptId).attemptedAt) throw new Error('C2 notice time regressed')
    if (status === 'acked') {
      const candidate = completedReceipt(this.#receipts, receiptId, at)
      validateSnapshots({ state: this.#state, receipts: candidate }, this.#validateState,
        this.#validateReceipts, this.#validateRelation)
      validateReceiptProgress(this.#receipts, candidate)
    }
    const record = { kind: 'noticeOutcome', cursor: this.#cursor, receiptId, chatId,
      status, ...(status === 'acked' ? { settledAt: at } : { resolvedAt: at }) }
    this.#append(record)
    this.#apply(record)
    this.#localNoticeIntents.delete(receiptId)
    return status
  }

  // A quiet receipt has no external effect, so it can be settled in one
  // durable record once queue/handoff authority has been cleared.
  settleQuietReceipt(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    noticeFields(value, ['receiptId', 'chatId', 'settledAt'])
    const { receiptId, chatId, settledAt } = value
    noticeIdentity(receiptId, chatId)
    noticeTime(settledAt)
    const receipt = this.#receipts.pending.find(item => item.id === receiptId)
    if (!receipt || receipt.chatId !== chatId || receipt.quiet !== true ||
        this.#notices.has(receiptId) ||
        terminalEffectForReceipt(this.#effectDescriptors, receiptId)) {
      throw new Error('C2 quiet settlement requires a quiet pending receipt in this group')
    }
    const candidate = completedReceipt(this.#receipts, receiptId, settledAt)
    validateSnapshots({ state: this.#state, receipts: candidate }, this.#validateState,
      this.#validateReceipts, this.#validateRelation)
    validateReceiptProgress(this.#receipts, candidate)
    const record = { kind: 'quietSettlement', cursor: this.#cursor, receiptId, chatId, settledAt }
    this.#append(record)
    this.#apply(record)
    return 'settled'
  }

  // A callback must be registered while its accepted receipt is pending.
  // The record and fsync complete before the caller may expose the callback.
  registerCallback(value) {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    const registration = validateRegistration(value, this.#receipts, this.#registrations)
    if (this.#notices.has(registration.receiptId)) {
      throw new Error('C2 callback cannot register against a notice attempt')
    }
    const record = { kind: 'registration', cursor: this.#cursor, registration }
    this.#append(record)
    this.#apply(record)
    return structuredClone(registration)
  }

  // Explicit offline maintenance under the daemon's single-writer lock. The
  // checkpoint keeps every event tombstone and every unresolved effect/notice;
  // it only removes repeated historical state and receipt snapshots. A local
  // notice sender must finish before replacement, since its ACK authority is
  // deliberately not transferable to a reopened journal.
  compactMaintenance() {
    if (this.#blocked) throw new Error('C2 journal needs reopen after write failure')
    if (this.#localNoticeIntents.size) throw new Error('C2 notice send is in flight')
    if (this.#localEffectIntents.size) throw new Error('C2 effect send is in flight')
    if ([...this.#effects.values()].some(status => status === 'pending')) {
      throw new Error('C2 effect may be in flight')
    }
    const old = fs.lstatSync(this.#file, { bigint: true })
    if (!old.isFile() || identity(old) !== this.#fileIdentity ||
        old.size !== BigInt(this.#offset)) {
      this.#blocked = true
      throw new Error('C2 journal changed outside writer')
    }
    const record = { kind: 'checkpoint', cursor: this.#cursor,
      state: this.#state, receipts: this.#receipts,
      eventIds: [...this.#eventIds], effects: [...this.#effects],
      effectAttempts: [...this.#effectAttempts],
      effectDescriptors: [...this.#effectDescriptors],
      terminalSettlements: [...this.#terminalSettlements],
      runnerAcceptances: [...this.#runnerAcceptances],
      runnerClosures: [...this.#runnerClosures],
      runnerNotStarts: [...this.#runnerNotStarts],
      registrations: [...this.#registrations.values()], notices: [...this.#notices] }
    const bytes = frame(record, MAX_CHECKPOINT_BYTES)
    const dir = path.dirname(this.#file)
    const temp = path.join(dir, `.${path.basename(this.#file)}.compact-${randomUUID()}`)
    let renamed = false
    try {
      const fd = fs.openSync(temp, 'wx', 0o600)
      try {
        writeAll(fd, MAGIC, 0)
        writeAll(fd, bytes, MAGIC.length)
        fs.fsyncSync(fd)
      } finally { fs.closeSync(fd) }
      const verified = C2DurableJournal.open(temp, {
        validateState: this.#validateState,
        validateReceipts: this.#validateReceipts,
        validateRelation: this.#validateRelation,
      })
      if (verified.#cursor !== this.#cursor ||
          !isDeepStrictEqual(verified.#state, this.#state) ||
          !isDeepStrictEqual(verified.#receipts, this.#receipts) ||
          !isDeepStrictEqual(verified.#eventIds, this.#eventIds) ||
          !isDeepStrictEqual(verified.#effects, this.#effects) ||
          !isDeepStrictEqual(verified.#effectAttempts, this.#effectAttempts) ||
          !isDeepStrictEqual(verified.#effectDescriptors, this.#effectDescriptors) ||
          !isDeepStrictEqual(verified.#terminalSettlements, this.#terminalSettlements) ||
          !isDeepStrictEqual(verified.#runnerAcceptances, this.#runnerAcceptances) ||
          !isDeepStrictEqual(verified.#runnerClosures, this.#runnerClosures) ||
          !isDeepStrictEqual(verified.#runnerNotStarts, this.#runnerNotStarts) ||
          !isDeepStrictEqual(verified.#registrations, this.#registrations) ||
          !isDeepStrictEqual(verified.#notices, this.#notices)) {
        throw new Error('C2 compacted authority differs from source')
      }
      const beforeBytes = this.#offset
      fs.renameSync(temp, this.#file)
      renamed = true
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
      const current = fs.statSync(this.#file, { bigint: true })
      this.#offset = MAGIC.length + bytes.length
      this.#fileIdentity = identity(current)
      return { beforeBytes, afterBytes: this.#offset, cursor: this.#cursor,
        eventCount: this.#eventIds.size }
    } catch (error) {
      if (renamed) this.#blocked = true
      throw error
    } finally {
      if (!renamed) { try { fs.unlinkSync(temp) } catch (error) { if (error.code !== 'ENOENT') throw error } }
    }
  }

  #append(record) {
    const bytes = frame(record)
    let fd
    try {
      fd = fs.openSync(this.#file, 'r+')
      const stat = fs.fstatSync(fd, { bigint: true })
      if (stat.size !== BigInt(this.#offset) || identity(stat) !== this.#fileIdentity) {
        throw new Error('C2 journal changed outside writer')
      }
      writeAll(fd, bytes, this.#offset)
      fs.fsyncSync(fd)
      this.#offset += bytes.length
    } catch (error) {
      this.#blocked = true
      throw error
    } finally { if (fd !== undefined) fs.closeSync(fd) }
  }

  #apply(record) {
    if (record.kind === 'checkpoint') {
      const keys = Object.keys(record).sort().join(',')
      if (this.#state !== undefined || ![
        'cursor,effects,eventIds,kind,notices,receipts,registrations,state',
        'cursor,effectAttempts,effects,eventIds,kind,notices,receipts,registrations,state',
        'cursor,effectAttempts,effectDescriptors,effects,eventIds,kind,notices,receipts,registrations,state',
        'cursor,effectAttempts,effectDescriptors,effects,eventIds,kind,notices,receipts,registrations,state,terminalSettlements',
        'cursor,effectAttempts,effectDescriptors,effects,eventIds,kind,notices,receipts,registrations,runnerAcceptances,runnerClosures,state,terminalSettlements',
        'cursor,effectAttempts,effectDescriptors,effects,eventIds,kind,notices,receipts,registrations,runnerAcceptances,runnerClosures,runnerNotStarts,state,terminalSettlements',
      ].includes(keys) ||
          !Number.isSafeInteger(record.cursor) || record.cursor < 0) {
        throw new Error('invalid C2 journal checkpoint')
      }
      const snapshots = validateSnapshots(record, this.#validateState,
        this.#validateReceipts, this.#validateRelation)
      if (snapshots.state.seq !== record.cursor ||
          !Array.isArray(record.eventIds) || record.eventIds.length !== record.cursor ||
          !Array.isArray(record.effects) || !Array.isArray(record.registrations) ||
          !Array.isArray(record.notices) ||
          (record.effectAttempts !== undefined && !Array.isArray(record.effectAttempts)) ||
          (record.effectDescriptors !== undefined && !Array.isArray(record.effectDescriptors)) ||
          (record.terminalSettlements !== undefined && !Array.isArray(record.terminalSettlements)) ||
          (record.runnerAcceptances !== undefined && !Array.isArray(record.runnerAcceptances)) ||
          (record.runnerClosures !== undefined && !Array.isArray(record.runnerClosures)) ||
          (record.runnerNotStarts !== undefined && !Array.isArray(record.runnerNotStarts)) ||
          [record.eventIds, record.effects, record.effectAttempts || [],
            record.effectDescriptors || [], record.terminalSettlements || [],
            record.runnerAcceptances || [], record.runnerClosures || [],
            record.runnerNotStarts || [],
            record.registrations, record.notices]
            .some(items => items.length > MAX_CHECKPOINT_ITEMS)) {
        throw new Error('invalid C2 checkpoint index')
      }
      const events = new Set()
      for (const eventId of record.eventIds) {
        id(eventId, 'event ID')
        if (events.has(eventId)) throw new Error('duplicate C2 checkpoint event')
        events.add(eventId)
      }
      if (snapshots.state.lastEventId !== undefined &&
          !events.has(snapshots.state.lastEventId)) throw new Error('C2 checkpoint last event missing')
      const effects = new Map()
      for (const item of record.effects) {
        if (!Array.isArray(item) || item.length !== 2 ||
            !['pending', 'attempting', 'acked', 'unknown', 'notStarted'].includes(item[1])) {
          throw new Error('invalid C2 checkpoint effect')
        }
        id(item[0], 'effect ID', 512)
        if (effects.has(item[0])) throw new Error('duplicate C2 checkpoint effect')
        effects.set(item[0], item[1])
      }
      const effectAttempts = new Map()
      for (const item of record.effectAttempts || []) {
        if (!Array.isArray(item) || item.length !== 2) {
          throw new Error('invalid C2 checkpoint effect attempt')
        }
        id(item[0], 'effect ID', 512)
        noticeTime(item[1])
        if (!['attempting', 'acked', 'unknown', 'notStarted'].includes(effects.get(item[0])) ||
            effectAttempts.has(item[0])) {
          throw new Error('invalid C2 checkpoint effect attempt')
        }
        effectAttempts.set(item[0], item[1])
      }
      if ([...effects].some(([effectId, status]) =>
        status === 'attempting' && !effectAttempts.has(effectId))) {
        throw new Error('C2 checkpoint attempting effect lacks attempt')
      }
      const effectDescriptors = new Map()
      for (const item of record.effectDescriptors || []) {
        if (!Array.isArray(item) || item.length !== 2) {
          throw new Error('invalid C2 checkpoint effect descriptor')
        }
        const descriptor = effectDescriptor(item[1])
        if (item[0] !== descriptor.effectId || !effects.has(item[0]) ||
            effectDescriptors.has(item[0])) {
          throw new Error('invalid C2 checkpoint effect descriptor')
        }
        effectDescriptors.set(item[0], descriptor)
      }
      const receipts = new Set([...snapshots.receipts.pending,
        ...snapshots.receipts.completed].map(item => item.id))
      const registrations = new Map()
      for (const raw of record.registrations) {
        const registration = exactJson(raw)
        if (!registration || typeof registration !== 'object' || Array.isArray(registration) ||
            Object.keys(registration).length !== REGISTRATION_FIELDS.size ||
            Object.keys(registration).some(key => !REGISTRATION_FIELDS.has(key)) ||
            registration.id !== callbackRegistrationId(registration) ||
            !Number.isSafeInteger(registration.registeredAt) || registration.registeredAt <= 0 ||
            !receipts.has(registration.receiptId) || registrations.has(registration.id)) {
          throw new Error('invalid C2 checkpoint registration')
        }
        registrations.set(registration.id, registration)
      }
      const runnerAcceptances = new Map()
      for (const entry of record.runnerAcceptances || []) {
        if (!Array.isArray(entry) || entry.length !== 2 ||
            runnerAcceptances.has(entry[0])) {
          throw new Error('invalid C2 checkpoint runner acceptance')
        }
        runnerAcceptanceAuthority(entry[0], entry[1], {
          state: snapshots.state, receipts: snapshots.receipts, effects,
          attempts: effectAttempts, descriptors: effectDescriptors, registrations,
        }, { requireRunning: false })
        runnerAcceptances.set(entry[0], entry[1])
      }
      const runnerClosures = new Map()
      for (const entry of record.runnerClosures || []) {
        if (!Array.isArray(entry) || entry.length !== 2 ||
            runnerClosures.has(entry[0])) {
          throw new Error('invalid C2 checkpoint runner closure')
        }
        const raw = exactJson(entry[1])
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
            Object.keys(raw).sort().join(',') !==
              'chatId,closedAt,dispatchEffectId,generation,receiptId,turnToken') {
          throw new Error('invalid C2 checkpoint runner closure fields')
        }
        const proof = runnerClosureCandidate({ kind: 'runnerClosed',
          cursor: record.cursor, evidenceId: entry[0], ...raw }, {
          state: snapshots.state, receipts: snapshots.receipts, effects,
          attempts: effectAttempts, descriptors: effectDescriptors, registrations,
          acceptances: runnerAcceptances, closures: runnerClosures,
        }, false)
        runnerClosures.set(entry[0], proof)
      }
      const runnerNotStarts = new Map()
      for (const entry of record.runnerNotStarts || []) {
        if (!Array.isArray(entry) || entry.length !== 2 || runnerNotStarts.has(entry[0])) {
          throw new Error('invalid C2 checkpoint runner not-started proof')
        }
        const raw = exactJson(entry[1])
        if (!raw || typeof raw !== 'object' || Array.isArray(raw) ||
            Object.keys(raw).sort().join(',') !==
              'chatId,dispatchEffectId,generation,receiptId,resolvedAt,turnToken') {
          throw new Error('invalid C2 checkpoint runner not-started fields')
        }
        const proof = runnerNotStartedCandidate({ kind: 'runnerNotStarted',
          cursor: record.cursor, evidenceId: entry[0], ...raw }, {
          state: snapshots.state, receipts: snapshots.receipts, effects,
          attempts: effectAttempts, descriptors: effectDescriptors, registrations,
          acceptances: runnerAcceptances, closures: runnerClosures,
          notStarts: runnerNotStarts,
        }, false)
        runnerNotStarts.set(entry[0], proof)
      }
      if ([...effects].some(([effectId, status]) => status === 'notStarted' &&
          ![...runnerNotStarts.values()].some(proof => proof.dispatchEffectId === effectId))) {
        throw new Error('C2 checkpoint not-started effect lacks proof')
      }
      const notices = new Map()
      const pendingIds = new Set(snapshots.receipts.pending.map(item => item.id))
      const completedIds = new Set(snapshots.receipts.completed.map(item => item.id))
      for (const entry of record.notices) {
        if (!Array.isArray(entry) || entry.length !== 2) throw new Error('invalid C2 checkpoint notice')
        const [receiptId, raw] = entry
        const notice = exactJson(raw)
        if (!notice || typeof notice !== 'object' || Array.isArray(notice)) {
          throw new Error('invalid C2 checkpoint notice')
        }
        noticeIdentity(receiptId, notice.chatId)
        const keys = Object.keys(notice).sort().join(',')
        if (notice.status === 'quiet-settled') {
          if (keys !== 'chatId,status' || !completedIds.has(receiptId)) {
            throw new Error('invalid C2 checkpoint quiet notice')
          }
        } else if (['attempting', 'acked', 'unknown'].includes(notice.status)) {
          if (keys !== 'attemptedAt,chatId,status' ||
              (notice.status === 'acked' ? !completedIds.has(receiptId) : !pendingIds.has(receiptId))) {
            throw new Error('invalid C2 checkpoint notice state')
          }
          noticeTime(notice.attemptedAt)
        } else throw new Error('invalid C2 checkpoint notice status')
        const pending = snapshots.receipts.pending.find(item => item.id === receiptId)
        if (pending && pending.chatId !== notice.chatId || notices.has(receiptId)) {
          throw new Error('invalid C2 checkpoint notice target')
        }
        notices.set(receiptId, notice)
      }
      const terminalSettlements = new Map()
      const settledReceipts = new Set()
      for (const entry of record.terminalSettlements || []) {
        if (!Array.isArray(entry) || entry.length !== 2) {
          throw new Error('invalid C2 checkpoint terminal settlement')
        }
        const [effectId, raw] = entry
        id(effectId, 'effect ID', 512)
        const item = exactJson(raw)
        if (!item || typeof item !== 'object' || Array.isArray(item) ||
            !['chatId,receiptId,settledAt,turnToken',
              'batchReceiptIds,chatId,receiptId,settledAt,turnToken',
              'chatId,receiptId,settledAt,steerReceiptIds,turnToken',
              'batchReceiptIds,chatId,receiptId,settledAt,steerReceiptIds,turnToken']
              .includes(Object.keys(item).sort().join(','))) {
          throw new Error('invalid C2 checkpoint terminal settlement')
        }
        noticeIdentity(item.receiptId, item.chatId)
        noticeTime(item.settledAt)
        const descriptor = effectDescriptors.get(effectId)
        if (item.steerReceiptIds !== undefined &&
            (!Array.isArray(item.steerReceiptIds) || !item.steerReceiptIds.length || item.steerReceiptIds.length > 32 ||
              item.steerReceiptIds.some(id => !RECEIPT_ID.test(id) ||
                ![...effectDescriptors.values()].some(effect => effect.domain === 'steer' &&
                  effect.type === 'callSteer' && effect.scope === item.chatId &&
                  effect.turnToken === item.turnToken && effect.receiptId === id &&
                  effects.get(effect.effectId) === 'acked')))) throw new Error('invalid C2 checkpoint steer settlement')
        const settledIds = [...(item.batchReceiptIds || [item.receiptId]), ...(item.steerReceiptIds || [])]
        if (!Array.isArray(settledIds) || !settledIds.length ||
            new Set(settledIds).size !== settledIds.length ||
            !settledIds.includes(item.receiptId) ||
            item.batchReceiptIds && item.batchReceiptIds.length < 2 ||
            !Number.isSafeInteger(item.turnToken) || item.turnToken <= 0 ||
            !descriptor || descriptor.domain !== 'terminal' ||
            !['finalReply', 'quietCompletion'].includes(descriptor.type) ||
            descriptor.scope !== item.chatId || descriptor.receiptId !== item.receiptId ||
            descriptor.turnToken !== item.turnToken || effects.get(effectId) !== 'acked' ||
            (descriptor.type === 'finalReply') !== effectAttempts.has(effectId) ||
            settledIds.some(id => !RECEIPT_ID.test(id) ||
              !snapshots.receipts.completed.some(receipt =>
                receipt.id === id && receipt.settledAt === item.settledAt) ||
              notices.has(id) || settledReceipts.has(id)) ||
            terminalSettlements.has(effectId)) {
          throw new Error('invalid C2 checkpoint terminal settlement')
        }
        terminalSettlements.set(effectId, item)
        for (const id of settledIds) settledReceipts.add(id)
      }
      for (const [effectId, descriptor] of effectDescriptors) {
        if (descriptor.domain !== 'terminal' ||
            !['finalReply', 'quietCompletion'].includes(descriptor.type)) continue
        const status = effects.get(effectId)
        if (status === 'acked' ? !terminalSettlements.has(effectId) :
            !snapshots.receipts.pending.some(receipt =>
              receipt.id === descriptor.receiptId && receipt.chatId === descriptor.scope)) {
          throw new Error('C2 checkpoint terminal effect lacks atomic settlement authority')
        }
      }
      validateStopAckAuthority(snapshots.state, snapshots.receipts, effects,
        effectDescriptors, effectAttempts)
      this.#state = snapshots.state
      this.#receipts = snapshots.receipts
      this.#cursor = record.cursor
      this.#eventIds = events
      this.#effects = effects
      this.#effectAttempts = effectAttempts
      this.#effectDescriptors = effectDescriptors
      this.#terminalSettlements = terminalSettlements
      this.#registrations = registrations
      this.#runnerAcceptances = runnerAcceptances
      this.#runnerClosures = runnerClosures
      this.#runnerNotStarts = runnerNotStarts
      this.#notices = notices
      return
    }
    if (record.kind === 'genesis') {
      if (this.#state !== undefined) throw new Error('duplicate C2 journal genesis')
      const snapshots = validateSnapshots(record, this.#validateState,
        this.#validateReceipts, this.#validateRelation)
      if (snapshots.state.seq !== 0 || Object.keys(record).sort().join(',') !== 'kind,receipts,state') {
        throw new Error('invalid C2 journal genesis')
      }
      this.#state = snapshots.state
      this.#receipts = snapshots.receipts
      return
    }
    if (this.#state === undefined) throw new Error('C2 journal lacks genesis')
    if (record.kind === 'transition') {
      if ([...this.#notices.values()].some(item => item.status === 'attempting' || item.status === 'unknown')) {
        throw new Error('C2 transition blocked by ambiguous notice')
      }
      id(record.eventId, 'event ID')
      const keys = Object.keys(record).sort().join(',')
      if (record.before !== this.#cursor || record.after !== this.#cursor + 1 ||
          !Number.isSafeInteger(record.after) || this.#eventIds.has(record.eventId) ||
          !Array.isArray(record.effectIds) || record.effectIds.length > 4096 ||
          !['after,before,effectIds,eventId,kind,receipts,state',
            'after,before,effectDescriptors,effectIds,eventId,kind,receipts,state'].includes(keys)) {
        throw new Error('invalid C2 journal transition')
      }
      const snapshots = validateSnapshots(record, this.#validateState,
        this.#validateReceipts, this.#validateRelation)
      if (snapshots.state.seq !== record.after) throw new Error('C2 journal state cursor mismatch')
      validateReceiptProgress(this.#receipts, snapshots.receipts)
      const unique = new Set(record.effectIds)
      if (unique.size !== record.effectIds.length) throw new Error('duplicate C2 journal effects')
      for (const effectId of unique) {
        id(effectId, 'effect ID', 512)
        if (this.#effects.has(effectId)) throw new Error('duplicate C2 journal effect')
      }
      let descriptors = []
      if (record.effectDescriptors !== undefined) {
        if (!Array.isArray(record.effectDescriptors) ||
            record.effectDescriptors.length !== record.effectIds.length) {
          throw new Error('invalid C2 journal effect descriptors')
        }
        descriptors = record.effectDescriptors.map((raw, index) => {
          const descriptor = effectDescriptor(raw)
          if (descriptor.effectId !== record.effectIds[index]) {
            throw new Error('C2 journal effect descriptor mismatch')
          }
          return descriptor
        })
      }
      this.#state = snapshots.state
      this.#receipts = snapshots.receipts
      this.#cursor = record.after
      this.#eventIds.add(record.eventId)
      for (const effectId of unique) this.#effects.set(effectId, 'pending')
      for (const descriptor of descriptors) this.#effectDescriptors.set(descriptor.effectId, descriptor)
      validateStopAckAuthority(this.#state, this.#receipts, this.#effects,
        this.#effectDescriptors, this.#effectAttempts)
      return
    }
    if (record.kind === 'effect') {
      id(record.effectId, 'effect ID', 512)
      if (!['acked', 'unknown'].includes(record.status) || record.cursor !== this.#cursor ||
          this.#effects.get(record.effectId) !== 'pending' ||
          ['finalReply', 'quietCompletion', 'stopAck', 'queueNotice'].includes(this.#effectDescriptors.get(record.effectId)?.type) ||
          Object.keys(record).sort().join(',') !== 'cursor,effectId,kind,status') {
        throw new Error('invalid C2 journal effect confirmation')
      }
      this.#effects.set(record.effectId, record.status)
      return
    }
    if (record.kind === 'effectIntent') {
      if (Object.keys(record).sort().join(',') !== 'attemptedAt,cursor,effectId,kind' ||
          record.cursor !== this.#cursor) throw new Error('invalid C2 effect intent record')
      id(record.effectId, 'effect ID', 512)
      noticeTime(record.attemptedAt)
      if (this.#effects.get(record.effectId) !== 'pending' ||
          this.#effectAttempts.has(record.effectId) ||
          this.#effectDescriptors.get(record.effectId)?.type === 'quietCompletion' ||
          !terminalAttemptAllowed(this.#state, this.#receipts, this.#effects,
            this.#effectDescriptors.get(record.effectId)) ||
          !queueNoticeAttemptAllowed(this.#state, this.#receipts,
            this.#effectDescriptors.get(record.effectId)) ||
          !stopAckAttemptAllowed(this.#state, this.#receipts,
            this.#effectDescriptors.get(record.effectId))) {
        throw new Error('invalid C2 effect intent target')
      }
      this.#effects.set(record.effectId, 'attempting')
      this.#effectAttempts.set(record.effectId, record.attemptedAt)
      return
    }
    if (record.kind === 'effectOutcome') {
      if (!['cursor,effectId,kind,resolvedAt,status',
        'cursor,effectId,kind,registrationId,resolvedAt,status']
        .includes(Object.keys(record).sort().join(',')) ||
          record.cursor !== this.#cursor ||
          !['acked', 'unknown'].includes(record.status)) {
        throw new Error('invalid C2 effect outcome record')
      }
      id(record.effectId, 'effect ID', 512)
      noticeTime(record.resolvedAt)
      if (this.#effects.get(record.effectId) !== 'attempting' ||
          record.status === 'acked' &&
            ['finalReply', 'stopAck'].includes(this.#effectDescriptors.get(record.effectId)?.type) ||
          record.resolvedAt < this.#effectAttempts.get(record.effectId)) {
        throw new Error('invalid C2 effect outcome target')
      }
      if (record.registrationId !== undefined) {
        if (record.status !== 'acked' || this.#runnerAcceptances.has(record.effectId)) {
          throw new Error('invalid C2 runner acceptance outcome')
        }
        runnerAcceptanceAuthority(record.effectId, record.registrationId,
          this.#runnerAuthority(), { effectStatus: 'attempting' })
        this.#runnerAcceptances.set(record.effectId, record.registrationId)
      }
      this.#effects.set(record.effectId, record.status)
      return
    }
    if (record.kind === 'runnerClosed') {
      const proof = runnerClosureCandidate(record, this.#runnerAuthority())
      this.#runnerClosures.set(record.evidenceId, proof)
      return
    }
    if (record.kind === 'runnerNotStarted') {
      const proof = runnerNotStartedCandidate(record, this.#notStartedAuthority())
      this.#runnerNotStarts.set(record.evidenceId, proof)
      this.#effects.set(record.dispatchEffectId, 'notStarted')
      return
    }
    if (record.kind === 'terminalSettlement') {
      const candidate = terminalSettlementCandidate(record, this.#settlementAuthority(), false)
      if (this.#terminalSettlements.has(record.effectId)) {
        throw new Error('duplicate C2 terminal settlement')
      }
      this.#effects.set(record.effectId, 'acked')
      this.#receipts = candidate
      this.#terminalSettlements.set(record.effectId, { receiptId: record.receiptId,
        chatId: record.chatId, turnToken: record.turnToken, settledAt: record.settledAt,
        ...(record.batchReceiptIds === undefined ? {} : {
          batchReceiptIds: [...record.batchReceiptIds] }),
        ...(record.steerReceiptIds === undefined ? {} : { steerReceiptIds: [...record.steerReceiptIds] }) })
      return
    }
    if (record.kind === 'stopAckSettlement') {
      const candidate = stopAckSettlementCandidate(record, this.#settlementAuthority(), false)
      this.#effects.set(record.effectId, 'acked')
      this.#receipts = candidate
      validateStopAckAuthority(this.#state, this.#receipts, this.#effects,
        this.#effectDescriptors, this.#effectAttempts)
      return
    }
    if (record.kind === 'registration') {
      if (record.cursor !== this.#cursor ||
          Object.keys(record).sort().join(',') !== 'cursor,kind,registration') {
        throw new Error('invalid C2 journal registration record')
      }
      const registration = validateRegistration(record.registration, this.#receipts,
        this.#registrations)
      if (this.#notices.has(registration.receiptId)) {
        throw new Error('C2 callback cannot register against a notice attempt')
      }
      this.#registrations.set(registration.id, registration)
      return
    }
    if (record.kind === 'noticeIntent') {
      if (Object.keys(record).sort().join(',') !== 'attemptedAt,chatId,cursor,kind,receiptId' ||
          record.cursor !== this.#cursor) throw new Error('invalid C2 notice intent record')
      noticeIdentity(record.receiptId, record.chatId)
      noticeTime(record.attemptedAt)
      const receipt = this.#receipts.pending.find(item => item.id === record.receiptId)
      if (!receipt || receipt.chatId !== record.chatId || receipt.quiet ||
          this.#notices.has(record.receiptId) ||
          terminalEffectForReceipt(this.#effectDescriptors, record.receiptId) ||
          terminalBatchOwnsReceipt(this.#state, record.receiptId)) {
        throw new Error('invalid C2 notice intent target')
      }
      validatePersistentReceipts({ pending: [receipt], completed: [] })
      validateSnapshots({ state: this.#state,
        receipts: completedReceipt(this.#receipts, record.receiptId, record.attemptedAt) },
      this.#validateState, this.#validateReceipts, this.#validateRelation)
      this.#notices.set(record.receiptId, { chatId: record.chatId,
        status: 'attempting', attemptedAt: record.attemptedAt })
      return
    }
    if (record.kind === 'noticeOutcome') {
      const names = record.status === 'acked'
        ? 'chatId,cursor,kind,receiptId,settledAt,status'
        : 'chatId,cursor,kind,receiptId,resolvedAt,status'
      if (Object.keys(record).sort().join(',') !== names || record.cursor !== this.#cursor ||
          !['acked', 'unknown'].includes(record.status)) throw new Error('invalid C2 notice outcome record')
      noticeIdentity(record.receiptId, record.chatId)
      const notice = this.#notices.get(record.receiptId)
      if (!notice || notice.chatId !== record.chatId || notice.status !== 'attempting') {
        throw new Error('invalid C2 notice outcome target')
      }
      const at = record.status === 'acked' ? record.settledAt : record.resolvedAt
      noticeTime(at)
      if (at < notice.attemptedAt) throw new Error('C2 notice time regressed')
      if (record.status === 'acked') {
        const candidate = completedReceipt(this.#receipts, record.receiptId, at)
        validateSnapshots({ state: this.#state, receipts: candidate }, this.#validateState,
          this.#validateReceipts, this.#validateRelation)
        validateReceiptProgress(this.#receipts, candidate)
        this.#receipts = candidate
      }
      this.#notices.set(record.receiptId, { ...notice, status: record.status })
      return
    }
    if (record.kind === 'quietSettlement') {
      if (Object.keys(record).sort().join(',') !== 'chatId,cursor,kind,receiptId,settledAt' ||
          record.cursor !== this.#cursor) throw new Error('invalid C2 quiet settlement record')
      noticeIdentity(record.receiptId, record.chatId)
      noticeTime(record.settledAt)
      const receipt = this.#receipts.pending.find(item => item.id === record.receiptId)
      if (!receipt || receipt.chatId !== record.chatId || receipt.quiet !== true ||
          this.#notices.has(record.receiptId) ||
          terminalEffectForReceipt(this.#effectDescriptors, record.receiptId)) {
        throw new Error('invalid C2 quiet settlement target')
      }
      const candidate = completedReceipt(this.#receipts, record.receiptId, record.settledAt)
      validateSnapshots({ state: this.#state, receipts: candidate }, this.#validateState,
        this.#validateReceipts, this.#validateRelation)
      validateReceiptProgress(this.#receipts, candidate)
      this.#receipts = candidate
      this.#notices.set(record.receiptId, { chatId: record.chatId, status: 'quiet-settled' })
      return
    }
    throw new Error('unknown C2 journal record')
  }

  #replay() {
    const fd = fs.openSync(this.#file, 'r+')
    try {
      const size = fs.fstatSync(fd).size
      if (size < MAGIC.length) throw new Error('truncated C2 journal header')
      const magic = Buffer.alloc(MAGIC.length)
      readAll(fd, magic, 0)
      if (!magic.equals(MAGIC)) throw new Error('invalid C2 journal header')
      let offset = MAGIC.length
      while (offset < size) {
        if (size - offset < FRAME_HEADER) break
        const header = Buffer.alloc(FRAME_HEADER)
        readAll(fd, header, offset)
        const length = header.readUInt32BE(0)
        if (!length || length > MAX_CHECKPOINT_BYTES) throw new Error('invalid C2 journal frame length')
        if (size - offset - FRAME_HEADER < length) break
        const payload = Buffer.alloc(length)
        readAll(fd, payload, offset + FRAME_HEADER)
        const hash = createHash('sha256').update(payload).digest()
        if (!hash.equals(header.subarray(4))) throw new Error('C2 journal checksum mismatch')
        let record
        try { record = JSON.parse(payload.toString('utf8')) } catch { throw new Error('invalid C2 journal JSON') }
        if (length > MAX_RECORD_BYTES && record.kind !== 'checkpoint') {
          throw new Error('oversized C2 journal record')
        }
        this.#apply(record)
        offset += FRAME_HEADER + length
      }
      if (this.#state === undefined) throw new Error('C2 journal lacks complete genesis')
      if (offset < size) {
        fs.ftruncateSync(fd, offset)
        fs.fsyncSync(fd)
      }
      this.#offset = offset
      this.#fileIdentity = identity(fs.fstatSync(fd, { bigint: true }))
    } finally { fs.closeSync(fd) }
  }
}

module.exports = { C2DurableJournal }
