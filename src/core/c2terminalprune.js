'use strict'

const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { validatePersistentRelation } = require('./c2persistrelation')

// Development-only cleanup after every terminal intent has a durable ACK.
// A pending or unknown effect keeps the lane for operator review.
function pruneConfirmedTerminal({ journal, coordinator, scope } = {}) {
  if (!journal || typeof journal.snapshot !== 'function' ||
      typeof journal.effectStatus !== 'function' || typeof journal.hasEvent !== 'function' ||
      !coordinator || typeof coordinator.snapshot !== 'function' ||
      typeof coordinator.transition !== 'function' ||
      typeof scope !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(scope)) {
    throw new TypeError('C2 terminal prune needs durable journal, coordinator and scope')
  }
  const durable = journal.snapshot()
  validatePersistentRelation(durable.state, durable.receipts)
  if (durable.cursor !== durable.state.seq ||
      !isDeepStrictEqual(coordinator.snapshot(), durable.state)) {
    throw new Error('C2 terminal prune state differs from authority')
  }
  const lane = durable.state.lanes.terminal?.[scope]
  if (!lane) return false
  if (!lane.finalized || typeof lane.finalEventId !== 'string' ||
      !Array.isArray(lane.pendingEffectIds)) throw new Error('C2 terminal lane is not final')
  for (const effectId of lane.pendingEffectIds) {
    if (journal.effectStatus(effectId) !== 'acked') {
      throw new Error('C2 terminal effect lacks durable ACK')
    }
  }
  // A v2 runner-close session is not settled by queue release. The terminal
  // prune is the first reducer cursor after the external final effect and
  // receipt have been atomically ACKed. Bind that cursor to the exact closed
  // child so restart recovery can finish a crash between ACK and prune.
  const finalEffectId = lane.pendingEffectIds.at(-1)
  const finalDescriptor = journal.effectDescriptor(finalEffectId)
  const v2Final = finalDescriptor?.domain === 'terminal' &&
    ['finalReply', 'quietCompletion'].includes(finalDescriptor.type)
  const session = durable.state.lanes.session?.[scope]
  if (v2Final && !session) {
    throw new Error('C2 terminal prune lacks closed session lane')
  }
  let sessionProof = null
  if (session) {
    const descriptor = finalDescriptor
    const settlement = journal.terminalSettlement(finalEffectId)
    const handoff = durable.state.lanes.handoff?.[scope]
    const turn = durable.state.lanes.turn?.[scope]
    const closed = typeof journal.runnerClosedProofs === 'function'
      ? journal.runnerClosedProofs().filter(proof =>
        proof.receiptId === descriptor?.receiptId && proof.chatId === scope &&
        proof.turnToken === descriptor?.turnToken) : []
    const proof = closed.length === 1 ? closed[0] : null
    const completed = durable.receipts.completed.find(item =>
      item.id === descriptor?.receiptId)
    if (session.settled !== false || session.closeSeen !== true ||
        session.epoch !== descriptor?.turnToken ||
        turn?.epoch !== descriptor?.turnToken || turn?.active !== null ||
        !handoff || !['idle', 'handoff'].includes(handoff.phase) ||
        handoff.turnToken !== descriptor?.turnToken ||
        descriptor?.domain !== 'terminal' || descriptor.scope !== scope ||
        !['finalReply', 'quietCompletion'].includes(descriptor.type) ||
        settlement?.receiptId !== descriptor.receiptId ||
        settlement?.chatId !== scope ||
        settlement?.turnToken !== descriptor.turnToken ||
        completed?.settledAt !== settlement?.settledAt ||
        !isDeepStrictEqual(settlement?.batchReceiptIds, lane.batchReceiptIds) ||
        !isDeepStrictEqual(settlement?.steerReceiptIds, lane.steerReceiptIds) ||
        [...(lane.batchReceiptIds || [descriptor.receiptId]), ...(lane.steerReceiptIds || [])].some(id =>
          !durable.receipts.completed.some(item =>
            item.id === id && item.settledAt === settlement?.settledAt)) ||
        !proof || !/^[0-9a-f]{32}$/.test(proof.generation || '') ||
        proof.evidenceId !==
          `sbot-c2-runner-closed-v1:${descriptor.receiptId}:${proof.generation}` ||
        journal.lookupRunnerClosed(proof.evidenceId)?.dispatchEffectId !==
          proof.dispatchEffectId ||
        journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
        !journal.hasEvent(`sbot-c2-session-close-v1:${descriptor.receiptId}:${proof.generation}`)) {
      throw new Error('C2 terminal prune lacks settled receipt and closed session proof')
    }
    sessionProof = { receiptId: descriptor.receiptId,
      turnToken: descriptor.turnToken, runnerGeneration: proof.generation,
      closeEvidenceId: proof.evidenceId }
  }
  const eventId = `sbot-c2-terminal-prune-v1:${createHash('sha256')
    .update(scope).update('\0').update(lane.finalEventId).digest('hex')}`
  if (journal.hasEvent(eventId)) throw new Error('C2 terminal prune identity already committed')
  const result = coordinator.transition({ id: eventId, domain: 'terminal', scope,
    payload: { type: 'prune', finalEventId: lane.finalEventId,
      effectsConfirmed: true, confirmedEffectIds: [...lane.pendingEffectIds],
      ...(lane.batchReceiptIds ? { batchReceiptIds: [...lane.batchReceiptIds],
        replyTargetReceiptId: lane.replyTargetReceiptId } : {}),
      ...(sessionProof || {}) },
    validate(candidate) {
      if (candidate.effects?.length !== 0 || candidate.decision?.pruned !== true ||
          candidate.state?.lanes?.terminal?.[scope] !== undefined ||
          sessionProof && candidate.state?.lanes?.session?.[scope]?.settled !== true) {
        throw new Error('C2 terminal prune returned invalid decision')
      }
    } })
  if (journal.cursor !== durable.cursor + 1 ||
      !isDeepStrictEqual(result.state, journal.snapshot().state)) {
    throw new Error('C2 terminal prune was not durably committed')
  }
  return true
}

module.exports = { pruneConfirmedTerminal }
