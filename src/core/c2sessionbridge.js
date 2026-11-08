'use strict'

// Pure preparation for the v2 runner-close session transition. The caller
// must use its existing single-writer coordinator to commit the returned
// event, then fsync an effect attempt before touching Store. This helper has
// no access to the model session ID after it computes the presence bit.
const { isDeepStrictEqual } = require('node:util')

const HEX32 = /^[0-9a-f]{32}$/

function prepareClosedSessionEvent({ journal, receiptId, chatId, turnToken,
  generation, sessionId = null, aborted, verifyGeneration } = {}) {
  if (!journal || typeof journal.snapshot !== 'function' ||
      typeof journal.lookupRunnerClosed !== 'function' ||
      typeof journal.effectDescriptor !== 'function' ||
      typeof journal.effectStatus !== 'function' ||
      !HEX32.test(receiptId || '') || !HEX32.test(generation || '') ||
      typeof chatId !== 'string' || !chatId ||
      !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
      (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) ||
      typeof aborted !== 'boolean' || typeof verifyGeneration !== 'function' ||
      verifyGeneration.constructor?.name === 'AsyncFunction') {
    throw new TypeError('C2 closed session needs exact runner identity')
  }
  const before = journal.snapshot()
  const evidenceId = `sbot-c2-runner-closed-v1:${receiptId}:${generation}`
  const proof = journal.lookupRunnerClosed(evidenceId)
  const dispatch = proof && journal.effectDescriptor(proof.dispatchEffectId)
  const pending = before.receipts?.pending?.find(item => item.id === receiptId)
  const gate = before.state?.lanes?.turn?.[chatId]
  const handoff = before.state?.lanes?.handoff?.[chatId]
  const session = before.state?.lanes?.session?.[chatId]
  if (journal.blocked || before.state?.version !== 2 ||
      pending?.chatId !== chatId || proof?.receiptId !== receiptId ||
      proof.chatId !== chatId || proof.turnToken !== turnToken ||
      proof.generation !== generation || proof.evidenceId !== evidenceId ||
      dispatch?.type !== 'dispatch' || dispatch.scope !== chatId ||
      dispatch.receiptId !== receiptId || dispatch.turnToken !== turnToken ||
      journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
      gate?.active !== turnToken || gate.epoch !== turnToken ||
      handoff?.phase !== 'running' || handoff.turnToken !== turnToken ||
      (session && (session.epoch > turnToken ||
        session.epoch === turnToken && session.closeSeen === true)) ||
      verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
    throw new Error('C2 closed session lacks accepted running runner proof')
  }
  const eventId = `sbot-c2-session-close-v1:${receiptId}:${generation}`
  if (journal.hasEvent?.(eventId)) throw new Error('C2 session close already committed')
  const payload = { type: 'runnerClosedCommit', receiptId, generation, turnToken,
    closeEvidenceId: evidenceId, sessionIdPresent: sessionId !== null, aborted }
  const expectedTypes = sessionId === null ? [] : aborted
    ? ['writeSession', 'markTainted'] : ['writeSession']
  const validate = candidate => {
    const lane = candidate?.state?.lanes?.session?.[chatId]
    const effects = candidate?.effects
    const descriptors = candidate?.effectDescriptors
    if (candidate?.eventId !== eventId || candidate?.cursor !== before.cursor + 1 ||
        lane?.epoch !== turnToken || lane.closeSeen !== true || lane.settled !== false ||
        !Array.isArray(effects) || !isDeepStrictEqual(effects.map(item => item.type), expectedTypes) ||
        !Array.isArray(descriptors) || descriptors.length !== effects.length ||
        descriptors.some((item, index) => item.effectId !== effects[index].effectId ||
          item.domain !== 'session' || item.scope !== chatId ||
          item.type !== effects[index].type || item.turnToken !== turnToken ||
          item.receiptId !== receiptId || item.targetId !== null)) {
      throw new Error('C2 closed session transition differs from accepted runner')
    }
  }
  return Object.freeze({ id: eventId, domain: 'session', scope: chatId,
    payload: Object.freeze(payload), validate })
}

module.exports = { prepareClosedSessionEvent }
