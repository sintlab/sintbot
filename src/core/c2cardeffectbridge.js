'use strict'

const { C2DurableRuntime } = require('./c2durableruntime')

const RECEIPT_ID = /^[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/

function nonempty(value) { return typeof value === 'string' && value.length > 0 }

// This is deliberately narrower than a generic Feishu success check. A card
// or message ID is required when later operations depend on that target. The
// live target and SDK response remain in memory; only the runtime's hashed
// operation identity and effect outcome may enter its journal.
function confirmCardOperation(response, operation) {
  if (!operation || typeof operation !== 'object') return false
  switch (operation.kind) {
    case 'card.create':
      return response?.code === 0 && nonempty(response?.data?.card_id)
    case 'message.reply':
    case 'message.create':
      return response?.code === 0 &&
        nonempty(response?.data?.message_id || response?.message_id)
    case 'cardElement.content':
      return response === true
    case 'card.update':
    case 'card.settings':
    case 'message.delete':
      return response?.code === 0
    default:
      return false
  }
}

// Pass the returned function only as Feishu's explicit operationBoundary for
// this one live turn. Normal card behavior is unaffected unless the caller
// opts in; a failed or ambiguous operation must propagate instead of falling
// through to a second SDK call.
function createC2CardEffectBoundary({ runtime, receiptId, chatId, turnToken,
  generation, verifyGeneration } = {}) {
  if (!(runtime instanceof C2DurableRuntime) || !RECEIPT_ID.test(receiptId) ||
      !nonempty(chatId) || !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
      !GENERATION.test(generation) || typeof verifyGeneration !== 'function' ||
      verifyGeneration.constructor?.name === 'AsyncFunction') {
    throw new TypeError('C2 card effect bridge needs a live turn authority')
  }
  return operation => runtime.performOutboundCardOperation({ receiptId, chatId,
    turnToken, generation, verifyGeneration, operation,
    confirm: confirmCardOperation })
}

module.exports = { createC2CardEffectBoundary, confirmCardOperation }
