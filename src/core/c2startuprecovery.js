'use strict'

const { isDeepStrictEqual } = require('node:util')
const { validatePersistentRelation, validatePersistentReceipts } = require('./c2persistrelation')

const JOB_PREFIX = 'receipt:job:'
const MEMBER_PREFIX = 'receipt:member:'

function queuedIds(queue) {
  const jobIds = queue.map(job => job.id)
  const receiptIds = []
  const seen = new Set()
  for (const job of queue) {
    for (const id of [job.id.slice(JOB_PREFIX.length),
      ...(job.batch || []).map(member => member.id.slice(MEMBER_PREFIX.length))]) {
      if (!seen.has(id)) { seen.add(id); receiptIds.push(id) }
    }
  }
  return { jobIds, receiptIds }
}

// Startup has no job bodies, reply contexts, controllers or runner handles.
// Keep ingress shut and persist queue interruption before handing receipts to
// the existing notification protocol. This routine never sends or settles one.
function recoverMissingPayload({ gate, journal, coordinator, scope = null } = {}) {
  if (!gate || typeof gate.close !== 'function' || typeof gate.isClosed !== 'function' ||
      !journal || typeof journal.snapshot !== 'function' || typeof journal.hasEvent !== 'function' ||
      !coordinator || typeof coordinator.snapshot !== 'function' ||
      typeof coordinator.transition !== 'function') {
    throw new TypeError('C2 startup recovery needs gate, journal and coordinator')
  }
  if (scope !== null && (typeof scope !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(scope) || gate.scope !== scope)) {
    throw new TypeError('C2 scoped startup recovery needs matching scoped gate')
  }
  gate.close()
  if (gate.isClosed() !== true) throw new Error('C2 startup ingress is not closed')

  const initial = journal.snapshot()
  validatePersistentReceipts(initial.receipts)
  validatePersistentRelation(initial.state, initial.receipts)
  if (initial.cursor !== initial.state.seq ||
      !isDeepStrictEqual(coordinator.snapshot(), initial.state)) {
    throw new Error('C2 startup state differs from durable authority')
  }

  const interrupted = []
  const scopes = scope === null ? Object.keys(initial.state.lanes.queue || {}).sort() : [scope]
  for (const scope of scopes) {
    const prior = journal.snapshot()
    const queue = prior.state.lanes.queue?.[scope]?.queue
    if (queue === undefined && scopes.length === 1 && gate.scope === scope) continue
    if (!Array.isArray(queue)) throw new Error('C2 startup queue scope changed')
    if (!queue.length) continue
    validatePersistentRelation(prior.state, prior.receipts)
    if (prior.cursor !== prior.state.seq ||
        !isDeepStrictEqual(coordinator.snapshot(), prior.state)) {
      throw new Error('C2 startup cursor changed during recovery')
    }
    const expected = queuedIds(queue)
    const eventId = `sbot-c2-startup-queue-v1:${scope}:${prior.cursor}`
    const expectedEffectId = `sbot-c2-effect-v1:${Buffer.byteLength(eventId)}:${eventId}:0`
    if (Buffer.byteLength(eventId) > 256 || journal.hasEvent(eventId)) {
      throw new Error('C2 startup queue event identity conflict')
    }
    const candidateState = structuredClone(prior.state)
    candidateState.seq++
    candidateState.lastEventId = eventId
    candidateState.lanes.queue[scope].queue = []
    const result = coordinator.transition({ id: eventId, domain: 'queue', scope,
      payload: { type: 'recoverMissingPayload' }, validate(candidate) {
        if (!isDeepStrictEqual(candidate.state, candidateState) ||
            candidate.effects?.length !== 1 ||
            candidate.effects[0].type !== 'interruptMissingPayload' ||
            candidate.effects[0].effectId !== expectedEffectId ||
            !isDeepStrictEqual(candidate.effects[0].jobIds, expected.jobIds) ||
            !isDeepStrictEqual(candidate.effects[0].receiptIds, expected.receiptIds) ||
            candidate.decision?.runLen !== 0 || candidate.decision?.visibleQueue !== 0) {
          throw new Error('C2 startup queue interruption mismatch')
        }
      } })
    if (!journal.hasEvent(eventId) || journal.cursor !== prior.cursor + 1 ||
        !isDeepStrictEqual(coordinator.snapshot(), journal.snapshot().state) ||
        !isDeepStrictEqual(result.state, journal.snapshot().state)) {
      throw new Error('C2 startup queue interruption was not durably committed')
    }
    interrupted.push(...expected.receiptIds)
  }

  const final = journal.snapshot()
  validatePersistentRelation(final.state, final.receipts)
  if (!isDeepStrictEqual(coordinator.snapshot(), final.state) ||
      (scope === null
        ? Object.values(final.state.lanes.queue || {}).some(lane => lane.queue.length)
        : (final.state.lanes.queue?.[scope]?.queue?.length || 0) > 0)) {
    throw new Error('C2 startup queue remains unresolved')
  }
  const pending = final.receipts.pending.filter(item => scope === null || item.chatId === scope)
    .map(item => ({ id: item.id,
    chatId: item.chatId, quiet: item.quiet }))
    .sort((a, b) => a.chatId.localeCompare(b.chatId) || a.id.localeCompare(b.id))
  return { interruptedReceiptIds: [...new Set(interrupted)], pending, ingressClosed: true }
}

module.exports = { recoverMissingPayload }
