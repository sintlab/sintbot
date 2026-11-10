'use strict'

// Opt-in host bridge for one single-receipt terminal effect. The three callback
// identities are fsynced before a runner completion callback may be exposed.
// Text and platform targets stay in the caller's process; the runtime/journal
// receive only the v2 decision and stable effect/receipt identities.
const { C2DurableRuntime } = require('./c2durableruntime')
const { C2PayloadHandles } = require('./c2payloadhandles')
const { engineTerminalStep } = require('../agent/privatecore')

const FAILURE_NOTICE = '本次任务执行失败。若已执行过工具，请先核对实际结果，再决定是否重试。'
const INTERRUPTED_NOTICE = '本次任务执行中断，未收到最终结果。已执行的操作可能已经生效，请核对后再决定是否重试。'

const RECEIPT_ID = /^[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const LOCAL_EFFECTS = new Set(['markTainted', 'clearTainted',
  'clearExhausted', 'verifyTurn'])

// The legacy final delivery keeps the answer after the last tool when one
// exists, otherwise the full streamed text. Codex may emit several assistant
// messages while result.text contains only the last one. Keep this projection
// process-local: the durable terminal payload is validated by the core and
// never stores model text in the journal.
function terminalReplyText(payload) {
  if (!payload || typeof payload.resultText !== 'string' ||
      typeof payload.bufferText !== 'string' ||
      typeof payload.answerText !== 'string') {
    throw new TypeError('C2 terminal reply text fields invalid')
  }
  // The core classifies the result; the host supplies a fixed display string.
  // Neither a provider error nor unfinished assistant text is a final answer.
  if (payload.source === 'runner-exit' || payload.source === 'result' && payload.isError === true) {
    const event = { ...payload, type: 'finalize' }
    delete event.receiptId; delete event.turnToken; delete event.quiet
    if (engineTerminalStep({ finalized: false, outcome: null }, event)
      .state.outcome.status === 'error') return payload.source === 'runner-exit'
        ? INTERRUPTED_NOTICE : FAILURE_NOTICE
  }
  return (payload.answerText.trim() ? payload.answerText : payload.bufferText) ||
    payload.resultText
}

function prepareTerminalEffectBridge({ runtime, payloadHandles, receiptId, chatId,
  turnToken, generation, verifyGeneration, applyLocalEffect, assertWriterLock,
  now = Date.now } = {}) {
  if (!(runtime instanceof C2DurableRuntime) ||
      !(payloadHandles instanceof C2PayloadHandles) || payloadHandles.blocked ||
      !RECEIPT_ID.test(receiptId) || typeof chatId !== 'string' || !chatId ||
      !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
      !GENERATION.test(generation) || typeof verifyGeneration !== 'function' ||
      verifyGeneration.constructor?.name === 'AsyncFunction' ||
      typeof applyLocalEffect !== 'function' ||
      applyLocalEffect.constructor?.name === 'AsyncFunction' ||
      typeof now !== 'function') {
    throw new TypeError('C2 terminal bridge needs exact live authority')
  }
  const snapshot = runtime.snapshot()
  if (runtime.blocked ||
      snapshot.receipts?.pending?.find(item => item.id === receiptId)?.chatId !== chatId ||
      snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
      snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
      snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
      verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
    throw new Error('C2 terminal bridge has no live running receipt')
  }
  const stamp = () => {
    const value = now()
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new TypeError('C2 terminal bridge time invalid')
    }
    return value
  }
  try {
    runtime.registerTerminalCallback({ receiptId, generation,
      registeredAt: stamp() })
    runtime.registerReleaseRequestedCallback({ receiptId, generation,
      registeredAt: stamp() })
    runtime.registerQueueReleaseCallback({ receiptId, generation,
      registeredAt: stamp() })
  } catch (error) { runtime.close(); throw error }

  let completed = false
  return Object.freeze({
    async complete({ payload, replyText, resolveTarget, sendReply,
      confirmReply, paused = false } = {}) {
      if (completed) throw new Error('C2 terminal bridge already used')
      completed = true
      if (!payload || typeof payload !== 'object' || Array.isArray(payload) ||
          payload.type !== 'finalizeEffectCommit' ||
          payload.receiptId !== receiptId || payload.turnToken !== turnToken ||
          typeof payload.resultText !== 'string' ||
          typeof paused !== 'boolean') {
        runtime.close()
        throw new TypeError('C2 terminal bridge payload differs from running turn')
      }
      try {
        const terminal = runtime.commitTerminalEffect({ receiptId,
          generation, turnToken, payload })
        const final = terminal.effects.at(-1)
        if (!final || final.effectId !== terminal.terminalEffectId ||
            !['finalReply', 'quietCompletion'].includes(final.type)) {
          throw new Error('C2 terminal bridge has no exact terminal effect')
        }
        for (const effect of terminal.effects.slice(0, -1)) {
          if (!LOCAL_EFFECTS.has(effect.type)) {
            throw new Error('C2 terminal bridge cannot apply unknown local effect')
          }
          if (typeof applyLocalEffect.claim === 'function') {
            runtime.performLocalTerminalEffect({ effect, receiptId, chatId,
              turnToken, generation, verifyGeneration, assertWriterLock,
              applyLocalEffect })
          } else {
            // Older isolated callers retain the development seam. Production
            // must supply the claimed, write-ahead executor above.
            if (applyLocalEffect(effect) !== true) {
              throw new Error('C2 terminal local effect lacks confirmed projection')
            }
            runtime.recordEffect(effect.effectId, 'acked')
          }
        }
        const effect = { effectId: final.effectId, receiptId, chatId,
          turnToken, generation, verifyGeneration, assertWriterLock }
        if (final.type === 'quietCompletion') {
          if (replyText !== undefined || resolveTarget !== undefined ||
              sendReply !== undefined || confirmReply !== undefined) {
            throw new Error('C2 quiet terminal may not send a reply')
          }
          await runtime.executeTerminalEffect(effect)
        } else {
          if (typeof replyText !== 'string' || !replyText ||
              replyText !== terminalReplyText(payload) ||
              typeof resolveTarget !== 'function' ||
              resolveTarget.constructor?.name === 'AsyncFunction' ||
              typeof sendReply !== 'function' ||
              typeof confirmReply !== 'function' ||
              confirmReply.constructor?.name === 'AsyncFunction') {
            throw new TypeError('C2 final reply needs exact process-local text and sender')
          }
          await runtime.executeTerminalEffect({ ...effect, resolveTarget,
            perform: ({ target }) => sendReply(target, replyText),
            confirm: confirmReply })
        }
        const requested = runtime.commitReleaseRequested({ receiptId,
          generation, turnToken, payloadHandles })
        if (requested.effects.length !== 1 ||
            requested.effects[0].type !== 'attemptQueueRelease') {
          throw new Error('C2 terminal bridge release request differs')
        }
        // This is an internal queue instruction. The actual queue transition
        // follows immediately; a crash in between leaves ingress closed.
        runtime.recordEffect(requested.effects[0].effectId, 'acked')
        const released = runtime.commitQueueRelease({ receiptId, generation,
          turnToken, paused, payloadHandles })
        const settlement = runtime.settleTerminalEffect({ effectId: final.effectId,
          receiptId, chatId, turnToken, generation })
        if (settlement.status !== 'acked' || !settlement.pruned) {
          throw new Error('C2 terminal bridge settlement incomplete')
        }
        return { terminalEffectId: final.effectId, receiptId,
          nextReceiptId: released.decision.nextJobId,
          pendingEffects: released.effects.map(item => item.effectId) }
      } catch (error) { runtime.close(); throw error }
    },
  })
}

module.exports = { prepareTerminalEffectBridge, terminalReplyText }
