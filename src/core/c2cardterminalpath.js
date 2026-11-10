'use strict'

// Opt-in, process-local composition for one message receipt. A streaming card's
// earlier operations use independent outbound effects; its final card.update
// belongs to the terminal finalReply effect and therefore cannot enter the
// outbound executor a second time.
const { createC2CardEffectBoundary, confirmCardOperation } = require('./c2cardeffectbridge')
const { prepareTerminalEffectBridge, terminalReplyText } = require('./c2terminaleffectbridge')
const { stripMilestones } = require('./turnprogress')
const { engineTerminalStep } = require('../agent/privatecore')

function prepareCardTerminalPath({ runtime, payloadHandles, platform, replyCtx,
  cardAnchor = null, preferPlain = false,
  receiptId, chatId, turnToken, generation, verifyGeneration,
  applyLocalEffect, assertWriterLock, sendPlainReply = null, redactText = value => value,
  now = Date.now } = {}) {
  const receipt = runtime?.snapshot?.().receipts?.pending?.find(item => item.id === receiptId)
  if (!receipt || receipt.source !== 'message' || receipt.chatId !== chatId ||
      !replyCtx || replyCtx.chatId !== chatId ||
      replyCtx.messageId !== receipt.sourceId ||
      !platform || (typeof platform.createStreamingCard !== 'function' &&
        typeof sendPlainReply !== 'function')) {
    throw new TypeError('C2 card terminal path needs one exact message target')
  }
  if (typeof preferPlain !== 'boolean' ||
      sendPlainReply !== null && typeof sendPlainReply !== 'function') {
    throw new TypeError('C2 plain reply needs one strict sender')
  }
  if (typeof redactText !== 'function' ||
      redactText.constructor?.name === 'AsyncFunction') {
    throw new TypeError('C2 card text redaction must be synchronous')
  }
  const targetCtx = Object.freeze({ ...replyCtx })
  const landedAnchor = anchor => {
    if (!anchor || !/^[0-9a-f]{32}$/.test(anchor.receiptId || '') ||
        anchor.replyCtx?.chatId !== chatId ||
        typeof anchor.replyCtx.messageId !== 'string' ||
        !anchor.replyCtx.messageId) {
      throw new TypeError('C2 card anchor needs one landed follow-up')
    }
    const snapshot = runtime.snapshot()
    const steer = snapshot.state?.lanes?.steer?.[chatId]
    const followup = snapshot.receipts?.pending?.find(item => item.id === anchor.receiptId)
    if (steer?.parentReceiptId !== receiptId || steer.turnToken !== turnToken ||
        steer.generation !== generation ||
        !steer.entries?.some(item => item.receiptId === anchor.receiptId &&
          item.status === 'landed') || followup?.chatId !== chatId ||
        followup.source !== 'message' ||
        followup.sourceId !== anchor.replyCtx.messageId) {
      throw new Error('C2 card anchor differs from landed steer receipt')
    }
    return Object.freeze({ ...anchor.replyCtx })
  }
  let activeAnchorCtx = cardAnchor ? landedAnchor(cardAnchor) : targetCtx
  // Registration is durable before open() can expose any runner callback.
  const terminal = prepareTerminalEffectBridge({ runtime, payloadHandles,
    receiptId, chatId, turnToken, generation, verifyGeneration,
    applyLocalEffect, assertWriterLock, now })
  const operationBoundary = createC2CardEffectBoundary({ runtime, receiptId,
    chatId, turnToken, generation, verifyGeneration })
  let phase = 'prepared'
  let card = null
  let lastCardText = ''
  let suppressedCard = false
  const fail = error => { phase = 'closed'; runtime.close(); throw error }
  const canUsePlain = before => {
    if (!sendPlainReply || runtime.blocked) return false
    const after = runtime.snapshot()
    // The trusted platform adapter must route every card SDK call through the
    // operation boundary. Once an outbound effect exists, even a rejected SDK
    // response is ambiguous and a second delivery would risk a duplicate.
    return after.cursor === before.cursor &&
      after.effects.size === before.effects.size &&
      [...after.effects.keys()].every(id => before.effects.has(id))
  }

  return Object.freeze({
    async open({ suppressCard = false } = {}) {
      if (phase !== 'prepared') throw new Error('C2 card terminal path already opened')
      if (typeof suppressCard !== 'boolean') throw new TypeError('C2 card suppression must be boolean')
      if (suppressCard) {
        // A silent turn with no assistant output never exposed a card in v1.
        // No platform operation or outbound effect is needed before settlement.
        suppressedCard = true
        phase = 'plain'
        return false
      }
      phase = 'opening'
      const before = runtime.snapshot()
      if (preferPlain || typeof platform.createStreamingCard !== 'function') {
        if (!canUsePlain(before)) return fail(new Error('C2 plain reply lacks unopened card proof'))
        phase = 'plain'
        return false
      }
      try {
        card = await platform.createStreamingCard(activeAnchorCtx,
          { operationKey: receiptId, operationBoundary })
        if (!card && canUsePlain(before)) {
          phase = 'plain'
          return false
        }
        if (!card || typeof card.update !== 'function' ||
            typeof card.flush !== 'function' || typeof card.finish !== 'function' ||
            typeof card.recall !== 'function') {
          throw new Error('C2 card terminal path has no durable card')
        }
        phase = 'open'
        return true
      } catch (error) {
        if (canUsePlain(before)) {
          phase = 'plain'
          return false
        }
        return fail(error)
      }
    },
    update(text) {
      if (phase !== 'open' && phase !== 'plain') {
        throw new Error('C2 card terminal path is not open')
      }
      if (suppressedCard) throw new Error('C2 suppressed card cannot stream an update')
      if (typeof text !== 'string') throw new TypeError('C2 card update needs process-local text')
      if (card) {
        lastCardText = redactText(text)
        card.update(lastCardText)
      }
    },
    async relocate(anchor) {
      const nextCtx = landedAnchor(anchor)
      if (phase !== 'open' || !card) return false
      if (activeAnchorCtx.messageId === nextCtx.messageId) return true
      if (!lastCardText) throw new Error('C2 card move has no visible text to replay')
      phase = 'relocating'
      try {
        if (await card.flush() !== true) throw new Error('C2 old card flush unconfirmed')
        // A different operation key gives each card its own durable create,
        // post, frame and delete identities under the same running turn.
        const fresh = await platform.createStreamingCard(nextCtx, {
          operationKey: `${receiptId}:followup:${anchor.receiptId}`,
          operationBoundary,
        })
        if (!fresh || typeof fresh.update !== 'function' ||
            typeof fresh.flush !== 'function' || typeof fresh.recall !== 'function') {
          throw new Error('C2 moved card has no durable writer')
        }
        fresh.update(lastCardText)
        if (await fresh.flush() !== true) throw new Error('C2 moved card text unconfirmed')
        if (await card.recall() !== true) throw new Error('C2 old card delete unconfirmed')
        card = fresh
        activeAnchorCtx = nextCtx
        phase = 'open'
        return true
      } catch (error) { return fail(error) }
    },
    async flushForTerminal() {
      if (phase !== 'open' || !card || await card.flush() !== true) {
        return fail(new Error('C2 stream frame flush unconfirmed'))
      }
      return true
    },
    cancellationTarget() {
      if (!['open', 'recalled'].includes(phase) || !card ||
          typeof card.durableTarget !== 'function') {
        throw new Error('C2 cancellation card target unavailable')
      }
      const target = card.durableTarget()
      if (target?.chatId !== chatId || !target.cardId || !target.msgId) {
        throw new Error('C2 cancellation card target differs from turn')
      }
      return target
    },
    async recallForCancellation() {
      if (phase === 'plain' && !card) {
        phase = 'recalled'
        return false
      }
      if (phase !== 'open' || !card) {
        throw new Error('C2 cancellation has no open streaming card')
      }
      phase = 'recalling'
      try {
        if (await card.flush() !== true || await card.recall() !== true) {
          throw new Error('C2 cancellation card recall unconfirmed')
        }
        phase = 'recalled'
        return true
      } catch (error) { return fail(error) }
    },
    async complete({ payload, replyText, paused = false, footer = '',
      footerDetail = '', milestones = [] } = {}) {
      if (phase !== 'open' && phase !== 'plain') {
        throw new Error('C2 card terminal path is not open')
      }
      phase = 'completing'
      try {
        const terminalPayload = payload && typeof payload === 'object' &&
          !Array.isArray(payload) ? { ...payload } : null
        if (!terminalPayload || terminalPayload.type !== 'finalizeEffectCommit' ||
            terminalPayload.receiptId !== receiptId || terminalPayload.turnToken !== turnToken ||
            typeof terminalPayload.quiet !== 'boolean' || terminalPayload.quiet !== receipt.quiet ||
            typeof terminalPayload.resultText !== 'string' ||
            typeof terminalPayload.bufferText !== 'string' ||
            typeof footer !== 'string' || typeof footerDetail !== 'string' ||
            !Array.isArray(milestones) ||
            !milestones.every(item => typeof item === 'string' && item.trim())) {
          throw new TypeError('C2 card terminal payload differs from running turn')
        }
        if (card && await card.flush() !== true) {
          throw new Error('C2 card prior operations lack confirmed flush')
        }
        // Partial NO_REPLY text on a crashed turn is not a silent completion.
        const terminalEvent = { ...terminalPayload, type: 'finalize' }
        delete terminalEvent.receiptId; delete terminalEvent.turnToken; delete terminalEvent.quiet
        const quiet = receipt.quiet || engineTerminalStep(
          { finalized: false, outcome: null }, terminalEvent).state.outcome.silent
        if (suppressedCard && !quiet) {
          throw new Error('C2 suppressed card needs a silent terminal')
        }
        let result
        if (quiet) {
          if (replyText !== undefined) {
            throw new Error('C2 quiet card cannot carry reply text')
          }
          if (card && await card.recall() !== true) {
            throw new Error('C2 quiet card recall unconfirmed')
          }
          result = await terminal.complete({ payload: terminalPayload, paused })
        } else {
          if (typeof replyText !== 'string' || !replyText ||
              replyText !== terminalReplyText(terminalPayload)) {
            throw new TypeError('C2 visible card needs exact process-local final text')
          }
          const visibleText = redactText(replyText)
          if (typeof visibleText !== 'string' || !visibleText) {
            throw new TypeError('C2 visible card redaction removed final text')
          }
          result = await terminal.complete({ payload: terminalPayload, replyText, paused,
            resolveTarget: item => ({ receiptId: item.id, chatId: item.chatId,
              sourceId: item.sourceId, replyCtx: targetCtx }),
            sendReply: async (target, text) => {
              if (!card) {
                // The caller supplies a strict single-call sender. The normal
                // platform.reply has a hidden reply-to-direct-send retry and
                // is therefore not suitable for a durable final effect.
                return sendPlainReply(target, visibleText)
              }
              // Display only: milestone lines leave the answer and go into the
              // card's "process" fold; an answer that was only milestones shows
              // them as its body. The durable reply text stays exact.
              let shownText = visibleText
              const finishOpts = { footer, footerDetail }
              if (milestones.length) {
                const stripped = stripMilestones(visibleText)
                if (stripped.trim()) {
                  shownText = stripped
                  finishOpts.milestones = [...milestones]
                } else shownText = milestones.map(item => '▶ ' + item).join('\n')
              }
              let calls = 0
              const finished = await card.finish(shownText, { ...finishOpts,
                terminalOperationBoundary: async operation => {
                  if (!operation || operation.kind !== 'card.update' ||
                      operation.cardId == null || typeof operation.invoke !== 'function' ||
                      ++calls !== 1) {
                    throw new Error('C2 final card needs exactly one update operation')
                  }
                  const response = await operation.invoke()
                  if (!confirmCardOperation(response, operation)) {
                    throw new Error('C2 final card update unconfirmed')
                  }
                  return response
                },
              })
              return { finished, calls }
            },
            confirmReply: value => card
              ? value?.finished === true && value.calls === 1
              : value?.code === 0 && typeof (value.data?.message_id || value.message_id) === 'string' &&
                !!(value.data?.message_id || value.message_id) })
        }
        phase = 'complete'
        return result
      } catch (error) { return fail(error) }
    },
  })
}

module.exports = { prepareCardTerminalPath }
