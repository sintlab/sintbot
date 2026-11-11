'use strict'

// User input the durable v2 route refuses before any receipt exists, such as
// an unmigrated chat command or /stop with nothing to stop. No durable write
// happened, so refusing it must not stop the service or sibling groups. Every
// other route error keeps the existing fault contract and closes ingress.
const CODE = 'C2_V2_INPUT_REJECTED'
const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/

function rejectC2Input(message, { reason, notice = null, card = null } = {}) {
  if (typeof message !== 'string' || !message ||
      typeof reason !== 'string' || !/^[a-z][a-z-]{0,40}$/.test(reason) ||
      notice !== null && (typeof notice !== 'string' || !notice) ||
      card !== null && (typeof card !== 'object' || Array.isArray(card))) {
    throw new TypeError('C2 input rejection needs a message, reason and optional notice')
  }
  const error = new Error(message)
  error.code = CODE
  error.reason = reason
  error.notice = notice
  // An optional interactive card (the /model card) sent instead of the text;
  // the text stays the fallback when the card is not confirmed.
  if (card) error.card = card
  return error
}

function isC2InputRejection(error) {
  return !!error && error.code === CODE && typeof error.reason === 'string'
}

// One best-effort reply under the refused message. It is not a durable effect:
// a failure is logged, never retried and never escalated to a fault.
async function answerC2InputRejection({ error, msg, platform, log = () => {} } = {}) {
  if (!isC2InputRejection(error)) throw new TypeError('C2 input rejection expected')
  const target = msg?.replyCtx
  let notified = false
  if (error.notice && typeof platform?.replyOnce === 'function' &&
      typeof msg?.chatId === 'string' && target?.chatId === msg.chatId &&
      FEISHU_MESSAGE_ID.test(target?.messageId || '')) {
    if (error.card && typeof platform.replyCardOnce === 'function') {
      try {
        const response = await platform.replyCardOnce(target, error.card)
        notified = response?.code === 0
      } catch {}
      if (!notified) log(`input rejection card not confirmed (${error.reason}); sending text`)
    }
    if (!notified) {
      try {
        const response = await platform.replyOnce(target, error.notice)
        notified = response?.code === 0
      } catch {}
    }
    if (!notified) log(`input rejection notice not confirmed (${error.reason})`)
  }
  return Object.freeze({ rejected: true, reason: error.reason, notified })
}

module.exports = { rejectC2Input, isC2InputRejection, answerC2InputRejection }
