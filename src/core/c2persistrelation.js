'use strict'

const { isDeepStrictEqual } = require('node:util')
const { taskId } = require('./enginecheckpoint')
const { validatePersistentState } = require('./c2persiststate')

const RECEIPT_ID = /^[0-9a-f]{32}$/
const PENDING_FIELDS = new Set(['id', 'chatId', 'source', 'sourceId', 'acceptedAt', 'quiet', 'notifiedAt'])

function plain(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError(`${label} must be a plain data object`)
  }
  return value
}

function dense(value, max, label) {
  if (!Array.isArray(value) || value.length > max ||
      Reflect.ownKeys(value).length !== value.length + 1 ||
      !Array.from({ length: value.length }, (_, index) =>
        Object.getOwnPropertyDescriptor(value, index)).every(d => d && d.enumerable && Object.hasOwn(d, 'value'))) {
    throw new TypeError(`${label} invalid`)
  }
  return value
}

function positive(value) { return Number.isSafeInteger(value) && value > 0 }

function validateReceiptSnapshot(receipts) {
  plain(receipts, 'receipt snapshot')
  if (Object.keys(receipts).length !== 2 || !Object.hasOwn(receipts, 'pending') ||
      !Object.hasOwn(receipts, 'completed')) throw new TypeError('receipt snapshot fields invalid')
  const pending = dense(receipts.pending, 100_000, 'pending receipts')
  const completed = dense(receipts.completed, 100_000, 'completed receipts')
  if (pending.length + completed.length > 100_000) throw new RangeError('receipt capacity exceeded')
  const byId = new Map()
  for (const receipt of pending) {
    plain(receipt, 'pending receipt')
    const keys = Object.keys(receipt)
    if (![6, 7].includes(keys.length) || keys.some(key => !PENDING_FIELDS.has(key)) ||
        !['id', 'chatId', 'source', 'sourceId', 'acceptedAt', 'quiet'].every(key => Object.hasOwn(receipt, key)) ||
        typeof receipt.id !== 'string' || !RECEIPT_ID.test(receipt.id) ||
        typeof receipt.chatId !== 'string' || !receipt.chatId ||
        typeof receipt.source !== 'string' || !receipt.source ||
        typeof receipt.sourceId !== 'string' || !receipt.sourceId ||
        !positive(receipt.acceptedAt) || typeof receipt.quiet !== 'boolean' ||
        Object.hasOwn(receipt, 'notifiedAt') && !positive(receipt.notifiedAt) ||
        taskId(receipt) !== receipt.id || byId.has(receipt.id)) {
      throw new TypeError('pending receipt invalid')
    }
    byId.set(receipt.id, receipt)
  }
  for (const item of completed) {
    plain(item, 'completed receipt')
    if (Object.keys(item).length !== 2 || !Object.hasOwn(item, 'id') || !Object.hasOwn(item, 'settledAt') ||
        typeof item.id !== 'string' || !RECEIPT_ID.test(item.id) ||
        !positive(item.settledAt) || byId.has(item.id)) throw new TypeError('completed receipt invalid')
    byId.set(item.id, null)
  }
  return byId
}

function validatePersistentReceipts(receipts) {
  validateReceiptSnapshot(receipts)
  return true
}

