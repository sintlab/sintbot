'use strict'

// Same-process continuation after a settled v2 terminal effect. The prior
// answer is already externally visible; only internal handoff effects may be
// acknowledged here. A crash loses raw queued jobs and startup recovery must
// interrupt them rather than replaying a model run.
const { isDeepStrictEqual } = require('node:util')
const { C2DurableRuntime } = require('./c2durableruntime')
const { C2DurableJournal } = require('./c2durablejournal')
const { C2PayloadHandles } = require('./c2payloadhandles')

const RECEIPT_ID = /^[0-9a-f]{32}$/

function continueC2Successor({ runtime, journal, payloadHandles, chatId,
  priorReceiptId, priorTurnToken, terminalResult, generation,
  assertWriterLock, now = Date.now } = {}) {
  if (!(runtime instanceof C2DurableRuntime) ||
      !(journal instanceof C2DurableJournal) ||
      !(payloadHandles instanceof C2PayloadHandles) ||
      typeof chatId !== 'string' || !chatId ||
      !RECEIPT_ID.test(priorReceiptId || '') ||
      !Number.isSafeInteger(priorTurnToken) || priorTurnToken <= 0 ||
      !RECEIPT_ID.test(generation || '') ||
      typeof assertWriterLock !== 'function' ||
      assertWriterLock.constructor?.name === 'AsyncFunction' ||
      typeof now !== 'function' || now.constructor?.name === 'AsyncFunction') {
    throw new TypeError('C2 successor bridge needs exact live authority')
  }
  const locked = () => {
    if (assertWriterLock() !== true) throw new Error('C2 successor lost writer lock')
  }
  try {
    locked()
    const before = runtime.snapshot()
    if (runtime.blocked || journal.blocked || payloadHandles.blocked ||
        !isDeepStrictEqual(before, journal.snapshot()) ||
        terminalResult?.receiptId !== priorReceiptId ||
        !RECEIPT_ID.test(terminalResult?.nextReceiptId || '') ||
        typeof terminalResult?.terminalEffectId !== 'string' ||
        !Array.isArray(terminalResult.pendingEffects) ||
        terminalResult.pendingEffects.length !== 2 ||
        new Set(terminalResult.pendingEffects).size !== 2) {
      throw new Error('C2 successor lacks settled prior terminal authority')
    }
    const nextReceiptId = terminalResult.nextReceiptId
    const settlement = journal.terminalSettlement(terminalResult.terminalEffectId)
    const terminal = journal.effectDescriptor(terminalResult.terminalEffectId)
    const [holdId, scheduleId] = terminalResult.pendingEffects
    const hold = journal.effectDescriptor(holdId)
    const schedule = journal.effectDescriptor(scheduleId)
    const handoff = before.state?.lanes?.handoff?.[chatId]
    const turn = before.state?.lanes?.turn?.[chatId]
    const nextReceipt = before.receipts?.pending?.find(item => item.id === nextReceiptId)
    if (settlement?.receiptId !== priorReceiptId ||
        settlement.chatId !== chatId || settlement.turnToken !== priorTurnToken ||
        terminal?.receiptId !== priorReceiptId || terminal.scope !== chatId ||
        !['finalReply', 'quietCompletion'].includes(terminal.type) ||
        journal.effectStatus(terminalResult.terminalEffectId) !== 'acked' ||
        !before.receipts.completed.some(item => item.id === priorReceiptId) ||
        before.receipts.pending.some(item => item.id === priorReceiptId) ||
        nextReceipt?.chatId !== chatId || nextReceipt.source !== 'message' ||
        handoff?.phase !== 'handoff' || handoff.turnToken !== priorTurnToken ||
        handoff.nextJobId !== nextReceiptId || turn?.active !== null ||
        hold?.domain !== 'atomicHandoff' || hold.scope !== chatId ||
        hold.type !== 'holdHandoff' || hold.turnToken !== priorTurnToken ||
        hold.receiptId !== null || hold.targetId !== null ||
        schedule?.domain !== 'atomicHandoff' || schedule.scope !== chatId ||
        schedule.type !== 'scheduleDispatch' ||
        schedule.turnToken !== priorTurnToken ||
        schedule.receiptId !== nextReceiptId || schedule.targetId !== null ||
        journal.effectStatus(holdId) !== 'pending' ||
        journal.effectStatus(scheduleId) !== 'pending') {
      throw new Error('C2 successor effects differ from durable handoff')
    }
    payloadHandles.peekHandoff(nextReceiptId)
    locked()
    runtime.recordEffect(holdId, 'acked')
    if (journal.effectStatus(holdId) !== 'acked' ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) {
      throw new Error('C2 successor hold ACK differs from runtime')
    }
    locked()
    runtime.recordEffect(scheduleId, 'acked')
    if (journal.effectStatus(scheduleId) !== 'acked' ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) {
      throw new Error('C2 successor schedule ACK differs from runtime')
    }
    const registeredAt = now()
    if (!Number.isSafeInteger(registeredAt) || registeredAt <= 0) {
      throw new TypeError('C2 successor callback time invalid')
    }
    locked()
    runtime.registerHandoffBeginCallback({ receiptId: nextReceiptId,
      generation, registeredAt })
    locked()
    const begun = runtime.commitHandoffBegin({ receiptId: nextReceiptId,
      generation, priorTurnToken, payloadHandles })
    const [clear, dispatch] = begun.effects || []
    const token = begun.decision?.turnToken
    if (!Number.isSafeInteger(token) || token <= priorTurnToken ||
        !Array.isArray(begun.jobReceiptIds) || begun.jobReceiptIds.length === 0 ||
        !begun.jobReceiptIds.includes(nextReceiptId) ||
        begun.effects.length !== 2 || clear?.type !== 'clearHandoff' ||
        dispatch?.type !== 'dispatch' || dispatch.jobId !== nextReceiptId ||
        dispatch.turnToken !== token ||
        journal.effectDescriptor(clear.effectId)?.type !== 'clearHandoff' ||
        journal.effectDescriptor(dispatch.effectId)?.type !== 'dispatch' ||
        journal.effectStatus(clear.effectId) !== 'pending' ||
        journal.effectStatus(dispatch.effectId) !== 'pending' ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) {
      throw new Error('C2 successor begin differs from durable dispatch')
    }
    locked()
    runtime.recordEffect(clear.effectId, 'acked')
    if (journal.effectStatus(clear.effectId) !== 'acked' ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) {
      throw new Error('C2 successor clear ACK differs from runtime')
    }
    locked()
    const jobs = payloadHandles.consumeCommittedDispatch({ eventId: begun.eventId,
      turnToken: token, receiptIds: begun.jobReceiptIds })
    if (jobs.length !== begun.jobReceiptIds.length ||
        jobs.some((job, index) => job.msg?._c2ReceiptId !== begun.jobReceiptIds[index] ||
          job.msg.chatId !== chatId)) {
      throw new Error('C2 successor jobs differ from durable dispatch')
    }
    const after = runtime.snapshot()
    const queue = after.state?.lanes?.queue?.[chatId]?.queue
    if (!Array.isArray(queue) ||
        !queue.every(item => typeof item.id === 'string' &&
          /^receipt:job:[0-9a-f]{32}$/.test(item.id)) ||
        after.state?.lanes?.turn?.[chatId]?.active !== token ||
        after.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
        after.state.lanes.handoff[chatId].turnToken !== token ||
        after.effects.get(dispatch.effectId) !== 'pending') {
      throw new Error('C2 successor dispatch is no longer live')
    }
    locked()
    return Object.freeze({ receiptId: nextReceiptId, turnToken: token,
      effectId: dispatch.effectId, eventId: begun.eventId, cursor: begun.cursor,
      jobReceiptIds: Object.freeze([...begun.jobReceiptIds]),
      batchReceiptIds: Object.freeze([...begun.batchReceiptIds]),
      jobs: Object.freeze([...jobs]),
      queuedReceiptIds: Object.freeze(queue.map(item => item.id.slice('receipt:job:'.length))) })
  } catch (error) {
    runtime.close()
    throw error
  }
}

module.exports = { continueC2Successor }