// A queued job is a payload handle, not a restorable payload. The journal
// must prove that each handle still has an accepted receipt before startup
// can interrupt it. A batch may include its anchor message: the same receipt
// then appears as job and member within that one queue item.
function validatePersistentRelation(state, receipts) {
  validatePersistentState(state)
  const byId = validateReceiptSnapshot(receipts)
  const queueScopes = state.lanes.queue || {}
  const allJobIds = new Set()
  const allMemberIds = new Set()
  for (const [scope, lane] of Object.entries(queueScopes)) {
    for (const job of lane.queue) {
      if (allJobIds.has(job.id)) throw new TypeError('queue job ID repeated across scopes')
      allJobIds.add(job.id)
      const jobReceiptId = job.id.slice('receipt:job:'.length)
      const receipt = byId.get(jobReceiptId)
      if (!receipt || receipt.chatId !== scope) throw new TypeError('queue job lacks matching pending receipt')
      for (const member of job.batch || []) {
        if (allMemberIds.has(member.id)) throw new TypeError('queue member ID repeated')
        allMemberIds.add(member.id)
        const memberReceiptId = member.id.slice('receipt:member:'.length)
        const memberReceipt = byId.get(memberReceiptId)
        if (!memberReceipt || memberReceipt.chatId !== scope) {
          throw new TypeError('queue member lacks matching pending receipt')
        }
      }
    }
  }
  for (const [scope, lane] of Object.entries(state.lanes.handoff || {})) {
    if (lane.phase === 'handoff' && lane.acceptedReceiptIds.length &&
        !lane.acceptedReceiptIds.includes(lane.nextJobId)) {
      throw new TypeError('handoff batch omits anchor receipt')
    }
    for (const id of lane.acceptedReceiptIds) {
      const receipt = byId.get(id)
      if (!receipt || receipt.chatId !== scope) {
        throw new TypeError('handoff accepted receipt lacks matching pending receipt')
      }
    }
    if (lane.nextJobId !== null) {
      const receipt = byId.get(lane.nextJobId)
      if (!receipt || receipt.chatId !== scope) {
        throw new TypeError('handoff job lacks matching pending receipt')
      }
    }
  }
  for (const [scope, steer] of Object.entries(state.lanes.steer || {})) {
    const parent = byId.get(steer.parentReceiptId)
    if (!parent || parent.chatId !== scope || parent.source !== 'message' || parent.quiet ||
        state.lanes.turn?.[scope]?.active !== steer.turnToken ||
        state.lanes.handoff?.[scope]?.phase !== 'running' ||
        state.lanes.handoff[scope].turnToken !== steer.turnToken) throw new TypeError('steer parent authority invalid')
    for (const entry of steer.entries) {
      const receipt = byId.get(entry.receiptId)
      if (!receipt || receipt.chatId !== scope || receipt.source !== 'message' || receipt.quiet ||
          allJobIds.has(`receipt:job:${entry.receiptId}`) ||
          state.lanes.handoff[scope].acceptedReceiptIds.includes(entry.receiptId)) {
        throw new TypeError('steer receipt authority invalid')
      }
    }
  }
  for (const [scope, terminal] of Object.entries(state.lanes.terminal || {})) {
    for (const id of terminal.steerReceiptIds || []) {
      if (!byId.has(id) || byId.get(id) && byId.get(id).chatId !== scope || allJobIds.has(`receipt:job:${id}`)) {
        throw new TypeError('terminal steer receipt invalid')
      }
    }
    if (!terminal.finalized || !terminal.batchReceiptIds) continue
    for (const id of terminal.batchReceiptIds) {
      if (!byId.has(id)) throw new TypeError('terminal batch receipt missing')
      const pending = byId.get(id)
      if (pending && pending.chatId !== scope) {
        throw new TypeError('terminal batch receipt belongs to another group')
      }
    }
    const running = state.lanes.handoff?.[scope]
    if (running?.phase === 'running' && running.acceptedReceiptIds.length &&
        (running.acceptedReceiptIds.length !== terminal.batchReceiptIds.length ||
          running.acceptedReceiptIds.some((id, index) =>
            id !== terminal.batchReceiptIds[index]))) {
      throw new TypeError('terminal batch differs from running handoff')
    }
  }
  for (const [scope, intent] of Object.entries(state.lanes.stopIntent || {})) {
    const control = byId.get(intent.controlReceiptId)
    const running = byId.get(intent.runningReceiptId)
    const handoff = state.lanes.handoff?.[scope]
    const turn = state.lanes.turn?.[scope]
    const runningIds = handoff?.acceptedReceiptIds?.length
      ? handoff.acceptedReceiptIds : [intent.runningReceiptId]
    if (!control || control.chatId !== scope || control.source !== 'message' ||
        control.quiet || !running || running.chatId !== scope ||
        running.source !== 'message' ||
        handoff?.phase !== 'running' || handoff.turnToken !== intent.turnToken ||
        !runningIds.includes(intent.runningReceiptId) ||
        (runningIds.length > 1
          ? !isDeepStrictEqual(intent.batchReceiptIds, runningIds)
          : intent.batchReceiptIds !== undefined) ||
        runningIds.some(id => {
          const member = byId.get(id)
          return !member || member.chatId !== scope || member.source !== 'message'
        }) ||
        turn?.active !== intent.turnToken ||
        allJobIds.has(`receipt:job:${intent.controlReceiptId}`) ||
        allMemberIds.has(`receipt:member:${intent.controlReceiptId}`)) {
      throw new TypeError('stop intent lacks exact pending control and running receipts')
    }
  }
  for (const [scope, cleanup] of Object.entries(state.lanes.cardCleanup || {})) {
    const receipt = byId.get(cleanup.receiptId)
    const handoff = state.lanes.handoff?.[scope]
    const turn = state.lanes.turn?.[scope]
    const session = state.lanes.session?.[scope]
    const stop = state.lanes.stopIntent?.[scope]
    if (!receipt || receipt.chatId !== scope || receipt.source !== 'message' ||
        handoff?.phase !== 'running' || handoff.turnToken !== cleanup.turnToken ||
        turn?.active !== cleanup.turnToken ||
        session?.epoch !== cleanup.turnToken || session.closeSeen !== true ||
        stop && (stop.runningReceiptId !== cleanup.receiptId ||
          stop.turnToken !== cleanup.turnToken ||
          stop.runnerGeneration !== cleanup.runnerGeneration)) {
      throw new TypeError('card cleanup lacks exact pending running receipt and close proof')
    }
  }
  return true
}

module.exports = { validatePersistentReceipts, validatePersistentRelation }
