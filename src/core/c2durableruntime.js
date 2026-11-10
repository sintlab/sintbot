'use strict'

const { createHash } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { C2DurableIngress } = require('./c2durableingress')
const { C2DurableJournal } = require('./c2durablejournal')
const { platformMessageEventId, callbackRegistrationId, callbackEventId } = require('./c2eventidentity')
const { C2PayloadHandles } = require('./c2payloadhandles')
const { EngineStepCoordinator } = require('./enginestepcoordinator')
const { engineTerminalStep } = require('../agent/privatecore')
const { recoverAndOpen } = require('./c2recoverygate')
const { pruneConfirmedTerminal } = require('./c2terminalprune')
const { prepareClosedSessionEvent } = require('./c2sessionbridge')

function positiveLimit(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError(`C2 ${label} required`)
  return value
}

const RECEIPT_ID = /^[0-9a-f]{32}$/
const GENERATION = /^[0-9a-f]{32}$/
const CARD_OPERATION_KINDS = new Set(['card.create', 'message.reply',
  'message.create', 'cardElement.content', 'card.update', 'card.settings',
  'message.delete'])

function cardOperationIdentity({ receiptId, turnToken, generation, operation }) {
  if (!operation || typeof operation !== 'object' || Array.isArray(operation) ||
      !CARD_OPERATION_KINDS.has(operation.kind) ||
      typeof operation.operationId !== 'string' || !operation.operationId ||
      Buffer.byteLength(operation.operationId) > 512 ||
      typeof operation.invoke !== 'function' ||
      (operation.kind !== 'card.create' &&
        (typeof operation.cardId !== 'string' || !operation.cardId)) ||
      (['message.reply', 'message.create', 'message.delete', 'card.create']
        .includes(operation.kind) &&
        (typeof operation.chatId !== 'string' || !operation.chatId)) ||
      (operation.kind === 'message.reply' &&
        (typeof operation.replyToMsgId !== 'string' || !operation.replyToMsgId)) ||
      (operation.kind === 'message.delete' &&
        (typeof operation.msgId !== 'string' || !operation.msgId))) {
    throw new TypeError('C2 card operation identity invalid')
  }
  // The Feishu adapter alone supplies a one-call invoke. Hash the stable
  // operation identity with this turn generation; no card/body/target enters
  // the Rust event or durable journal.
  const parts = [receiptId, turnToken, generation, operation.kind,
    operation.operationId]
  const hash = createHash('sha256').update('sbot-c2-card-operation-v1\0')
  for (const part of parts) {
    const bytes = Buffer.from(String(part), 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes)
  }
  const operationId = hash.digest('hex')
  return { operationId,
    eventId: `sbot-c2-card-v1:${receiptId}:${turnToken}:${operationId}` }
}

function cardTargetDigest({ chatId, cardId, msgId }) {
  if (![chatId, cardId, msgId].every(value =>
    typeof value === 'string' && value.length > 0)) {
    throw new TypeError('C2 card cleanup target invalid')
  }
  const hash = createHash('sha256').update('sbot-c2-card-target-v1\0')
  for (const value of [chatId, cardId, msgId]) {
    const bytes = Buffer.from(value, 'utf8')
    hash.update(String(bytes.length)).update(':').update(bytes)
  }
  return hash.digest('hex')
}

function queuedPayloads(snapshot, scope, handles) {
  if (!(handles instanceof C2PayloadHandles) ||
      handles.blocked || !Array.isArray(snapshot.state.lanes.queue?.[scope]?.queue)) {
    throw new Error('C2 atomic release needs verified live queue handles')
  }
  const pending = new Map(snapshot.receipts.pending.map(item => [item.id, item]))
  const queue = snapshot.state.lanes.queue[scope].queue
  const accepted = []
  const seen = new Set()
  const add = id => { if (!seen.has(id)) { seen.add(id); accepted.push(id) } }
  for (const item of queue) {
    const id = item.id?.slice('receipt:job:'.length)
    if (!RECEIPT_ID.test(id) || item.id !== `receipt:job:${id}`) {
      throw new Error('C2 atomic release has unstable queue ID')
    }
    const receipt = pending.get(id)
    const job = handles.requireQueued(id)
    if (!receipt || receipt.chatId !== scope || job?.msg?._c2ReceiptId !== id ||
        job.msg.chatId !== scope || (job.msg.receiptSourceId || job.msg.msgId) !== receipt.sourceId) {
      throw new Error('C2 atomic release queue handle differs from durable receipt')
    }
    add(id)
    if (item.batch) {
      if (!Array.isArray(job.batch) || job.batch.length !== item.batch.length) {
        throw new Error('C2 atomic release batch handle missing')
      }
      for (let index = 0; index < item.batch.length; index++) {
        const memberId = item.batch[index].id?.slice('receipt:member:'.length)
        const member = job.batch[index]
        const memberReceipt = pending.get(memberId)
        if (!RECEIPT_ID.test(memberId) ||
            item.batch[index].id !== `receipt:member:${memberId}` ||
            !memberReceipt || memberReceipt.chatId !== scope ||
            member?._c2ReceiptId !== memberId || member.chatId !== scope ||
            (member.receiptSourceId || member.msgId) !== memberReceipt.sourceId) {
          throw new Error('C2 atomic release batch handle differs from durable receipt')
        }
        add(memberId)
      }
    }
  }
  return { queue, accepted }
}

function queueRunLen(queue) {
  if (!queue.length) return 0
  const { quiet, polled } = queue[0]
  const end = queue.findIndex(item => item.quiet !== quiet || item.polled !== polled)
  return end < 0 ? queue.length : end
}

// The model receives top-level jobs, while a retried job may also contain
// member receipts. Durable terminal settlement must cover every member.
function queueCohortReceiptIds(items) {
  const ids = []
  for (const item of items) {
    for (const handle of [item.id, ...(item.batch || []).map(member => member.id)]) {
      const prefix = handle.startsWith('receipt:job:')
        ? 'receipt:job:' : 'receipt:member:'
      const id = handle.slice(prefix.length)
      if (!RECEIPT_ID.test(id) || handle !== `${prefix}${id}`) {
        throw new Error('C2 queue cohort has unstable receipt handle')
      }
      if (!ids.includes(id)) ids.push(id)
    }
  }
  return ids
}

// Development-only v2 authority. The caller must hold the daemon's single
// writer lock, supply an explicitly opened/initialized journal, and own all
// process-local payloads. This façade never saves a body or reply context.
class C2DurableRuntime {
  #journal
  #coordinator
  #ingress = null
  #resolveTarget
  #send
  #now
  #maxEventCount
  #maxJournalBytes
  #maxCompletionEvents
  #maxCompletionBytes
  #assertWriterLock
  #singleNoticePerGroup
  #opening = false
  #closed = true
  #effectAuthorityReady = false
  #capacitySealed = false
  #scheduledHandoffs = new Map()
  // A dispatch receipt is only a live capability in this process. Reopen
  // cannot reconstruct its body or prove which pending sibling was running.
  #activeRuns = new Map()
  #terminalAwaitingSettlement = new Map()
  #externalEffectInFlight = false
  #gate = {
    close: () => { this.#closed = true },
    open: () => { this.#closed = false },
    isClosed: () => this.#closed,
  }

  constructor({ journal, resolveTarget, send, now = Date.now,
    maxEventCount, maxJournalBytes, maxCompletionEvents, maxCompletionBytes,
    assertWriterLock = null, singleNoticePerGroup = false } = {}) {
    if (!(journal instanceof C2DurableJournal) || typeof journal.snapshot !== 'function' ||
        typeof journal.appendTransition !== 'function' ||
        typeof journal.byteLength !== 'number' || journal.byteLength <= 0 ||
        typeof resolveTarget !== 'function' || typeof send !== 'function' ||
        typeof now !== 'function' ||
        (assertWriterLock !== null &&
          (typeof assertWriterLock !== 'function' ||
            assertWriterLock.constructor?.name === 'AsyncFunction')) ||
        typeof singleNoticePerGroup !== 'boolean') {
      throw new TypeError('C2 runtime needs an explicit journal and recovery sender')
    }
    this.#journal = journal
    this.#coordinator = new EngineStepCoordinator({ journal })
    this.#resolveTarget = resolveTarget
    this.#send = send
    this.#now = now
    this.#assertWriterLock = assertWriterLock
    this.#singleNoticePerGroup = singleNoticePerGroup
    this.#maxEventCount = positiveLimit(maxEventCount, 'event limit')
    this.#maxJournalBytes = positiveLimit(maxJournalBytes, 'journal byte limit')
    this.#maxCompletionEvents = positiveLimit(maxCompletionEvents ?? maxEventCount,
      'completion event reserve')
    this.#maxCompletionBytes = positiveLimit(maxCompletionBytes ?? maxJournalBytes,
      'completion byte reserve')
    if (!Number.isSafeInteger(this.#maxEventCount + this.#maxCompletionEvents) ||
        !Number.isSafeInteger(this.#maxJournalBytes + this.#maxCompletionBytes)) {
      throw new RangeError('C2 authority limits exceed safe integer range')
    }
  }

  get blocked() { return this.#closed || this.#opening || this.#externalEffectInFlight || !this.#ingress ||
    this.#ingress.blocked || this.#journal.blocked }

  // Closed or sealed for good. Unlike `blocked`, an outbound effect that is
  // still awaiting its platform response does not count: a streaming card's
  // next frame queues behind it instead of failing the turn.
  get closed() { return this.#closed || !this.#ingress || this.#ingress.blocked ||
    this.#journal.blocked }

  hasRecoveryPolicy({ assertWriterLock, singleNoticePerGroup } = {}) {
    return typeof assertWriterLock === 'function' &&
      this.#assertWriterLock === assertWriterLock &&
      this.#singleNoticePerGroup === singleNoticePerGroup
  }

  // A scope-labelled gate must not be mistaken for a scoped runtime lease.
  // The current callbacks and failure catches still close the whole runtime,
  // while open() discards every group's live capabilities. Keep this contract
  // visibly closed until all effect/callback paths can fence one group only.
  scopedGate(chatId) {
    if (typeof chatId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(chatId) ||
        ['__proto__', 'constructor', 'prototype'].includes(chatId)) {
      throw new TypeError('C2 scoped runtime chat ID invalid')
    }
    const unavailable = () => {
      throw new Error('C2 scoped runtime close/open unavailable; global authority unchanged')
    }
    return Object.freeze({ scope: chatId, close: unavailable, open: unavailable,
      isClosed: () => true })
  }

  closeScope(chatId) { this.scopedGate(chatId).close() }

  async recoverScope(chatId) { this.scopedGate(chatId).open() }

  #capacity() {
    const snapshot = this.#journal.snapshot()
    if (!Number.isSafeInteger(snapshot.eventCount) || snapshot.eventCount < 0 ||
        !Number.isSafeInteger(this.#journal.byteLength) || this.#journal.byteLength <= 0) {
      this.close()
      throw new Error('C2 durable authority capacity unreadable')
    }
    if (snapshot.eventCount >= this.#maxEventCount ||
        this.#journal.byteLength >= this.#maxJournalBytes) {
      this.#sealForCapacity()
      throw new Error('C2 durable authority capacity reached; ingress closed')
    }
    return snapshot
  }

  #completionCapacity() {
    if (!this.#effectAuthorityReady || this.#opening || this.#externalEffectInFlight ||
        this.#journal.blocked ||
        (this.#closed && !this.#capacitySealed)) {
      throw new Error('C2 durable completion authority closed')
    }
    const snapshot = this.#journal.snapshot()
    if (snapshot.eventCount >= this.#maxEventCount + this.#maxCompletionEvents ||
        this.#journal.byteLength >= this.#maxJournalBytes + this.#maxCompletionBytes) {
      this.#sealForCapacity()
      throw new Error('C2 durable completion reserve exhausted; manual recovery required')
    }
    return snapshot
  }

  async open() {
    if (this.#externalEffectInFlight) throw new Error('C2 external effect still in flight')
    if (this.#opening) throw new Error('C2 runtime startup already in progress')
    if (!this.blocked) return this.snapshot()
    this.#opening = true
    this.#ingress = null
    this.#effectAuthorityReady = false
    this.#capacitySealed = false
    this.#scheduledHandoffs.clear()
    this.#activeRuns.clear()
    this.#terminalAwaitingSettlement.clear()
    this.#gate.close()
    try {
      // Capacity limits new ingress. Recovery must still settle already
      // accepted receipts before deciding whether new work may enter.
      await recoverAndOpen({ gate: this.#gate, journal: this.#journal,
        coordinator: this.#coordinator, resolveTarget: this.#resolveTarget,
        send: this.#send, now: this.#now,
        assertWriterLock: this.#assertWriterLock,
        singleNoticePerGroup: this.#singleNoticePerGroup })
      this.#capacity()
      this.#ingress = C2DurableIngress.resumeAfterVerifiedRecovery({
        journal: this.#journal, coordinator: this.#coordinator, gate: this.#gate })
      this.#effectAuthorityReady = true
      return this.snapshot()
    } catch (error) {
      this.close()
      throw error
    } finally { this.#opening = false }
  }

  close() {
    this.#gate.close()
    this.#ingress = null
    this.#effectAuthorityReady = false
    this.#capacitySealed = false
    this.#scheduledHandoffs.clear()
    this.#activeRuns.clear()
    this.#terminalAwaitingSettlement.clear()
  }

  #sealForCapacity() {
    this.#gate.close()
    this.#ingress = null
    this.#capacitySealed = true
  }

  enqueueMessage(options) {
    if (this.blocked) throw new Error('C2 durable runtime ingress closed')
    this.#capacity()
    const result = this.#ingress.enqueueMessage(options)
    if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
        this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  // A visible busy receipt remains pending after its queue acknowledgement.
  // The effect descriptor and target identity are durable before any send;
  // only the same process may turn one attempted call into an ACK.
  prepareSteer({ receiptId, chatId, parentReceiptId, turnToken, generation, payloadHandles } = {}) {
    const before = this.#completionCapacity()
    const witness = this.#activeRuns.get(chatId)
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const job = payloadHandles?.requireQueued(receiptId)
    if (!RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '') ||
        receipt?.chatId !== chatId || receipt.source !== 'message' || receipt.quiet ||
        job?.msg?._c2ReceiptId !== receiptId || witness?.receiptId !== parentReceiptId ||
        witness.turnToken !== turnToken || this.#journal.effectStatus(witness.dispatchEffectId) !== 'acked' ||
        this.#journal.lookupRegistration(callbackRegistrationId({ receiptId: parentReceiptId,
          generation, domain: 'atomicHandoff', kind: 'runnerAccepted' }))?.generation !== generation) {
      throw new Error('C2 steer lacks accepted live parent and queued receipt')
    }
    const id = `sbot-c2-steer-v1:${receiptId}:${generation}:prepare`
    try {
      const result = this.#coordinator.transition({ id, domain: 'steer', scope: chatId,
        payload: { type: 'prepare', receiptId, parentReceiptId, turnToken, generation },
        validate: candidate => {
          const effect = candidate.effects[0]
          if (candidate.effects.length !== 1 || effect.type !== 'callSteer' ||
              effect.receiptId !== receiptId || effect.turnToken !== turnToken ||
              candidate.effectDescriptors[0].receiptId !== receiptId) throw new Error('C2 steer decision invalid')
        } })
      return { effectId: result.effects[0].effectId, receiptId, chatId,
        parentReceiptId, turnToken, generation }
    } catch (error) { this.close(); throw error }
  }

  commitSteerObservation({ receiptId, chatId, parentReceiptId, turnToken, generation, type } = {}) {
    const before = this.#completionCapacity()
    const entry = before.state.lanes.steer?.[chatId]?.entries.find(item => item.receiptId === receiptId)
    const lane = before.state.lanes.steer?.[chatId]
    if (!entry || lane.parentReceiptId !== parentReceiptId || lane.turnToken !== turnToken ||
        lane.generation !== generation || !['accepted', 'rejected', 'landed'].includes(type) ||
        this.#journal.effectStatus(entry.effectId) !== 'acked') throw new Error('C2 steer observation lacks confirmed RPC')
    if (entry.status === 'landed' && type === 'landed') return false
    try {
      this.#coordinator.transition({ id: `sbot-c2-steer-v1:${receiptId}:${generation}:${type}`,
        domain: 'steer', scope: chatId,
        payload: { type, receiptId, parentReceiptId, turnToken, generation } })
      return true
    } catch (error) { this.close(); throw error }
  }

  async executeSteer(identity, { invoke, assertWriterLock } = {}) {
    this.#completionCapacity()
    const { effectId, receiptId, chatId, parentReceiptId, turnToken, generation } = identity || {}
    const descriptor = this.#journal.effectDescriptor(effectId)
    if (descriptor?.domain !== 'steer' || descriptor.type !== 'callSteer' ||
        descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== turnToken || this.#journal.effectStatus(effectId) !== 'pending' ||
        typeof invoke !== 'function' || typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction' || assertWriterLock() !== true) {
      throw new Error('C2 steer attempt lacks exact RPC authority')
    }
    const attemptedAt = this.#now()
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let accepted, known = false
      try {
        accepted = await invoke()
        known = typeof accepted === 'boolean' && this.#effectAuthorityReady && assertWriterLock() === true
      } catch { /* A transport failure may already have delivered the message. */ }
      this.#journal.recordEffectOutcome({ effectId, status: known ? 'acked' : 'unknown',
        resolvedAt: Math.max(attemptedAt, this.#now()) })
      if (!known) throw new Error('C2 steer outcome unknown; replay forbidden')
      this.commitSteerObservation({ receiptId, chatId, parentReceiptId, turnToken, generation,
        type: accepted ? 'accepted' : 'rejected' })
      return accepted
    } catch (error) { this.close(); throw error }
  }

  cancelClosedSteer({ chatId, parentReceiptId, turnToken, generation, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    const lane = before.state.lanes.steer?.[chatId]
    if (!lane) return []
    const closeEvidenceId = `sbot-c2-runner-closed-v1:${parentReceiptId}:${generation}`
    const proof = this.#journal.lookupRunnerClosed(closeEvidenceId)
    if (typeof assertWriterLock !== 'function' || assertWriterLock.constructor?.name === 'AsyncFunction' ||
        assertWriterLock() !== true || proof?.chatId !== chatId || proof.receiptId !== parentReceiptId ||
        proof.generation !== generation || proof.turnToken !== turnToken ||
        lane.entries.some(entry => this.#journal.effectStatus(entry.effectId) !== 'acked')) {
      throw new Error('C2 steer cancellation lacks exact closed RPC authority')
    }
    const ids = lane.entries.map(entry => entry.receiptId)
    const settledAt = this.#now()
    const receipts = { pending: before.receipts.pending.filter(item => !ids.includes(item.id)),
      completed: [...before.receipts.completed, ...ids.map(id => ({ id, settledAt }))] }
    try {
      this.#coordinator.transition({ id: `sbot-c2-steer-cancel-v1:${parentReceiptId}:${generation}`,
        domain: 'steer', scope: chatId, payload: { type: 'cancelAll', parentReceiptId,
          turnToken, generation, runnerClosed: true, closeEvidenceId }, receipts,
        validate: result => {
          if (!isDeepStrictEqual(result.decision.cancelledReceiptIds, ids) || result.effects.length) {
            throw new Error('C2 steer cancellation result invalid')
          }
        } })
      return ids
    } catch (error) { this.close(); throw error }
  }

  prepareQueueNotice({ receiptId, chatId, payloadHandles } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId || '') ||
        typeof chatId !== 'string' || !chatId ||
        !(payloadHandles instanceof C2PayloadHandles) || payloadHandles.blocked) {
      throw new TypeError('C2 queue notice identity invalid')
    }
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const queue = before.state.lanes.queue?.[chatId]?.queue
    const index = queue?.findIndex(item => item.id === `receipt:job:${receiptId}`)
    const witness = this.#activeRuns.get(chatId)
    const item = index >= 0 ? queue[index] : null
    const target = payloadHandles.requireQueued(receiptId)?.msg
    const visibleQueue = queue?.filter(job => !job.quiet && !job.polled).length
    const eventId = `sbot-c2-queue-notice-v1:${receiptId}`
    if (!receipt || receipt.chatId !== chatId || receipt.source !== 'message' ||
        receipt.quiet || !Array.isArray(queue) || index < 0 ||
        item.quiet || item.polled || item.batch !== undefined ||
        !Number.isSafeInteger(visibleQueue) || visibleQueue <= 0 ||
        target?._c2ReceiptId !== receiptId || target.chatId !== chatId ||
        (target.receiptSourceId || target.msgId) !== receipt.sourceId ||
        target.replyCtx?.chatId !== chatId ||
        target.replyCtx.messageId !== receipt.sourceId ||
        !witness || before.state.lanes.turn?.[chatId]?.active !== witness.turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== witness.turnToken ||
        this.#journal.hasEvent(eventId) ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 queue notice lacks exact pending busy receipt')
    }
    try {
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'queue',
        scope: chatId, payload: { type: 'prepareQueueNotice', receiptId,
          queueIndex: index, visibleQueue },
        validate: candidate => {
          const effect = candidate.effects?.[0]
          const descriptor = candidate.effectDescriptors?.[0]
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.state?.seq !== candidate.cursor ||
              !isDeepStrictEqual(candidate.state.lanes, before.state.lanes) ||
              candidate.effects?.length !== 1 || effect?.type !== 'queueNotice' ||
              effect.receiptId !== receiptId || effect.visibleQueue !== visibleQueue ||
              descriptor?.effectId !== effect.effectId ||
              descriptor.domain !== 'queue' || descriptor.scope !== chatId ||
              descriptor.type !== 'queueNotice' || descriptor.turnToken !== null ||
              descriptor.receiptId !== receiptId || descriptor.targetId !== null ||
              candidate.decision?.receiptId !== receiptId ||
              candidate.decision.queueIndex !== index ||
              candidate.decision.visibleQueue !== visibleQueue ||
              candidate.decision.receiptSettlement !== false) {
            throw new Error('C2 queue notice result invalid')
          }
        } })
      const result = prepared.commit()
      return { effectId: result.effects[0].effectId, receiptId, chatId,
        queueIndex: index, visibleQueue }
    } catch (error) { this.close(); throw error }
  }

  async executeQueueNotice({ effectId, receiptId, chatId, payloadHandles,
    assertWriterLock, perform, confirm } = {}) {
    const before = this.#completionCapacity()
    const descriptor = this.#journal.effectDescriptor(effectId)
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const queue = before.state.lanes.queue?.[chatId]?.queue
    const target = payloadHandles instanceof C2PayloadHandles &&
      !payloadHandles.blocked ? payloadHandles.requireQueued(receiptId)?.msg : null
    if (!RECEIPT_ID.test(receiptId || '') || !receipt ||
        receipt.chatId !== chatId || receipt.source !== 'message' || receipt.quiet ||
        descriptor?.domain !== 'queue' || descriptor.scope !== chatId ||
        descriptor.type !== 'queueNotice' || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== null || descriptor.targetId !== null ||
        this.#journal.effectStatus(effectId) !== 'pending' ||
        !Array.isArray(queue) || !queue.some(item =>
          item.id === `receipt:job:${receiptId}` && !item.quiet && !item.polled &&
          item.batch === undefined) ||
        target?._c2ReceiptId !== receiptId || target.chatId !== chatId ||
        (target.receiptSourceId || target.msgId) !== receipt.sourceId ||
        target.replyCtx?.chatId !== chatId ||
        target.replyCtx.messageId !== receipt.sourceId ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction' ||
        typeof perform !== 'function' || typeof confirm !== 'function' ||
        confirm.constructor?.name === 'AsyncFunction' ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
        assertWriterLock() !== true) {
      throw new Error('C2 queue notice lacks exact live target and effect')
    }
    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      throw new TypeError('C2 queue notice time invalid')
    }
    this.#externalEffectInFlight = true
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let confirmed = false
      let response
      try {
        response = await perform({ effectId, target: target.replyCtx })
        confirmed = confirm(response) === true &&
          this.#effectAuthorityReady && assertWriterLock() === true
      } catch { /* The platform call may have succeeded. */ }
      const now = this.#now()
      const resolvedAt = Number.isSafeInteger(now) && now >= attemptedAt
        ? now : attemptedAt
      this.#journal.recordEffectOutcome({ effectId,
        status: confirmed ? 'acked' : 'unknown', resolvedAt })
      if (!confirmed) throw new Error('C2 queue notice outcome unknown')
      return { effectId, receiptId, status: 'acked', response }
    } catch (error) { this.close(); throw error }
    finally { this.#externalEffectInFlight = false }
  }

  #retainActiveRun(scope, result, receiptId, jobReceiptIds, batchReceiptIds) {
    const turnToken = result.decision?.turnToken
    const dispatch = result.effects?.find(item => item.type === 'dispatch')
    const descriptor = dispatch && this.#journal.effectDescriptor(dispatch.effectId)
    const durable = this.#journal.snapshot()
    if (!RECEIPT_ID.test(receiptId) || !Array.isArray(jobReceiptIds) ||
        !Array.isArray(batchReceiptIds) || !jobReceiptIds.includes(receiptId) ||
        !batchReceiptIds.includes(receiptId) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        descriptor?.type !== 'dispatch' || descriptor.domain !== 'atomicHandoff' ||
        descriptor.scope !== scope || descriptor.turnToken !== turnToken ||
        descriptor.receiptId !== receiptId ||
        durable.state.lastEventId !== result.eventId ||
        durable.state.lanes.turn?.[scope]?.active !== turnToken ||
        durable.state.lanes.handoff?.[scope]?.phase !== 'running' ||
        durable.state.lanes.handoff[scope].turnToken !== turnToken ||
        !isDeepStrictEqual(durable.state.lanes.handoff[scope].acceptedReceiptIds,
          batchReceiptIds.length > 1 ? batchReceiptIds : [])) {
      throw new Error('C2 running receipt witness differs from durable dispatch')
    }
    this.#activeRuns.set(scope, { receiptId, turnToken, eventId: result.eventId,
      dispatchEffectId: dispatch.effectId, jobReceiptIds: [...jobReceiptIds],
      batchReceiptIds: [...batchReceiptIds] })
  }

  // One accepted queue head becomes a running turn under a single fsynced
  // cursor. Raw jobs remain in the process-local registry until the caller
  // consumes the committed dispatch; nothing may run before this returns.
  commitInitialDispatch({ receiptId, payloadHandles } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId)) throw new TypeError('C2 initial dispatch receipt invalid')
    const before = this.#journal.snapshot()
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    if (!receipt) throw new Error('C2 initial dispatch lacks pending receipt')
    const scope = receipt.chatId
    if (this.#terminalAwaitingSettlement.has(scope)) {
      throw new Error('C2 prior terminal receipt has not settled')
    }
    const { queue } = queuedPayloads(before, scope, payloadHandles)
    if (!queue.length ||
        before.state.lanes.handoff?.[scope]?.phase !== undefined &&
          before.state.lanes.handoff[scope].phase !== 'idle' ||
        before.state.lanes.turn?.[scope]?.active != null ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 initial dispatch differs from durable idle queue')
    }
    const runLen = queueRunLen(queue)
    const taken = queue.slice(0, runLen)
    const remaining = queue.slice(runLen)
    const jobReceiptIds = taken.map(item => item.id.slice('receipt:job:'.length))
    const batchReceiptIds = queueCohortReceiptIds(taken)
    const expectedAnchor = [...taken].reverse().find(item => !item.synthetic)?.id ||
      taken.at(-1)?.id
    if (expectedAnchor !== `receipt:job:${receiptId}`) {
      throw new Error('C2 initial dispatch anchor differs from queue decision')
    }
    const id = platformMessageEventId({ receiptId, domain: 'atomicHandoff',
      kind: 'initialDispatchCommit', lookupReceipt: key =>
        before.receipts.pending.find(item => item.id === key) || null })
    if (this.#journal.hasEvent(id)) throw new Error('C2 initial dispatch already committed')
    try {
      const prepared = this.#coordinator.prepare({ id, domain: 'atomicHandoff', scope,
        payload: { type: 'initialDispatchCommit' },
        validate: candidate => {
          const token = candidate.decision?.turnToken
          const dispatch = candidate.decision?.queueDispatch
          const effect = candidate.effects?.[0]
          if (candidate.cursor !== before.cursor + 1 || candidate.state?.seq !== candidate.cursor ||
              !Number.isSafeInteger(token) || token <= 0 ||
              candidate.state.lanes.turn?.[scope]?.active !== token ||
              candidate.state.lanes.handoff?.[scope]?.phase !== 'running' ||
              candidate.state.lanes.handoff[scope].turnToken !== token ||
              !isDeepStrictEqual(candidate.state.lanes.queue?.[scope]?.queue, remaining) ||
              dispatch?.type !== 'dispatch' ||
              !taken.some(item => item.id === dispatch.anchor) ||
              !isDeepStrictEqual(dispatch.batch, taken.flatMap(item =>
                item.batch?.map(member => member.id) || [item.id])) ||
              !isDeepStrictEqual(candidate.decision.jobReceiptIds, jobReceiptIds) ||
              !isDeepStrictEqual(candidate.decision.batchReceiptIds, batchReceiptIds) ||
              !isDeepStrictEqual(candidate.state.lanes.handoff[scope].acceptedReceiptIds,
                batchReceiptIds.length > 1 ? batchReceiptIds : []) ||
              candidate.decision.queueRunLen !== queueRunLen(remaining) ||
              candidate.decision.visibleQueue !== remaining.filter(item =>
                !item.quiet && !item.polled).length ||
              candidate.effects.length !== 1 || effect.type !== 'dispatch' ||
              effect.origin !== 'queue' || effect.turnToken !== token ||
              effect.effectId !== `sbot-c2-effect-v1:${Buffer.byteLength(id)}:${id}:0`) {
            throw new Error('C2 initial dispatch result invalid')
          }
        } })
      const result = prepared.commit()
      this.#retainActiveRun(scope, result, receiptId, jobReceiptIds, batchReceiptIds)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { ...result, jobReceiptIds, batchReceiptIds }
    } catch (error) { this.close(); throw error }
  }

  // The model process may only start after its dispatch effect has an fsynced
  // attempt. A trusted runner hook confirms acceptance before any turn event
  // reaches Engine. Losing either side leaves an ambiguous attempt closed on
  // restart; no process relaunch is inferred from a pending receipt.
  beginRunnerStart({ receiptId, chatId, turnToken, generation,
    verifyGeneration } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !GENERATION.test(generation) || typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 runner start identity invalid')
    }
    const witness = this.#activeRuns.get(chatId)
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const effectId = witness?.dispatchEffectId
    const descriptor = effectId && this.#journal.effectDescriptor(effectId)
    if (!receipt || receipt.chatId !== chatId || witness?.receiptId !== receiptId ||
        witness?.turnToken !== turnToken ||
        !this.#matchesRunningReceipts(before, witness, chatId, receiptId, turnToken) ||
        descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
        descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== turnToken ||
        this.#journal.effectStatus(effectId) !== 'pending' ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
        verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
      throw new Error('C2 runner start lacks exact live dispatch authority')
    }
    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      throw new TypeError('C2 runner start time invalid')
    }
    const registrationId = callbackRegistrationId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'runnerAccepted' })
    try {
      this.#journal.registerCallback({ id: registrationId, receiptId, generation,
        domain: 'atomicHandoff', kind: 'runnerAccepted', ordinal: 0,
        registeredAt: attemptedAt })
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
    } catch (error) { this.close(); throw error }

    let phase = 'attempting'
    // Two host witnesses prove that no model turn began: the exec child never
    // spawned (no pid), or the App Server rejected initialize/thread before
    // any turn/start and its child has already closed.
    const runnerNotStartedWitness = failure => {
      const keys = failure && typeof failure === 'object' ? Object.keys(failure).sort() : []
      return (isDeepStrictEqual(keys, ['backend', 'code', 'pid']) &&
          failure.backend === 'codex-exec' && failure.code === 'ENOENT' && failure.pid === null) ||
        (isDeepStrictEqual(keys, ['backend', 'closed', 'code', 'turnStarted']) &&
          failure.backend === 'codex-app-server' && failure.code === 'THREAD_REJECTED' &&
          failure.turnStarted === false && failure.closed === true)
    }
    const onSpawnFailed = (failure) => {
      if (phase !== 'attempting' || !runnerNotStartedWitness(failure) ||
          !isDeepStrictEqual(witness.jobReceiptIds, [receiptId]) ||
          !isDeepStrictEqual(witness.batchReceiptIds, [receiptId]) ||
          verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true ||
          this.#assertWriterLock?.() !== true) {
        throw new Error('C2 runner not-started lacks exact single-receipt witness')
      }
      const current = this.#journal.snapshot()
      if (current.state.lanes.turn?.[chatId]?.active !== turnToken ||
          current.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          this.#journal.effectStatus(effectId) !== 'attempting' ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), current.state)) {
        throw new Error('C2 runner not-started authority changed')
      }
      try {
        const now = this.#now()
        const evidenceId = this.#journal.recordRunnerNotStarted({ receiptId, chatId,
          turnToken, generation, dispatchEffectId: effectId,
          resolvedAt: Number.isSafeInteger(now) && now >= attemptedAt ? now : attemptedAt })
        phase = 'notStarted'
        const eventId = `sbot-c2-runner-not-started-commit-v1:${receiptId}:${turnToken}:${generation}`
        const result = this.#coordinator.transition({ id: eventId,
          domain: 'runnerStartFailure', scope: chatId,
          payload: { type: 'abortUnstartedDispatch', receiptId, turnToken,
            runnerGeneration: generation, dispatchEffectId: effectId,
            notStartedEvidenceId: evidenceId },
          validate: candidate => {
            if (candidate.effects.length ||
                !isDeepStrictEqual(candidate.decision,
                  { abandonedReceiptId: receiptId, requiresStartupRecovery: true,
                    scope: chatId, dispatchEffectId: effectId })) {
              throw new Error('C2 runner not-started decision invalid')
            }
          } })
        if (result.decision.requiresStartupRecovery !== true) {
          throw new Error('C2 runner not-started recovery not required')
        }
        this.close()
        return true
      } catch (error) { this.close(); throw error }
    }
    const markUnknown = () => {
      if (phase !== 'attempting') return false
      phase = 'unknown'
      try {
        const now = this.#now()
        this.#journal.recordEffectOutcome({ effectId, status: 'unknown',
          resolvedAt: Number.isSafeInteger(now) && now >= attemptedAt ? now : attemptedAt })
      } finally { this.close() }
      return true
    }
    const onTurnAccepted = (accepted) => {
      if (phase !== 'attempting') throw new Error('C2 runner start callback already resolved')
      const registered = this.#journal.lookupRegistration(registrationId)
      const current = this.#journal.snapshot()
      const active = this.#activeRuns.get(chatId)
      const validChannel = ['claude-code', 'codex-exec', 'codex-app-server']
        .includes(accepted?.channel)
      const validIdentity = typeof accepted?.sessionId === 'string' &&
        accepted.sessionId.length > 0 &&
        (accepted.channel !== 'codex-app-server' ||
          typeof accepted.turnId === 'string' && accepted.turnId.length > 0)
      if (!validChannel || !validIdentity || !this.#effectAuthorityReady ||
          registered?.generation !== generation || registered?.receiptId !== receiptId ||
          active?.receiptId !== receiptId || active.turnToken !== turnToken ||
          current.state.lanes.turn?.[chatId]?.active !== turnToken ||
          current.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          current.state.lanes.handoff[chatId].turnToken !== turnToken ||
          verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
        markUnknown()
        throw new Error('C2 runner acceptance differs from live dispatch')
      }
      const now = this.#now()
      try {
        this.#journal.recordEffectOutcome({ effectId, status: 'acked',
          resolvedAt: Number.isSafeInteger(now) && now >= attemptedAt ? now : attemptedAt,
          registrationId })
        phase = 'acked'
        return { effectId, status: 'acked' }
      } catch (error) { this.close(); throw error }
    }
    return { effectId, onTurnAccepted, onSpawnFailed, markUnknown }
  }

  // A trusted runner wrapper calls this only after its process/turn close is
  // observed. The synchronous host witness is not persisted verbatim: only
  // exact receipt/generation/turn/accepted-dispatch identity is fsynced. A
  // future global-fault transition may require this ID, but must separately
  // reconcile every external effect before mutating active lanes.
  confirmRunnerClosed({ receiptId, chatId, turnToken, generation,
    verifyGeneration, assertRunnerClosed } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !GENERATION.test(generation) || typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction' ||
        typeof assertRunnerClosed !== 'function' ||
        assertRunnerClosed.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 runner close identity invalid')
    }
    const witness = this.#activeRuns.get(chatId)
    const effectId = witness?.dispatchEffectId
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const descriptor = effectId && this.#journal.effectDescriptor(effectId)
    if (!receipt || receipt.chatId !== chatId || witness?.receiptId !== receiptId ||
        witness?.turnToken !== turnToken ||
        !this.#matchesRunningReceipts(before, witness, chatId, receiptId, turnToken) ||
        descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
        descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== turnToken ||
        this.#journal.effectStatus(effectId) !== 'acked' ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
        verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true ||
        assertRunnerClosed({ chatId, receiptId, turnToken, generation }) !== true) {
      throw new Error('C2 runner close lacks exact stopped runner authority')
    }
    try {
      const closedAt = this.#now()
      const evidenceId = this.#journal.recordRunnerClosed({ receiptId, chatId,
        turnToken, generation, dispatchEffectId: effectId, closedAt })
      if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { evidenceId, receiptId, chatId, turnToken,
        runnerGeneration: generation, runnerClosed: true }
    } catch (error) { this.close(); throw error }
  }

  // One closed runner may write its process-local session ID only after a
  // generation-bound reducer decision and fsynced effect attempts. Neither
  // the session ID nor Store content enters the journal. A failed Store write
  // or outcome ACK is ambiguous and seals this authority for reconciliation.
  commitClosedRunnerSession({ receiptId, chatId, turnToken, generation,
    sessionId = null, aborted, verifyGeneration, assertWriterLock, store,
    usageDecision = null } = {}) {
    const before = this.#completionCapacity()
    if (!store || typeof store.setSessionAtomic !== 'function' ||
        store.setSessionAtomic.constructor?.name === 'AsyncFunction' ||
        typeof store.getSession !== 'function' ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction' ||
        (sessionId !== null && (typeof sessionId !== 'string' || !sessionId)) ||
        (usageDecision !== null && (sessionId === null ||
          typeof store.getSessionStats !== 'function' || !usageDecision ||
          usageDecision.write !== true || !usageDecision.stats ||
          typeof usageDecision.stats !== 'object' ||
          usageDecision.stats.sessionId !== sessionId))) {
      throw new TypeError('C2 closed session needs synchronous Store authority')
    }
    let locked = false
    try { locked = assertWriterLock() === true } catch { /* lost lock is fatal */ }
    if (!locked) {
      this.close()
      throw new Error('C2 closed session lost single-writer lock')
    }
    const witness = this.#activeRuns.get(chatId)
    if (witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 closed session lacks live running dispatch')
    }
    const prepared = prepareClosedSessionEvent({ journal: this.#journal,
      receiptId, chatId, turnToken, generation, sessionId, aborted,
      verifyGeneration })
    let result
    let attemptedAt = null
    const attempted = []
    try {
      result = this.#coordinator.prepare(prepared).commit()
      if (assertWriterLock() !== true) {
        throw new Error('C2 closed session lost single-writer lock')
      }
      if (result.effects.length) {
        this.#externalEffectInFlight = true
        attemptedAt = this.#now()
        if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
          throw new TypeError('C2 closed session attempt time invalid')
        }
        for (const effect of result.effects) {
          this.#journal.beginEffectAttempt({ effectId: effect.effectId, attemptedAt })
          attempted.push(effect.effectId)
        }
        if (assertWriterLock() !== true) {
          throw new Error('C2 closed session lost single-writer lock')
        }
        const saved = store.setSessionAtomic(chatId, sessionId,
          { tainted: aborted === true,
            ...(usageDecision === null ? {} : { sessionStats: usageDecision.stats }) })
        if (saved && typeof saved.then === 'function' ||
            store.getSession(chatId) !== sessionId ||
            (usageDecision !== null &&
              !isDeepStrictEqual(store.getSessionStats?.(chatId), usageDecision.stats)) ||
            assertWriterLock() !== true) {
          throw new Error('C2 closed session Store write unconfirmed')
        }
        const resolvedAt = Math.max(attemptedAt, this.#now())
        for (const effectId of attempted) {
          this.#journal.recordEffectOutcome({ effectId, status: 'acked', resolvedAt })
        }
      }
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { cursor: result.cursor, eventId: result.eventId,
        effectIds: result.effects.map(effect => effect.effectId),
        sessionWritten: sessionId !== null }
    } catch (error) {
      if (attemptedAt !== null) {
        for (const effectId of attempted) {
          if (this.#journal.effectStatus(effectId) !== 'attempting') continue
          try {
            this.#journal.recordEffectOutcome({ effectId, status: 'unknown',
              resolvedAt: Math.max(attemptedAt, this.#now()) })
          } catch { /* a failed journal write remains ambiguous on disk */ }
        }
      }
      this.close()
      throw error
    } finally { this.#externalEffectInFlight = false }
  }

  registerReleaseRequestedCallback({ receiptId, generation, registeredAt } = {}) {
    this.#completionCapacity()
    const id = callbackRegistrationId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'releaseRequestedCommit' })
    const result = this.#journal.registerCallback({ id, receiptId, generation,
      domain: 'atomicHandoff', kind: 'releaseRequestedCommit', ordinal: 0,
      registeredAt })
    if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  // The runner completion callback is registered before exposure. Its request
  // invalidates the old turn and enters releasing in one durable transition.
  commitReleaseRequested({ receiptId, generation, turnToken, payloadHandles } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || !GENERATION.test(generation) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0) {
      throw new TypeError('C2 release request identity invalid')
    }
    const before = this.#journal.snapshot()
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    if (!receipt) throw new Error('C2 release request lacks pending turn receipt')
    const scope = receipt.chatId
    const handoff = before.state.lanes.handoff?.[scope]
    const turn = before.state.lanes.turn?.[scope]
    const terminal = this.#terminalAwaitingSettlement.get(scope)
    if (terminal && (terminal.receiptId !== receiptId ||
        terminal.turnToken !== turnToken || !terminal.ready)) {
      throw new Error('C2 terminal effect must finish before release request')
    }
    if (handoff?.phase !== 'running' || handoff.turnToken !== turnToken ||
        turn?.active !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 release request is not durably running')
    }
    const { accepted } = queuedPayloads(before, scope, payloadHandles)
    const id = callbackEventId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'releaseRequestedCommit',
      lookupReceipt: key => before.receipts.pending.find(item => item.id === key) || null,
      lookupRegistration: key => this.#journal.lookupRegistration(key) })
    if (this.#journal.hasEvent(id)) throw new Error('C2 release request already committed')
    try {
      const prepared = this.#coordinator.prepare({ id, domain: 'atomicHandoff', scope,
        payload: { type: 'releaseRequestedCommit', turnToken,
          acceptedReceiptIds: accepted },
        validate: candidate => {
          const effect = candidate.effects?.[0]
          if (candidate.cursor !== before.cursor + 1 || candidate.state?.seq !== candidate.cursor ||
              candidate.state.lanes.turn?.[scope]?.active !== null ||
              candidate.state.lanes.handoff?.[scope]?.phase !== 'releasing' ||
              candidate.state.lanes.handoff[scope].turnToken !== turnToken ||
              !isDeepStrictEqual(candidate.state.lanes.handoff[scope].acceptedReceiptIds, accepted) ||
              !isDeepStrictEqual(candidate.state.lanes.queue?.[scope]?.queue,
                before.state.lanes.queue?.[scope]?.queue) ||
              candidate.decision?.turnToken !== turnToken ||
              !isDeepStrictEqual(candidate.decision?.acceptedReceiptIds, accepted) ||
              candidate.effects.length !== 1 || effect.type !== 'attemptQueueRelease' ||
              effect.origin !== 'handoff' ||
              effect.effectId !== `sbot-c2-effect-v1:${Buffer.byteLength(id)}:${id}:0`) {
            throw new Error('C2 release request result invalid')
          }
        } })
      const result = prepared.commit()
      this.#activeRuns.delete(scope)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return result
    } catch (error) { this.close(); throw error }
  }

  registerHandoffBeginCallback({ receiptId, generation, registeredAt } = {}) {
    this.#completionCapacity()
    const id = callbackRegistrationId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'handoffBeginCommit' })
    const result = this.#journal.registerCallback({ id, receiptId, generation,
      domain: 'atomicHandoff', kind: 'handoffBeginCommit', ordinal: 0,
      registeredAt })
    if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  // A successor is only eligible in the same process that committed its
  // queue release. The journal cannot recreate the removed jobs' raw bodies;
  // a reopen has no scheduled capability and must interrupt instead.
  commitHandoffBegin({ receiptId, generation, priorTurnToken, payloadHandles } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || !GENERATION.test(generation) ||
        !Number.isSafeInteger(priorTurnToken) || priorTurnToken <= 0 ||
        !(payloadHandles instanceof C2PayloadHandles) || payloadHandles.blocked ||
        typeof payloadHandles.peekHandoff !== 'function') {
      throw new TypeError('C2 successor dispatch identity or handles invalid')
    }
    const before = this.#journal.snapshot()
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    if (!receipt) throw new Error('C2 successor dispatch lacks pending receipt')
    const scope = receipt.chatId
    if (this.#terminalAwaitingSettlement.has(scope)) {
      throw new Error('C2 prior terminal receipt has not settled')
    }
    const scheduled = this.#scheduledHandoffs.get(scope)
    const handoff = before.state.lanes.handoff?.[scope]
    if (!scheduled || scheduled.nextJobId !== receiptId ||
        scheduled.cursor > before.cursor || !this.#journal.hasEvent(scheduled.eventId) ||
        scheduled.priorTurnToken !== priorTurnToken ||
        handoff?.phase !== 'handoff' || handoff.turnToken !== priorTurnToken ||
        handoff.nextJobId !== receiptId || before.state.lanes.turn?.[scope]?.active !== null ||
        this.#journal.effectStatus(scheduled.scheduleEffectId) !== 'acked' ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 successor dispatch lacks committed scheduled handoff')
    }
    payloadHandles.peekHandoff(receiptId)
    const liveIds = new Set(payloadHandles.snapshot().receiptIds)
    if (!scheduled.jobReceiptIds.length ||
        !scheduled.jobReceiptIds.every(id => liveIds.has(id)) ||
        !isDeepStrictEqual(handoff.acceptedReceiptIds, scheduled.batchReceiptIds)) {
      throw new Error('C2 successor dispatch payload handles missing')
    }
    const id = callbackEventId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'handoffBeginCommit',
      lookupReceipt: key => before.receipts.pending.find(item => item.id === key) || null,
      lookupRegistration: key => this.#journal.lookupRegistration(key) })
    if (this.#journal.hasEvent(id)) throw new Error('C2 successor dispatch already committed')
    try {
      const prepared = this.#coordinator.prepare({ id, domain: 'atomicHandoff', scope,
        payload: { type: 'handoffBeginCommit', priorTurnToken, nextJobId: receiptId,
          batchReceiptIds: [...scheduled.batchReceiptIds] },
        validate: candidate => {
          const token = candidate.decision?.turnToken
          const [clear, dispatch] = candidate.effects || []
          if (candidate.cursor !== before.cursor + 1 || candidate.state?.seq !== candidate.cursor ||
              !Number.isSafeInteger(token) || token <= priorTurnToken ||
              candidate.decision.nextJobId !== receiptId ||
              !isDeepStrictEqual(candidate.decision.batchReceiptIds,
                scheduled.batchReceiptIds) ||
              candidate.state.lanes.turn?.[scope]?.active !== token ||
              candidate.state.lanes.handoff?.[scope]?.phase !== 'running' ||
              candidate.state.lanes.handoff[scope].turnToken !== token ||
              candidate.state.lanes.handoff[scope].nextJobId !== null ||
              !isDeepStrictEqual(candidate.state.lanes.handoff[scope].acceptedReceiptIds,
                scheduled.batchReceiptIds.length > 1 ? scheduled.batchReceiptIds : []) ||
              !isDeepStrictEqual(candidate.state.lanes.queue?.[scope]?.queue,
                before.state.lanes.queue?.[scope]?.queue) ||
              candidate.effects.length !== 2 || clear.type !== 'clearHandoff' ||
              clear.origin !== 'handoff' || dispatch.type !== 'dispatch' ||
              dispatch.origin !== 'handoff' || dispatch.jobId !== receiptId ||
              dispatch.turnToken !== token ||
              [clear, dispatch].some((effect, index) =>
                effect.effectId !== `sbot-c2-effect-v1:${Buffer.byteLength(id)}:${id}:${index}`)) {
            throw new Error('C2 successor dispatch result invalid')
          }
        } })
      const result = prepared.commit()
      this.#retainActiveRun(scope, result, receiptId,
        scheduled.jobReceiptIds, scheduled.batchReceiptIds)
      this.#scheduledHandoffs.delete(scope)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { ...result, jobReceiptIds: [...scheduled.jobReceiptIds],
        batchReceiptIds: [...scheduled.batchReceiptIds] }
    } catch (error) { this.close(); throw error }
  }

  // Register the callback identity before exposing a runner-close or queue
  // release callback. Registration alone does not advance reducer state.
  registerQueueReleaseCallback({ receiptId, generation, registeredAt } = {}) {
    this.#completionCapacity()
    const id = callbackRegistrationId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'queueReleaseCommit' })
    const result = this.#journal.registerCallback({ id, receiptId, generation,
      domain: 'atomicHandoff', kind: 'queueReleaseCommit', ordinal: 0,
      registeredAt })
    if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  // The handoff lane must already be durably in `releasing` for this token.
  // This call commits one queue+handoff transition. It never dispatches or
  // acknowledges the returned effects; the caller owns those later stages.
  commitQueueRelease({ receiptId, generation, turnToken, paused, payloadHandles } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || !GENERATION.test(generation) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 || typeof paused !== 'boolean') {
      throw new TypeError('C2 atomic release identity invalid')
    }
    const before = this.#journal.snapshot()
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    if (!receipt) throw new Error('C2 atomic release lacks pending turn receipt')
    const scope = receipt.chatId
    const handoff = before.state.lanes.handoff?.[scope]
    const terminal = this.#terminalAwaitingSettlement.get(scope)
    if (terminal && (terminal.receiptId !== receiptId ||
        terminal.turnToken !== turnToken || !terminal.ready)) {
      throw new Error('C2 terminal effect must finish before queue release')
    }
    if (!handoff || handoff.phase !== 'releasing' || handoff.turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 atomic release is not durably releasing')
    }
    const { queue, accepted } = queuedPayloads(before, scope, payloadHandles)
    if (!isDeepStrictEqual(handoff.acceptedReceiptIds, accepted)) {
      throw new Error('C2 atomic release accepted receipts differ from queue')
    }
    const releasedCount = paused ? queue.length : queueRunLen(queue)
    const remaining = queue.slice(releasedCount)
    const id = callbackEventId({ receiptId, generation,
      domain: 'atomicHandoff', kind: 'queueReleaseCommit',
      lookupReceipt: key => before.receipts.pending.find(item => item.id === key) || null,
      lookupRegistration: key => this.#journal.lookupRegistration(key) })
    if (this.#journal.hasEvent(id)) throw new Error('C2 atomic release already committed')
    try {
      const prepared = this.#coordinator.prepare({ id, domain: 'atomicHandoff', scope,
        payload: { type: 'queueReleaseCommit', turnToken, paused },
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.state?.seq !== candidate.cursor ||
              !isDeepStrictEqual(candidate.state.lanes.queue?.[scope]?.queue, remaining) ||
              candidate.decision?.queueRunLen !== queueRunLen(remaining) ||
              !isDeepStrictEqual(candidate.decision?.jobReceiptIds,
                paused ? [] : queue.slice(0, releasedCount).map(item =>
                  item.id.slice('receipt:job:'.length))) ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                paused ? [] : queueCohortReceiptIds(queue.slice(0, releasedCount))) ||
              candidate.decision?.visibleQueue !== remaining.filter(item =>
                !item.quiet && !item.polled).length ||
              !Array.isArray(candidate.effects) ||
              candidate.effects.some((effect, index) =>
                effect.effectId !== `sbot-c2-effect-v1:${Buffer.byteLength(id)}:${id}:${index}`)) {
            throw new Error('C2 atomic release result invalid')
          }
          const release = candidate.decision.queueRelease
          const next = candidate.decision.nextJobId
          if (paused) {
            if (next !== null || candidate.state.lanes.handoff?.[scope]?.phase !== 'idle' ||
                candidate.state.lanes.handoff[scope].nextJobId !== null ||
                candidate.effects.some(effect => effect.type !== 'dropQueued' || effect.origin !== 'queue') ||
                (queue.length > 0 && (candidate.effects.length !== 1 ||
                  release?.type !== 'dropQueued' ||
                  !isDeepStrictEqual(release.batch, queue.map(item => item.id)))) ||
                (queue.length === 0 && (release !== null || candidate.effects.length))) {
              throw new Error('C2 atomic paused release mismatch')
            }
          } else if (next !== null) {
            const anchor = release?.anchor
            if (release?.type !== 'dispatch' ||
                !queue.slice(0, releasedCount).some(item => item.id === anchor) ||
                next !== anchor.slice('receipt:job:'.length) ||
                candidate.state.lanes.handoff?.[scope]?.phase !== 'handoff' ||
                candidate.state.lanes.handoff[scope].nextJobId !== next ||
                !isDeepStrictEqual(candidate.state.lanes.handoff[scope].acceptedReceiptIds,
                  candidate.decision.batchReceiptIds) ||
                !isDeepStrictEqual(candidate.effects.map(effect =>
                  [effect.type, effect.origin, effect.jobId ?? null]),
                  [['holdHandoff', 'handoff', null], ['scheduleDispatch', 'handoff', next]])) {
              throw new Error('C2 atomic next job mismatch')
            }
          } else if (release !== null || candidate.effects.length ||
              candidate.state.lanes.handoff?.[scope]?.phase !== 'idle') {
            throw new Error('C2 atomic empty release mismatch')
          }
        } })
      const result = prepared.commit()
      const terminal = this.#terminalAwaitingSettlement.get(scope)
      if (terminal?.receiptId === receiptId && terminal.turnToken === turnToken) {
        terminal.releaseCommitted = true
      }
      const nextJobId = result.decision.nextJobId
      if (nextJobId) {
        const effect = result.effects.find(item =>
          item.type === 'scheduleDispatch' && item.jobId === nextJobId)
        if (!effect) throw new Error('C2 atomic release schedule effect missing')
        this.#scheduledHandoffs.set(scope, { eventId: id, cursor: result.cursor,
          nextJobId, priorTurnToken: turnToken, scheduleEffectId: effect.effectId,
          jobReceiptIds: queue.slice(0, releasedCount).map(item =>
            item.id.slice('receipt:job:'.length)),
          batchReceiptIds: queueCohortReceiptIds(queue.slice(0, releasedCount)) })
      } else this.#scheduledHandoffs.delete(scope)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { ...result, releasedJobReceiptIds: queue.slice(0, releasedCount).map(item =>
        item.id.slice('receipt:job:'.length)) }
    } catch (error) {
      this.close()
      throw error
    }
  }

  // Isolated v2 terminal boundary. The callback is registered before the
  // runner is exposed, and only this process can prove which pending receipt
  // was actually dispatched. No text or reply context enters the journal.
  registerTerminalCallback({ receiptId, generation, registeredAt, reuse = false } = {}) {
    this.#completionCapacity()
    const id = callbackRegistrationId({ receiptId, generation,
      domain: 'terminal', kind: 'finalizeEffectCommit' })
    if (reuse) {
      const prior = this.#journal.lookupRegistration(id)
      if (prior) {
        if (prior.receiptId !== receiptId || prior.generation !== generation ||
            prior.domain !== 'terminal' || prior.kind !== 'finalizeEffectCommit' ||
            prior.ordinal !== 0) throw new Error('C2 terminal registration identity differs')
        return prior
      }
    }
    const result = this.#journal.registerCallback({ id, receiptId, generation,
      domain: 'terminal', kind: 'finalizeEffectCommit', ordinal: 0, registeredAt })
    if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  assertClosedFailureReady({ receiptId, chatId, turnToken, generation,
    verifyGeneration, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    const witness = this.#activeRuns.get(chatId)
    const proof = this.#journal.lookupRunnerClosed(
      `sbot-c2-runner-closed-v1:${receiptId}:${generation}`)
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const dispatch = proof && this.#journal.effectDescriptor(proof.dispatchEffectId)
    if (this.blocked || assertWriterLock?.() !== true ||
        verifyGeneration?.({ receiptId, chatId, turnToken, generation }) !== true ||
        receipt?.chatId !== chatId || witness?.receiptId !== receiptId ||
        witness.turnToken !== turnToken || proof?.receiptId !== receiptId ||
        proof.chatId !== chatId || proof.turnToken !== turnToken ||
        proof.generation !== generation || dispatch?.type !== 'dispatch' ||
        dispatch.scope !== chatId || dispatch.receiptId !== receiptId ||
        dispatch.turnToken !== turnToken ||
        this.#journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
        !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
        before.state.lanes.session?.[chatId]?.closeSeen !== true ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.steer?.[chatId]?.entries?.some(item => item.status !== 'landed') ||
        [...before.effects].some(([id, status]) =>
          this.#journal.effectDescriptor(id)?.scope === chatId && status !== 'acked') ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      this.close()
      throw new Error('C2 failure terminal lacks settled durable proof')
    }
    return true
  }

  commitTerminalEffect({ receiptId, generation, turnToken, payload } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || !GENERATION.test(generation) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'finalizeEffectCommit' || payload.receiptId !== receiptId ||
        payload.turnToken !== turnToken) {
      throw new TypeError('C2 terminal identity invalid')
    }
    const before = this.#journal.snapshot()
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const scope = receipt?.chatId
    const witness = this.#activeRuns.get(scope)
    const batchReceiptIds = witness?.batchReceiptIds?.length > 1
      ? witness.batchReceiptIds : null
    if (!receipt || payload.quiet !== receipt.quiet ||
        witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
        !isDeepStrictEqual(before.state.lanes.handoff?.[scope]?.acceptedReceiptIds,
          batchReceiptIds || []) ||
        (batchReceiptIds
          ? !isDeepStrictEqual(payload.batchReceiptIds, batchReceiptIds) ||
            payload.replyTargetReceiptId !== receiptId ||
            batchReceiptIds.some(id =>
              before.receipts.pending.find(item => item.id === id)?.chatId !== scope)
          : payload.batchReceiptIds !== undefined ||
            payload.replyTargetReceiptId !== undefined) ||
        this.#journal.effectStatus(witness.dispatchEffectId) !== 'acked' ||
        before.state.lanes.turn?.[scope]?.active !== turnToken ||
        before.state.lanes.handoff?.[scope]?.phase !== 'running' ||
        before.state.lanes.handoff[scope].turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 terminal lacks exact running receipt authority')
    }
    const id = callbackEventId({ receiptId, generation,
      domain: 'terminal', kind: 'finalizeEffectCommit',
      lookupReceipt: key => before.receipts.pending.find(item => item.id === key) || null,
      lookupRegistration: key => this.#journal.lookupRegistration(key) })
    if (this.#journal.hasEvent(id)) throw new Error('C2 terminal already committed')
    try {
      const prepared = this.#coordinator.prepare({ id, domain: 'terminal', scope,
        payload, validate: candidate => {
          const effect = candidate.effects?.at(-1)
          const descriptor = candidate.effectDescriptors?.at(-1)
          const terminal = candidate.state?.lanes?.terminal?.[scope]
          const expectedType = receipt.quiet || terminal?.outcome?.silent
            ? 'quietCompletion' : 'finalReply'
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.state?.seq !== candidate.cursor ||
              terminal?.finalized !== true || terminal.pendingEffectIds?.at(-1) !== effect?.effectId ||
              !isDeepStrictEqual(terminal?.batchReceiptIds,
                batchReceiptIds || undefined) ||
              terminal?.replyTargetReceiptId !==
                (batchReceiptIds ? receiptId : undefined) ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batchReceiptIds || undefined) ||
              candidate.decision?.replyTargetReceiptId !==
                (batchReceiptIds ? receiptId : undefined) ||
              !['quietCompletion', 'finalReply'].includes(effect?.type) ||
              effect.type !== expectedType || descriptor?.type !== effect.type ||
              descriptor.domain !== 'terminal' || descriptor.scope !== scope ||
              descriptor.turnToken !== turnToken || descriptor.receiptId !== receiptId ||
              descriptor.targetId !== null) {
            throw new Error('C2 terminal effect result invalid')
          }
        } })
      const result = prepared.commit()
      this.#terminalAwaitingSettlement.set(scope, { receiptId, turnToken,
        generation, effectId: result.effects.at(-1).effectId,
        batchReceiptIds: batchReceiptIds ? [...batchReceiptIds] : null,
        type: result.effects.at(-1).type, ready: false, releaseCommitted: false })
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { ...result, terminalEffectId: result.effects.at(-1).effectId }
    } catch (error) { this.close(); throw error }
  }

  // The local Store/verification projection is an external effect too: its
  // attempt is durable before the host writes, and only a fresh process-local
  // claim may turn the observed write into an ACK.
  performLocalTerminalEffect({ effect, receiptId, chatId, turnToken,
    generation, verifyGeneration, assertWriterLock, applyLocalEffect } = {}) {
    const before = this.#completionCapacity()
    const effectId = effect?.effectId
    const descriptor = this.#journal.effectDescriptor(effectId)
    const capability = this.#terminalAwaitingSettlement.get(chatId)
    const terminal = before.state.lanes.terminal?.[chatId]
    if (!effect || typeof effect !== 'object' || Array.isArray(effect) ||
        !['clearTainted', 'clearExhausted', 'verifyTurn'].includes(effect.type) ||
        !RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '') ||
        typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction' ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction' ||
        typeof applyLocalEffect !== 'function' ||
        typeof applyLocalEffect.claim !== 'function' ||
        applyLocalEffect.constructor?.name === 'AsyncFunction' ||
        assertWriterLock() !== true ||
        verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true ||
        before.receipts.pending.find(item => item.id === receiptId)?.chatId !== chatId ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== turnToken ||
        capability?.receiptId !== receiptId || capability.turnToken !== turnToken ||
        capability.generation !== generation || capability.ready ||
        terminal?.finalized !== true ||
        !terminal.pendingEffectIds?.includes(effectId) ||
        descriptor?.domain !== 'terminal' || descriptor.scope !== chatId ||
        descriptor.type !== effect.type || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== turnToken ||
        this.#journal.effectStatus(effectId) !== 'pending') {
      throw new Error('C2 local effect lacks exact live authority')
    }
    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      throw new TypeError('C2 local effect time invalid')
    }
    this.#externalEffectInFlight = true
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let confirmed = false
      try {
        applyLocalEffect.claim(effectId)
        confirmed = applyLocalEffect(effect) === true &&
          assertWriterLock() === true &&
          verifyGeneration({ chatId, receiptId, turnToken, generation }) === true
      } catch { /* A write may have happened; its outcome is ambiguous. */ }
      const now = this.#now()
      const resolvedAt = Number.isSafeInteger(now) && now >= attemptedAt
        ? now : attemptedAt
      this.#journal.recordEffectOutcome({ effectId,
        status: confirmed ? 'acked' : 'unknown', resolvedAt })
      if (!confirmed) {
        throw new Error('C2 local effect outcome unknown; manual recovery required')
      }
      return { effectId, status: 'acked' }
    } catch (error) { this.close(); throw error }
    finally { this.#externalEffectInFlight = false }
  }

  // Classify a closed runner that cannot be delivered. This is an internal
  // zero-effect transition: the receipt and running turn remain unresolved,
  // and this process closes ingress for explicit fault recovery. No error
  // text, session ID, or reply target is written into the journal.
  commitUnresolvedClassification({ receiptId, generation, turnToken, status,
    payload, verifyGeneration, assertWriterLock } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !['error', 'empty', 'stopped'].includes(status) ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'finalizeEffectCommit' || payload.receiptId !== receiptId ||
        payload.turnToken !== turnToken ||
        typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction' ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 unresolved classification needs closed runner identity')
    }
    try {
      const before = this.#journal.snapshot()
      const receipt = before.receipts.pending.find(item => item.id === receiptId)
      const scope = receipt?.chatId
      const witness = this.#activeRuns.get(scope)
      const closeEvidenceId = `sbot-c2-runner-closed-v1:${receiptId}:${generation}`
      const proof = this.#journal.lookupRunnerClosed(closeEvidenceId)
      const dispatch = proof && this.#journal.effectDescriptor(proof.dispatchEffectId)
      const registrationId = callbackRegistrationId({ receiptId, generation,
        domain: 'terminal', kind: 'finalizeEffectCommit' })
      const registration = this.#journal.lookupRegistration(registrationId)
      const cohortIds = witness?.batchReceiptIds || []
      const batch = cohortIds.length > 1
      if (this.blocked || assertWriterLock() !== true || !receipt ||
          payload.quiet !== receipt.quiet ||
          witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
          !witness.jobReceiptIds.includes(receiptId) ||
          !isDeepStrictEqual(witness.jobReceiptIds, cohortIds) ||
          !isDeepStrictEqual(before.state.lanes.handoff?.[scope]?.acceptedReceiptIds,
            batch ? cohortIds : []) ||
          (batch
            ? !isDeepStrictEqual(payload.batchReceiptIds, cohortIds) ||
              payload.replyTargetReceiptId !== receiptId ||
              cohortIds.some(id =>
                before.receipts.pending.find(item => item.id === id)?.chatId !== scope)
            : payload.batchReceiptIds !== undefined ||
              payload.replyTargetReceiptId !== undefined) ||
          proof?.receiptId !== receiptId || proof.chatId !== scope ||
          proof.turnToken !== turnToken || proof.generation !== generation ||
          dispatch?.type !== 'dispatch' || dispatch.scope !== scope ||
          dispatch.receiptId !== receiptId || dispatch.turnToken !== turnToken ||
          this.#journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
          registration?.receiptId !== receiptId ||
          registration.generation !== generation ||
          registration.domain !== 'terminal' ||
          registration.kind !== 'finalizeEffectCommit' ||
          !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
          before.state.lanes.session?.[scope]?.closeSeen !== true ||
          before.state.lanes.turn?.[scope]?.active !== turnToken ||
          before.state.lanes.handoff?.[scope]?.phase !== 'running' ||
          before.state.lanes.handoff[scope].turnToken !== turnToken ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
          [...before.effects].some(([effectId, effectStatus]) =>
            cohortIds.includes(this.#journal.effectDescriptor(effectId)?.receiptId) &&
            effectStatus !== 'acked') ||
          verifyGeneration({ chatId: scope, receiptId, turnToken,
            generation }) !== true) {
        throw new Error('C2 unresolved runner lacks settled durable proof')
      }
      const eventId = `sbot-c2-unresolved-v1:${receiptId}:${turnToken}:${generation}:${status}`
      if (this.#journal.hasEvent(eventId)) throw new Error('C2 unresolved already classified')
      const terminalPayload = { ...payload, type: 'finalize' }
      delete terminalPayload.receiptId
      delete terminalPayload.turnToken
      delete terminalPayload.quiet
      if (engineTerminalStep({ finalized: false, outcome: null },
        terminalPayload).state.outcome.status !== status) {
        throw new Error('C2 unresolved status differs from runner projection')
      }
      const prepared = this.#coordinator.prepare({ id: eventId,
        domain: 'terminal', scope,
        payload: { ...payload, type: 'classifyUnresolved',
          runnerGeneration: generation,
          runnerClosed: true, closeEvidenceId },
        validate: candidate => {
          if (candidate.eventId !== eventId ||
              candidate.cursor !== before.cursor + 1 ||
              candidate.decision?.outcome?.status !== status ||
              candidate.decision?.sealed !== true ||
              candidate.decision?.requiresFaultRecovery !== true ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batch ? cohortIds : undefined) ||
              candidate.decision?.replyTargetReceiptId !==
                (batch ? receiptId : undefined) ||
              !Array.isArray(candidate.effects) || candidate.effects.length !== 0 ||
              !Array.isArray(candidate.effectDescriptors) ||
              candidate.effectDescriptors.length !== 0 ||
              !isDeepStrictEqual(candidate.state?.lanes, before.state.lanes)) {
            throw new Error('C2 unresolved classification changed running state')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel()
        throw new Error('C2 unresolved lost single-writer lock before commit')
      }
      const result = prepared.commit()
      if (!this.#journal.hasEvent(eventId) ||
          !isDeepStrictEqual(this.#journal.snapshot().state, result.state)) {
        throw new Error('C2 unresolved durable classification unverified')
      }
      this.close()
      return Object.freeze({ eventId, cursor: result.cursor, status,
        ingressClosed: true, deliveryWithheld: true })
    } catch (error) { this.close(); throw error }
  }

  // A recalled queued message has no outward result. The queue decision and
  // quiet receipt settlement share one journal record; only after fsync may
  // its process-local body be discarded. This deliberately supports one
  // ordinary queued job, not a coalesced batch or synthetic source.
  commitQueuedCancellation({ receiptId, chatId, control, payloadHandles,
    assertWriterLock } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId || '') || typeof chatId !== 'string' || !chatId ||
        !['recall', 'stop'].includes(control) ||
        !(payloadHandles instanceof C2PayloadHandles) ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 queued recall identity invalid')
    }
    try {
      const before = this.#journal.snapshot()
      const receipt = before.receipts.pending.find(item => item.id === receiptId)
      const queue = before.state.lanes.queue?.[chatId]?.queue
      const handle = payloadHandles.requireQueued(receiptId)
      const index = queue?.findIndex(item => item.id === `receipt:job:${receiptId}`)
      if (this.blocked || assertWriterLock() !== true ||
          receipt?.chatId !== chatId || receipt.source !== 'message' ||
          index < 0 || !Array.isArray(queue) || queue[index]?.batch ||
          handle?.msg?._c2ReceiptId !== receiptId ||
          handle.msg.msgId !== receipt.sourceId ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
          [...before.effects].some(([id, status]) =>
            this.#journal.effectDescriptor(id)?.receiptId === receiptId &&
            status !== 'acked') ||
          this.#journal.noticeStatus(receiptId) !== null) {
        throw new Error('C2 queued recall differs from durable queue')
      }
      const settledAt = this.#now()
      if (!Number.isSafeInteger(settledAt) || settledAt <= 0) {
        throw new TypeError('C2 queued recall time invalid')
      }
      const eventId = `sbot-c2-queue-drop-v1:${receiptId}:${control}`
      const receipts = {
        pending: before.receipts.pending.filter(item => item.id !== receiptId),
        completed: [...before.receipts.completed, { id: receiptId, settledAt }],
      }
      const expectedQueue = [...queue.slice(0, index), ...queue.slice(index + 1)]
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'queue',
        scope: chatId, payload: { type: 'dropQueuedReceipt', receiptId,
          control }, receipts,
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.decision?.receiptId !== receiptId ||
              candidate.decision?.control !== control ||
              candidate.decision?.position !== 'job' ||
              candidate.decision?.quietSettlement !== true ||
              candidate.decision?.sealed !== false ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              !isDeepStrictEqual(candidate.state?.lanes?.queue?.[chatId]?.queue,
                expectedQueue)) {
            throw new Error('C2 queued recall decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel()
        throw new Error('C2 queued recall lost writer lock')
      }
      const result = prepared.commit()
      payloadHandles.dropDurablyCancelled(receiptId, eventId, control)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { eventId, cursor: result.cursor, receiptId, status: 'cancelled',
        control }
    } catch (error) { this.close(); throw error }
  }

  #cardEffects(before, receiptId, chatId, turnToken, cleanupEffectId = null) {
    const prior = []
    for (const [id, status] of before.effects) {
      const descriptor = this.#journal.effectDescriptor(id)
      if (descriptor?.receiptId !== receiptId) continue
      if (status !== 'acked' || descriptor.scope !== chatId ||
          descriptor.turnToken !== turnToken && descriptor.domain === 'outbound' ||
          ['outbound', 'terminal'].includes(descriptor.domain) &&
            (descriptor.domain !== 'outbound' ||
              !CARD_OPERATION_KINDS.has(descriptor.type))) {
        throw new Error('C2 card cleanup has unsettled or foreign effect')
      }
      if (descriptor.domain === 'outbound') {
        if (id === cleanupEffectId && descriptor.type === 'message.delete') continue
        if (descriptor.type === 'message.delete') {
          throw new Error('C2 card cleanup has unexpected delete effect')
        }
        prior.push(id)
      }
    }
    return prior
  }

  #cardCleanupIdentity({ receiptId, chatId, turnToken, generation, target }) {
    if (!RECEIPT_ID.test(receiptId || '') || !GENERATION.test(generation || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        target?.chatId !== chatId) throw new TypeError('C2 card cleanup identity invalid')
    const cardTargetDigestValue = cardTargetDigest(target)
    const { operationId: deleteOperationId, eventId } = cardOperationIdentity({
      receiptId, turnToken, generation,
      operation: { kind: 'message.delete', operationId: `${receiptId}:message.delete`,
        chatId, cardId: target.cardId, msgId: target.msgId, invoke: () => {} } })
    const cleanupEffectId = `sbot-c2-effect-v1:${Buffer.byteLength(eventId)}:${eventId}:0`
    return { receiptId, turnToken, runnerGeneration: generation,
      cardTargetDigest: cardTargetDigestValue, deleteOperationId,
      cleanupEffectId }
  }

  commitCardCleanupIntent({ receiptId, chatId, turnToken, generation, target,
    verifyGeneration, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    try {
      const identity = this.#cardCleanupIdentity({ receiptId, chatId,
        turnToken, generation, target })
      const witness = this.#activeRuns.get(chatId)
      const session = before.state.lanes.session?.[chatId]
      const prior = this.#cardEffects(before, receiptId, chatId, turnToken)
      const cardOperations = prior.length
      if (this.blocked || assertWriterLock?.() !== true ||
          verifyGeneration?.({ chatId, receiptId, turnToken, generation }) !== true ||
          before.receipts.pending.find(item => item.id === receiptId)?.chatId !== chatId ||
          witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
          !witness.jobReceiptIds.includes(receiptId) ||
          !isDeepStrictEqual(witness.jobReceiptIds, witness.batchReceiptIds) ||
          !isDeepStrictEqual(before.state.lanes.handoff?.[chatId]?.acceptedReceiptIds,
            witness.batchReceiptIds.length > 1 ? witness.batchReceiptIds : []) ||
          witness.batchReceiptIds.some(id =>
            before.receipts.pending.find(item => item.id === id)?.chatId !== chatId) ||
          before.state.lanes.turn?.[chatId]?.active !== turnToken ||
          before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          session?.epoch !== turnToken || session.closeSeen !== true ||
          session.settled !== false ||
          !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
          !this.#journal.lookupRunnerClosed(`sbot-c2-runner-closed-v1:${receiptId}:${generation}`) ||
          cardOperations <= 0 ||
          before.state.lanes.cardCleanup?.[chatId] !== undefined ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
        throw new Error('C2 card cleanup intent lacks closed turn and ACKed card')
      }
      const eventId = `sbot-c2-card-cleanup-intent-v1:${receiptId}:${turnToken}:${generation}:${identity.cardTargetDigest}:${identity.deleteOperationId}`
      const lane = { phase: 'intent', ...identity, cardOperations }
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'outbound',
        scope: chatId, payload: { type: 'cardCleanupIntent', receiptId, turnToken,
          runnerGeneration: generation, cardTargetDigest: identity.cardTargetDigest,
          deleteOperationId: identity.deleteOperationId, cardOperations },
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              !isDeepStrictEqual(candidate.state?.lanes?.cardCleanup?.[chatId], lane) ||
              candidate.decision?.cleanupEffectId !== identity.cleanupEffectId) {
            throw new Error('C2 card cleanup intent decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel(); throw new Error('C2 card cleanup intent lost writer lock')
      }
      prepared.commit()
      return { ...identity, cardOperations, targetDigest: identity.cardTargetDigest }
    } catch (error) { this.close(); throw error }
  }

  commitCardCleanupConfirmed({ receiptId, chatId, turnToken, generation, target,
    proof, verifyGeneration, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    try {
      const identity = this.#cardCleanupIdentity({ receiptId, chatId,
        turnToken, generation, target })
      const lane = before.state.lanes.cardCleanup?.[chatId]
      const prior = this.#cardEffects(before, receiptId, chatId, turnToken,
        identity.cleanupEffectId)
      const descriptor = this.#journal.effectDescriptor(identity.cleanupEffectId)
      if (this.blocked || assertWriterLock?.() !== true ||
          verifyGeneration?.({ chatId, receiptId, turnToken, generation }) !== true ||
          !isDeepStrictEqual(proof, { ...identity,
            cardOperations: prior.length, targetDigest: identity.cardTargetDigest }) ||
          !isDeepStrictEqual(lane, { phase: 'intent', ...identity,
            cardOperations: prior.length }) ||
          descriptor?.domain !== 'outbound' || descriptor.type !== 'message.delete' ||
          descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
          descriptor.turnToken !== turnToken ||
          this.#journal.effectStatus(identity.cleanupEffectId) !== 'acked' ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
        throw new Error('C2 card cleanup delete ACK proof invalid')
      }
      const eventId = `sbot-c2-card-cleanup-confirm-v1:${receiptId}:${turnToken}:${generation}:${identity.cardTargetDigest}:${identity.deleteOperationId}`
      const payload = { type: 'cardCleanupConfirmed', receiptId, turnToken,
        runnerGeneration: generation, cardTargetDigest: identity.cardTargetDigest,
        deleteOperationId: identity.deleteOperationId,
        cardOperations: prior.length, cleanupEffectId: identity.cleanupEffectId,
        cleanupAcked: true }
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'outbound',
        scope: chatId, payload, validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              !isDeepStrictEqual(candidate.state?.lanes?.cardCleanup?.[chatId],
                { ...lane, phase: 'acked' }) ||
              candidate.decision?.cleanupAcked !== true) {
            throw new Error('C2 card cleanup confirmation decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel(); throw new Error('C2 card cleanup confirmation lost writer lock')
      }
      prepared.commit()
      return { cardOperations: prior.length,
        cardTargetDigest: identity.cardTargetDigest,
        cleanupEffectId: identity.cleanupEffectId }
    } catch (error) { this.close(); throw error }
  }

  #cancellationCardFields(before, { receiptId, chatId, turnToken, generation,
    cardCleanup }) {
    const lane = before.state.lanes.cardCleanup?.[chatId]
    if (cardCleanup === null || cardCleanup === undefined) {
      if (lane !== undefined ||
          this.#cardEffects(before, receiptId, chatId, turnToken).length !== 0) {
        throw new Error('C2 cancellation has visible card without cleanup proof')
      }
      return { cardOperations: 0 }
    }
    const { cardOperations, cardTargetDigest: digest, cleanupEffectId } = cardCleanup
    const descriptor = this.#journal.effectDescriptor(cleanupEffectId)
    const prior = this.#cardEffects(before, receiptId, chatId, turnToken,
      cleanupEffectId)
    if (!Number.isSafeInteger(cardOperations) || cardOperations <= 0 ||
        prior.length !== cardOperations ||
        !isDeepStrictEqual(lane, { phase: 'acked', receiptId, turnToken,
          runnerGeneration: generation, cardTargetDigest: digest,
          deleteOperationId: lane?.deleteOperationId,
          cleanupEffectId, cardOperations }) ||
        descriptor?.domain !== 'outbound' || descriptor.type !== 'message.delete' ||
        descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
        descriptor.turnToken !== turnToken ||
        this.#journal.effectStatus(cleanupEffectId) !== 'acked') {
      throw new Error('C2 cancellation card cleanup proof invalid')
    }
    return { cardOperations, cardTargetDigest: digest, cleanupEffectId }
  }

  #matchesRunningReceipts(before, witness, chatId, receiptId, turnToken) {
    const handoff = before.state.lanes.handoff?.[chatId]
    const ids = witness?.batchReceiptIds
    return witness?.receiptId === receiptId && witness.turnToken === turnToken &&
      handoff?.phase === 'running' && handoff.turnToken === turnToken &&
      Array.isArray(ids) && ids.length >= 1 && ids.includes(receiptId) &&
      new Set(ids).size === ids.length &&
      ids.every(id => RECEIPT_ID.test(id) &&
          before.receipts.pending.some(item => item.id === id &&
            item.chatId === chatId && item.source === 'message')) &&
      isDeepStrictEqual(handoff.acceptedReceiptIds,
        ids.length > 1 ? ids : [])
  }

  #runningControlReceipts(before, witness, chatId, receiptId, turnToken) {
    if (!this.#matchesRunningReceipts(before, witness, chatId, receiptId,
      turnToken)) {
      throw new Error('C2 running control lacks exact batch receipts')
    }
    const ids = witness.batchReceiptIds
    return { ids, batchFields: ids.length > 1 ? { batchReceiptIds: ids } : {} }
  }

  // A running recall is allowed only after the exact child has stopped and
  // the dispatch/session closure are durable. Visible card effects require
  // the separately ACKed deletion proof before quiet settlement.
  commitRunningCancellation({ receiptId, chatId, turnToken, generation, control,
    cardCleanup = null, verifyGeneration, assertWriterLock } = {}) {
    this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId || '') || typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !['recall', 'stop'].includes(control) ||
        !GENERATION.test(generation || '') ||
        typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction' ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 running recall identity invalid')
    }
    try {
      const before = this.#journal.snapshot()
      const receipt = before.receipts.pending.find(item => item.id === receiptId)
      const witness = this.#activeRuns.get(chatId)
      const { ids: runningIds, batchFields } = this.#runningControlReceipts(
        before, witness, chatId, receiptId, turnToken)
      const closeEvidenceId = `sbot-c2-runner-closed-v1:${receiptId}:${generation}`
      const proof = this.#journal.lookupRunnerClosed(closeEvidenceId)
      const dispatch = proof && this.#journal.effectDescriptor(proof.dispatchEffectId)
      const session = before.state.lanes.session?.[chatId]
      const cardFields = this.#cancellationCardFields(before, { receiptId,
        chatId, turnToken, generation, cardCleanup })
      if (this.blocked || assertWriterLock() !== true ||
          receipt?.source !== 'message' || receipt.chatId !== chatId ||
          witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
          proof?.receiptId !== receiptId || proof.chatId !== chatId ||
          proof.turnToken !== turnToken || proof.generation !== generation ||
          dispatch?.type !== 'dispatch' || dispatch.scope !== chatId ||
          dispatch.receiptId !== receiptId || dispatch.turnToken !== turnToken ||
          this.#journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
          !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
          session?.epoch !== turnToken || session.closeSeen !== true ||
          session.settled !== false ||
          before.state.lanes.turn?.[chatId]?.active !== turnToken ||
          before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          before.state.lanes.handoff[chatId].turnToken !== turnToken ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
          [...before.effects].some(([id, status]) => {
            const descriptor = this.#journal.effectDescriptor(id)
            return runningIds.includes(descriptor?.receiptId) &&
              (status !== 'acked' || descriptor.domain === 'terminal')
          }) ||
          verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
        throw new Error('C2 running recall lacks closed, unsettled turn proof')
      }
      const settledAt = this.#now()
      if (!Number.isSafeInteger(settledAt) || settledAt <= 0) {
        throw new TypeError('C2 running recall time invalid')
      }
      const eventId = `sbot-c2-cancel-v1:${receiptId}:${turnToken}:${generation}:${control}`
      const settled = new Set(runningIds)
      const receipts = {
        pending: before.receipts.pending.filter(item => !settled.has(item.id)),
        completed: [...before.receipts.completed,
          ...runningIds.map(id => ({ id, settledAt }))],
      }
      const prepared = this.#coordinator.prepare({ id: eventId,
        domain: 'terminal', scope: chatId,
        payload: { type: 'cancelRunningTurn', receiptId, turnToken,
          runnerGeneration: generation, runnerClosed: true,
          closeEvidenceId, control, ...cardFields, ...batchFields }, receipts,
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.decision?.receiptId !== receiptId ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batchFields.batchReceiptIds) ||
              candidate.decision?.turnToken !== turnToken ||
              candidate.decision?.control !== control ||
              candidate.decision?.quietSettlement !== true ||
              candidate.decision?.cardCleanupRequired !== false ||
              candidate.decision?.sealed !== false ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              candidate.state?.lanes?.turn?.[chatId]?.active !== null ||
              candidate.state?.lanes?.handoff?.[chatId]?.phase !== 'idle' ||
              candidate.state?.lanes?.session?.[chatId]?.settled !== true) {
            throw new Error('C2 running recall decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel()
        throw new Error('C2 running recall lost writer lock')
      }
      const result = prepared.commit()
      this.#activeRuns.delete(chatId)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { eventId, cursor: result.cursor, receiptId, status: 'cancelled',
        control, cancelledReceiptIds: runningIds }
    } catch (error) { this.close(); throw error }
  }

  // A hard timer has no outward acknowledgement. Its exact child closure,
  // pending receipt, ACKed effects and quiet settlement form one transition.
  commitHardTimeoutRelease({ receiptId, chatId, turnToken, generation,
    timeoutProof, cardCleanup = null, verifyGeneration, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId || '') || typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !GENERATION.test(generation || '') ||
        typeof verifyGeneration !== 'function' ||
        typeof assertWriterLock !== 'function' ||
        timeoutProof?.receiptId !== receiptId ||
        timeoutProof.turnToken !== turnToken ||
        timeoutProof.generation !== generation ||
        !Number.isSafeInteger(timeoutProof.deadlineAt) ||
        !Number.isSafeInteger(timeoutProof.elapsedAt) ||
        timeoutProof.deadlineAt <= 0 ||
        timeoutProof.elapsedAt < timeoutProof.deadlineAt ||
        this.#now() < timeoutProof.deadlineAt) {
      throw new TypeError('C2 hard timeout timer proof invalid')
    }
    try {
      const receipt = before.receipts.pending.find(item => item.id === receiptId)
      const witness = this.#activeRuns.get(chatId)
      const { ids: runningIds, batchFields } = this.#runningControlReceipts(
        before, witness, chatId, receiptId, turnToken)
      const closeEvidenceId = `sbot-c2-runner-closed-v1:${receiptId}:${generation}`
      const proof = this.#journal.lookupRunnerClosed(closeEvidenceId)
      const dispatch = proof && this.#journal.effectDescriptor(proof.dispatchEffectId)
      const session = before.state.lanes.session?.[chatId]
      const cardFields = this.#cancellationCardFields(before, { receiptId,
        chatId, turnToken, generation, cardCleanup })
      if (this.blocked || assertWriterLock() !== true ||
          receipt?.source !== 'message' || receipt.chatId !== chatId ||
          witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
          proof?.receiptId !== receiptId || proof.chatId !== chatId ||
          proof.turnToken !== turnToken || proof.generation !== generation ||
          dispatch?.type !== 'dispatch' || dispatch.scope !== chatId ||
          dispatch.receiptId !== receiptId || dispatch.turnToken !== turnToken ||
          this.#journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
          !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
          session?.epoch !== turnToken || session.closeSeen !== true ||
          session.settled !== false ||
          before.state.lanes.turn?.[chatId]?.active !== turnToken ||
          before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          before.state.lanes.handoff[chatId].turnToken !== turnToken ||
          before.state.lanes.stopIntent?.[chatId] !== undefined ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
          [...before.effects].some(([id, status]) => {
            const descriptor = this.#journal.effectDescriptor(id)
            return runningIds.includes(descriptor?.receiptId) &&
              (status !== 'acked' || descriptor.domain === 'terminal')
          }) ||
          verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
        throw new Error('C2 hard timeout lacks closed reconciled turn proof')
      }
      const settledAt = this.#now()
      if (!Number.isSafeInteger(settledAt) || settledAt <= 0) {
        throw new TypeError('C2 hard timeout time invalid')
      }
      const eventId = `sbot-c2-hard-timeout-release-v1:${receiptId}:${turnToken}:${generation}`
      const queue = before.state.lanes.queue?.[chatId]?.queue
      const settled = new Set(runningIds)
      const receipts = { pending: before.receipts.pending.filter(item => !settled.has(item.id)),
        completed: [...before.receipts.completed,
          ...runningIds.map(id => ({ id, settledAt }))] }
      const prepared = this.#coordinator.prepare({ id: eventId,
        domain: 'terminal', scope: chatId,
        payload: { type: 'hardTimeoutReleaseCommit', receiptId, turnToken,
          runnerGeneration: generation, timeoutElapsed: true, runnerClosed: true,
          closeEvidenceId, externalEffectsReconciled: true, ...cardFields,
          ...batchFields },
        receipts, validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.decision?.receiptId !== receiptId ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batchFields.batchReceiptIds) ||
              candidate.decision?.turnToken !== turnToken ||
              candidate.decision?.outcome?.status !== 'timeout' ||
              candidate.decision?.outcome?.silent !== true ||
              candidate.decision?.quietSettlement !== true ||
              candidate.decision?.cardOperations !== cardFields.cardOperations ||
              candidate.decision?.sealed !== false ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              candidate.state?.lanes?.turn?.[chatId]?.active !== null ||
              candidate.state?.lanes?.handoff?.[chatId]?.phase !== 'idle' ||
              candidate.state?.lanes?.session?.[chatId]?.settled !== true ||
              !isDeepStrictEqual(candidate.state?.lanes?.queue?.[chatId]?.queue, queue)) {
            throw new Error('C2 hard timeout release decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel(); throw new Error('C2 hard timeout lost writer lock')
      }
      const result = prepared.commit()
      this.#activeRuns.delete(chatId)
      if (this.#journal.snapshot().eventCount >= this.#maxEventCount ||
          this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { eventId, cursor: result.cursor, receiptId, status: 'timeout',
        settledReceiptIds: runningIds }
    } catch (error) { this.close(); throw error }
  }

  // Persist the separate /stop command receipt and its binding to the live
  // turn before asking the child to stop. A crash after this point leaves
  // startup closed rather than losing the command or replaying the runner.
  commitStopIntent({ controlReceipt, runningReceiptId, chatId, turnToken,
    generation, cardTarget = null, assertWriterLock } = {}) {
    const before = this.#capacity()
    const controlReceiptId = controlReceipt?.id
    if (!RECEIPT_ID.test(controlReceiptId || '') ||
        !RECEIPT_ID.test(runningReceiptId || '') ||
        controlReceiptId === runningReceiptId ||
        typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !GENERATION.test(generation || '') ||
        typeof assertWriterLock !== 'function' ||
        assertWriterLock.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 stop intent identity invalid')
    }
    try {
      const running = before.receipts.pending.find(item => item.id === runningReceiptId)
      const witness = this.#activeRuns.get(chatId)
      const { ids: runningIds, batchFields } = this.#runningControlReceipts(
        before, witness, chatId, runningReceiptId, turnToken)
      const registered = this.#journal.lookupRegistration(callbackRegistrationId({
        receiptId: runningReceiptId, generation,
        domain: 'atomicHandoff', kind: 'runnerAccepted' }))
      const cardOperations = this.#cardEffects(before, runningReceiptId,
        chatId, turnToken).length
      if (this.blocked || assertWriterLock() !== true ||
          before.receipts.pending.some(item => item.id === controlReceiptId) ||
          before.receipts.completed.some(item => item.id === controlReceiptId) ||
          controlReceipt.source !== 'message' || controlReceipt.chatId !== chatId ||
          !/^om_[A-Za-z0-9_-]{1,124}$/.test(controlReceipt.sourceId || '') ||
          controlReceipt.quiet !== false ||
          running?.chatId !== chatId || running.source !== 'message' ||
          witness?.receiptId !== runningReceiptId || witness.turnToken !== turnToken ||
          registered?.receiptId !== runningReceiptId ||
          registered.generation !== generation ||
          this.#journal.effectStatus(witness.dispatchEffectId) !== 'acked' ||
          before.state.lanes.turn?.[chatId]?.active !== turnToken ||
          before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          before.state.lanes.stopIntent?.[chatId] !== undefined ||
          (cardOperations > 0 &&
            (cardTarget?.chatId !== chatId || !cardTarget.cardId || !cardTarget.msgId)) ||
          [...before.effects].some(([id, status]) => {
            const descriptor = this.#journal.effectDescriptor(id)
            return runningIds.includes(descriptor?.receiptId) &&
              (status !== 'acked' || descriptor.domain === 'terminal')
          }) ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
        throw new Error('C2 stop intent differs from running durable turn')
      }
      const eventId = `sbot-c2-stop-intent-v1:${controlReceiptId}:${runningReceiptId}:${turnToken}:${generation}`
      const receipts = { pending: [...before.receipts.pending, controlReceipt],
        completed: [...before.receipts.completed] }
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'control',
        scope: chatId, payload: { type: 'stopIntent', controlReceiptId,
          runningReceiptId, turnToken, runnerGeneration: generation,
          cardOperations, ...batchFields }, receipts,
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.effects?.length !== 0 ||
              candidate.effectDescriptors?.length !== 0 ||
              candidate.decision?.controlReceiptId !== controlReceiptId ||
              candidate.decision?.runningReceiptId !== runningReceiptId ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batchFields.batchReceiptIds) ||
              candidate.decision?.turnToken !== turnToken ||
              !isDeepStrictEqual(candidate.state?.lanes?.stopIntent?.[chatId],
                { phase: 'intent', controlReceiptId, runningReceiptId,
                  turnToken, runnerGeneration: generation, ...batchFields })) {
            throw new Error('C2 stop intent decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel()
        throw new Error('C2 stop intent lost writer lock')
      }
      const result = prepared.commit()
      return { eventId, cursor: result.cursor, controlReceiptId }
    } catch (error) { this.close(); throw error }
  }

  commitStopAll({ controlReceiptId, runningReceiptId, chatId, turnToken,
    generation, queuedReceiptIds, payloadHandles, cardCleanup = null, verifyGeneration,
    assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(controlReceiptId || '') ||
        !RECEIPT_ID.test(runningReceiptId || '') ||
        controlReceiptId === runningReceiptId ||
        typeof chatId !== 'string' || !chatId ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !GENERATION.test(generation || '') ||
        !Array.isArray(queuedReceiptIds) ||
        new Set(queuedReceiptIds).size !== queuedReceiptIds.length ||
        !(payloadHandles instanceof C2PayloadHandles) ||
        typeof verifyGeneration !== 'function' ||
        typeof assertWriterLock !== 'function') {
      throw new TypeError('C2 stop-all identity invalid')
    }
    try {
      const control = before.receipts.pending.find(item => item.id === controlReceiptId)
      const running = before.receipts.pending.find(item => item.id === runningReceiptId)
      const intent = before.state.lanes.stopIntent?.[chatId]
      const witness = this.#activeRuns.get(chatId)
      const { ids: runningIds, batchFields } = this.#runningControlReceipts(
        before, witness, chatId, runningReceiptId, turnToken)
      const closeEvidenceId = `sbot-c2-runner-closed-v1:${runningReceiptId}:${generation}`
      const proof = this.#journal.lookupRunnerClosed(closeEvidenceId)
      const dispatch = proof && this.#journal.effectDescriptor(proof.dispatchEffectId)
      const session = before.state.lanes.session?.[chatId]
      const cardFields = this.#cancellationCardFields(before, {
        receiptId: runningReceiptId, chatId, turnToken, generation, cardCleanup })
      const queued = queuedPayloads(before, chatId, payloadHandles)
      if (this.blocked || assertWriterLock() !== true ||
          control?.chatId !== chatId || control.source !== 'message' || control.quiet ||
          running?.chatId !== chatId || running.source !== 'message' ||
          !isDeepStrictEqual(intent, { phase: 'intent', controlReceiptId,
            runningReceiptId, turnToken, runnerGeneration: generation,
            ...batchFields }) ||
          witness?.receiptId !== runningReceiptId || witness.turnToken !== turnToken ||
          proof?.receiptId !== runningReceiptId || proof.chatId !== chatId ||
          proof.turnToken !== turnToken || proof.generation !== generation ||
          dispatch?.type !== 'dispatch' || dispatch.scope !== chatId ||
          dispatch.receiptId !== runningReceiptId ||
          this.#journal.effectStatus(proof.dispatchEffectId) !== 'acked' ||
          !this.#journal.hasEvent(`sbot-c2-session-close-v1:${runningReceiptId}:${generation}`) ||
          session?.epoch !== turnToken || session.closeSeen !== true ||
          session.settled !== false ||
          before.state.lanes.turn?.[chatId]?.active !== turnToken ||
          before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          !isDeepStrictEqual(queued.accepted, queuedReceiptIds) ||
          queued.queue.some(item => item.batch) ||
          [...before.effects].some(([id, status]) => {
            const descriptor = this.#journal.effectDescriptor(id)
            return [...runningIds, controlReceiptId, ...queuedReceiptIds]
              .includes(descriptor?.receiptId) &&
              (status !== 'acked' || descriptor.domain === 'terminal')
          }) ||
          !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
          verifyGeneration({ chatId, receiptId: runningReceiptId,
            turnToken, generation }) !== true) {
        throw new Error('C2 stop-all lacks exact closed turn and queue proof')
      }
      const settledAt = this.#now()
      if (!Number.isSafeInteger(settledAt) || settledAt <= 0) {
        throw new TypeError('C2 stop-all time invalid')
      }
      const all = new Set([...runningIds, ...queuedReceiptIds])
      const receipts = { pending: before.receipts.pending.filter(item => !all.has(item.id)),
        completed: [...before.receipts.completed,
          ...[...all].map(id => ({ id, settledAt }))] }
      const controlTargetId = `receipt:control:${controlReceiptId}`
      const eventId = `sbot-c2-stop-all-v1:${controlReceiptId}:${runningReceiptId}:${turnToken}:${generation}`
      const effectId = `sbot-c2-effect-v1:${Buffer.byteLength(eventId)}:${eventId}:0`
      const prepared = this.#coordinator.prepare({ id: eventId, domain: 'control',
        scope: chatId, payload: { type: 'stopAllCommit', controlReceiptId,
          controlTargetId, runningReceiptId, turnToken, runnerGeneration: generation,
          runnerClosed: true, closeEvidenceId, queuedReceiptIds,
          ...cardFields, ...batchFields }, receipts,
        validate: candidate => {
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.decision?.controlReceiptId !== controlReceiptId ||
              candidate.decision?.runningReceiptId !== runningReceiptId ||
              !isDeepStrictEqual(candidate.decision?.batchReceiptIds,
                batchFields.batchReceiptIds) ||
              !isDeepStrictEqual(candidate.decision?.queuedReceiptIds, queuedReceiptIds) ||
              candidate.decision?.stopAckEffectId !== effectId ||
              candidate.decision?.controlTargetId !== controlTargetId ||
              candidate.decision?.quietSettlement !== true ||
              candidate.effects?.length !== 1 ||
              !isDeepStrictEqual(candidate.effects[0],
                { type: 'stopAck', controlReceiptId, targetId: controlTargetId, effectId }) ||
              !isDeepStrictEqual(candidate.effectDescriptors?.[0],
                { effectId, domain: 'control', scope: chatId, type: 'stopAck',
                  turnToken: null, receiptId: controlReceiptId,
                  targetId: controlTargetId }) ||
              candidate.state?.lanes?.stopIntent?.[chatId] !== undefined ||
              candidate.state?.lanes?.turn?.[chatId]?.active !== null ||
              candidate.state?.lanes?.handoff?.[chatId]?.phase !== 'idle' ||
              candidate.state?.lanes?.queue?.[chatId]?.queue?.length !== 0) {
            throw new Error('C2 stop-all decision invalid')
          }
        } })
      if (assertWriterLock() !== true) {
        prepared.cancel()
        throw new Error('C2 stop-all lost writer lock')
      }
      const result = prepared.commit()
      payloadHandles.dropDurablyStopped(queuedReceiptIds, eventId)
      this.#activeRuns.delete(chatId)
      return { eventId, cursor: result.cursor, effectId, controlReceiptId,
        cancelledReceiptIds: [...all] }
    } catch (error) { this.close(); throw error }
  }

  // One stop confirmation uses its own accepted command receipt. The Feishu
  // call is allowed only after the stop-all transition and durable attempt.
  async executeStopAck({ effectId, controlReceiptId, chatId, target,
    perform, confirm, assertWriterLock } = {}) {
    const before = this.#completionCapacity()
    const receipt = before.receipts.pending.find(item => item.id === controlReceiptId)
    const descriptor = this.#journal.effectDescriptor(effectId)
    if (!RECEIPT_ID.test(controlReceiptId || '') ||
        typeof chatId !== 'string' || !chatId ||
        !target || typeof target !== 'object' || Array.isArray(target) ||
        target.receiptId !== controlReceiptId || target.chatId !== chatId ||
        target.sourceId !== receipt?.sourceId ||
        target.replyCtx?.chatId !== chatId ||
        target.replyCtx?.messageId !== receipt?.sourceId ||
        typeof perform !== 'function' || typeof confirm !== 'function' ||
        typeof assertWriterLock !== 'function' ||
        descriptor?.domain !== 'control' || descriptor.type !== 'stopAck' ||
        descriptor.scope !== chatId || descriptor.receiptId !== controlReceiptId ||
        descriptor.targetId !== `receipt:control:${controlReceiptId}` ||
        descriptor.turnToken !== null ||
        this.#journal.effectStatus(effectId) !== 'pending' ||
        before.state.lanes.stopIntent?.[chatId] !== undefined ||
        before.state.lanes.turn?.[chatId]?.active !== null ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'idle' ||
        before.state.lanes.queue?.[chatId]?.queue?.length !== 0 ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
        assertWriterLock() !== true) {
      this.close()
      throw new Error('C2 stop acknowledgement lacks exact durable target and effect')
    }
    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      this.close()
      throw new TypeError('C2 stop acknowledgement time invalid')
    }
    this.#externalEffectInFlight = true
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let confirmed = false
      let response
      try {
        response = await perform(target)
        confirmed = confirm(response) === true &&
          this.#effectAuthorityReady && assertWriterLock() === true
      } catch { /* The platform outcome may have succeeded. */ }
      const now = this.#now()
      const resolvedAt = Number.isSafeInteger(now) && now > 0
        ? Math.max(attemptedAt, now) : attemptedAt
      if (!confirmed) {
        if (assertWriterLock() === true) {
          this.#journal.recordEffectOutcome({ effectId, status: 'unknown',
            resolvedAt })
        }
        this.close()
        throw new Error('C2 stop acknowledgement outcome unknown')
      }
      this.#journal.settleStopAck({ effectId, receiptId: controlReceiptId,
        chatId, settledAt: resolvedAt })
      if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { effectId, receiptId: controlReceiptId, status: 'acked', response }
    } catch (error) { this.close(); throw error }
    finally { this.#externalEffectInFlight = false }
  }

  // Development-only terminal executor. The normal Engine path never calls
  // this yet. It executes one externally visible reply only after a durable
  // attempt; a lost ACK leaves the receipt and effect ambiguous on restart.
  async executeTerminalEffect({ effectId, receiptId, chatId, turnToken, generation,
    verifyGeneration, resolveTarget, perform, confirm, assertWriterLock = () => true } = {}) {
    const before = this.#completionCapacity()
    if (typeof effectId !== 'string' || !RECEIPT_ID.test(receiptId) ||
        typeof chatId !== 'string' || !chatId || !GENERATION.test(generation) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 terminal effect identity invalid')
    }
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const descriptor = this.#journal.effectDescriptor(effectId)
    const witness = this.#activeRuns.get(chatId)
    const terminalCapability = this.#terminalAwaitingSettlement.get(chatId)
    const terminal = before.state.lanes.terminal?.[chatId]
    const runningReceiptIds = terminal?.batchReceiptIds || [receiptId]
    const expectedType = receipt?.quiet || terminal?.outcome?.silent
      ? 'quietCompletion' : 'finalReply'
    const registration = this.#journal.lookupRegistration(callbackRegistrationId({ receiptId,
      generation, domain: 'terminal', kind: 'finalizeEffectCommit' }))
    if (!receipt || receipt.chatId !== chatId ||
        witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
        !isDeepStrictEqual(witness.batchReceiptIds, runningReceiptIds) ||
        terminal?.replyTargetReceiptId !==
          (runningReceiptIds.length > 1 ? receiptId : undefined) ||
        runningReceiptIds.some(id =>
          before.receipts.pending.find(item => item.id === id)?.chatId !== chatId) ||
        terminalCapability?.effectId !== effectId ||
        terminalCapability.receiptId !== receiptId ||
        terminalCapability.turnToken !== turnToken ||
        terminalCapability.generation !== generation || terminalCapability.ready ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== turnToken ||
        terminal?.finalized !== true ||
        terminal.pendingEffectIds?.at(-1) !== effectId ||
        !terminal.pendingEffectIds.slice(0, -1).every(id =>
          this.#journal.effectStatus(id) === 'acked') ||
        descriptor?.domain !== 'terminal' || descriptor.scope !== chatId ||
        descriptor.type !== expectedType || descriptor.turnToken !== turnToken ||
        descriptor.receiptId !== receiptId || descriptor.targetId !== null ||
        this.#journal.effectStatus(effectId) !== 'pending' ||
        registration?.generation !== generation || registration.receiptId !== receiptId ||
        verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true ||
        assertWriterLock() !== true) {
      throw new Error('C2 terminal effect lacks exact live authority')
    }
    if (expectedType === 'quietCompletion') {
      if (resolveTarget !== undefined || perform !== undefined || confirm !== undefined) {
        throw new Error('C2 quiet completion cannot perform an external effect')
      }
      terminalCapability.ready = true
      return { effectId, status: 'ready-to-settle', external: false }
    }
    if (typeof resolveTarget !== 'function' ||
        resolveTarget.constructor?.name === 'AsyncFunction' ||
        typeof perform !== 'function' || typeof confirm !== 'function' ||
        confirm.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 final reply needs one confirmed platform operation')
    }
    const target = resolveTarget({ id: receipt.id, chatId: receipt.chatId,
      source: receipt.source, sourceId: receipt.sourceId })
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        typeof target.then === 'function' || target.receiptId !== receiptId ||
        target.chatId !== chatId || target.sourceId !== receipt.sourceId ||
        target.replyCtx == null) {
      throw new Error('C2 final reply target differs from durable receipt')
    }
    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      throw new TypeError('C2 terminal effect time invalid')
    }
    this.#externalEffectInFlight = true
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let confirmed = false
      try {
        const reply = await perform({ effectId, target })
        confirmed = confirm(reply) === true &&
          this.#effectAuthorityReady &&
          assertWriterLock() === true &&
          verifyGeneration({ chatId, receiptId, turnToken, generation }) === true
      } catch { /* External outcome is unknown after the durable attempt. */ }
      const now = this.#now()
      const resolvedAt = Number.isSafeInteger(now) && now > 0
        ? Math.max(attemptedAt, now) : attemptedAt
      if (!confirmed) {
        if (assertWriterLock() === true) {
          this.#journal.recordEffectOutcome({ effectId, status: 'unknown', resolvedAt })
        }
        this.close()
        throw new Error('C2 final reply outcome unknown; manual recovery required')
      }
      terminalCapability.ready = true
      return { effectId, status: 'confirmed-pending-release', external: true }
    } catch (error) {
      this.close()
      throw error
    } finally { this.#externalEffectInFlight = false }
  }

  // The runner-close and queue-release callbacks still need the pending
  // receipt. Only after both durable transitions may reply ACK and receipt
  // completion share one record. Successor dispatch remains held until prune.
  settleTerminalEffect({ effectId, receiptId, chatId, turnToken, generation } = {}) {
    const before = this.#completionCapacity()
    if (typeof effectId !== 'string' || !RECEIPT_ID.test(receiptId) ||
        typeof chatId !== 'string' || !chatId || !GENERATION.test(generation) ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0) {
      throw new TypeError('C2 terminal settlement identity invalid')
    }
    const capability = this.#terminalAwaitingSettlement.get(chatId)
    const handoff = before.state.lanes.handoff?.[chatId]
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const batchReceiptIds = capability?.batchReceiptIds
    const session = before.state.lanes.session?.[chatId]
    if (!capability || capability.effectId !== effectId ||
        capability.receiptId !== receiptId || capability.turnToken !== turnToken ||
        capability.generation !== generation || !capability.ready ||
        !capability.releaseCommitted || !receipt || receipt.chatId !== chatId ||
        session?.epoch !== turnToken || session.closeSeen !== true ||
        session.settled !== false ||
        !this.#journal.hasEvent(`sbot-c2-session-close-v1:${receiptId}:${generation}`) ||
        (batchReceiptIds !== null &&
          (!isDeepStrictEqual(before.state.lanes.terminal?.[chatId]?.batchReceiptIds,
            batchReceiptIds) ||
            before.state.lanes.terminal[chatId].replyTargetReceiptId !== receiptId ||
            batchReceiptIds.some(id =>
              before.receipts.pending.find(item => item.id === id)?.chatId !== chatId))) ||
        before.state.lanes.turn?.[chatId]?.active !== null ||
        !['idle', 'handoff'].includes(handoff?.phase) ||
        handoff.turnToken !== turnToken ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state)) {
      throw new Error('C2 terminal settlement requires confirmed release')
    }
    const settledAt = this.#now()
    if (!Number.isSafeInteger(settledAt) || settledAt <= 0) {
      throw new TypeError('C2 terminal settlement time invalid')
    }
    try {
      const result = this.#journal.settleTerminalEffect({ effectId, receiptId,
        chatId, turnToken, status: 'acked', settledAt,
        ...(batchReceiptIds ? { batchReceiptIds: [...batchReceiptIds] } : {}),
        ...(before.state.lanes.terminal?.[chatId]?.steerReceiptIds ? {
          steerReceiptIds: [...before.state.lanes.terminal[chatId].steerReceiptIds] } : {}) })
      pruneConfirmedTerminal({ journal: this.#journal,
        coordinator: this.#coordinator, scope: chatId })
      this.#terminalAwaitingSettlement.delete(chatId)
      if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return { effectId, status: result, receiptId, pruned: true }
    } catch (error) { this.close(); throw error }
  }

  // Development-only boundary for one Feishu card SDK operation. The adapter
  // supplies a stable operationId and a single-use invoke. This path never
  // authorizes the final text reply or the normal Engine runner.
  async performOutboundCardOperation({ receiptId, chatId, turnToken, generation,
    operation, verifyGeneration, confirm } = {}) {
    const before = this.#completionCapacity()
    if (!RECEIPT_ID.test(receiptId) || typeof chatId !== 'string' || !chatId ||
        !GENERATION.test(generation) || !Number.isSafeInteger(turnToken) ||
        turnToken <= 0 || typeof verifyGeneration !== 'function' ||
        verifyGeneration.constructor?.name === 'AsyncFunction' ||
        typeof confirm !== 'function' || confirm.constructor?.name === 'AsyncFunction') {
      throw new TypeError('C2 outbound card identity invalid')
    }
    const { operationId, eventId } = cardOperationIdentity({ receiptId,
      turnToken, generation, operation })
    const receipt = before.receipts.pending.find(item => item.id === receiptId)
    const witness = this.#activeRuns.get(chatId)
    const cleanupLane = before.state.lanes.cardCleanup?.[chatId]
    if (!receipt || receipt.chatId !== chatId ||
        (before.state.lanes.stopIntent?.[chatId] &&
          !(operation.kind === 'message.delete' && cleanupLane?.phase === 'intent')) ||
        (cleanupLane &&
          !(operation.kind === 'message.delete' && cleanupLane.phase === 'intent' &&
            cleanupLane.receiptId === receiptId &&
            cleanupLane.turnToken === turnToken &&
            cleanupLane.deleteOperationId === operationId)) ||
        (operation.chatId !== undefined && operation.chatId !== chatId) ||
        witness?.receiptId !== receiptId || witness.turnToken !== turnToken ||
        !witness.jobReceiptIds.includes(receiptId) ||
        !isDeepStrictEqual(witness.jobReceiptIds, witness.batchReceiptIds) ||
        !isDeepStrictEqual(before.state.lanes.handoff?.[chatId]?.acceptedReceiptIds,
          witness.batchReceiptIds.length > 1 ? witness.batchReceiptIds : []) ||
        witness.batchReceiptIds.some(id =>
          before.receipts.pending.find(item => item.id === id)?.chatId !== chatId) ||
        this.#journal.effectStatus(witness.dispatchEffectId) !== 'acked' ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.state.lanes.handoff[chatId].turnToken !== turnToken ||
        this.#terminalAwaitingSettlement.has(chatId) ||
        !isDeepStrictEqual(this.#coordinator.snapshot(), before.state) ||
        verifyGeneration({ chatId, receiptId, turnToken, generation }) !== true) {
      throw new Error('C2 outbound card lacks exact live running receipt authority')
    }
    if (this.#journal.hasEvent(eventId)) {
      throw new Error('C2 outbound card operation already committed')
    }
    const effectId = `sbot-c2-effect-v1:${Buffer.byteLength(eventId)}:${eventId}:0`
    try {
      const prepared = this.#coordinator.prepare({ id: eventId,
        domain: 'outbound', scope: chatId,
        payload: { type: 'prepareCardOperation', kind: operation.kind,
          receiptId, turnToken, operationId },
        validate: candidate => {
          const descriptor = candidate.effectDescriptors?.[0]
          const effect = candidate.effects?.[0]
          if (candidate.cursor !== before.cursor + 1 ||
              candidate.state?.seq !== candidate.cursor ||
              !isDeepStrictEqual(candidate.state.lanes, before.state.lanes) ||
              !isDeepStrictEqual(candidate.decision, {
                type: operation.kind, operationId, receiptId, turnToken }) ||
              candidate.effects.length !== 1 || effect?.type !== operation.kind ||
              effect.operationId !== operationId ||
              effect.turnToken !== turnToken || effect.effectId !== effectId ||
              !isDeepStrictEqual(descriptor, { effectId, domain: 'outbound',
                scope: chatId, type: operation.kind, turnToken, receiptId,
                targetId: null })) {
            throw new Error('C2 outbound card result invalid')
          }
        } })
      prepared.commit()
    } catch (error) { this.close(); throw error }

    const attemptedAt = this.#now()
    if (!Number.isSafeInteger(attemptedAt) || attemptedAt <= 0) {
      this.close()
      throw new TypeError('C2 outbound card time invalid')
    }
    this.#externalEffectInFlight = true
    try {
      this.#journal.beginEffectAttempt({ effectId, attemptedAt })
      let response
      let confirmed = false
      try {
        response = await operation.invoke()
        confirmed = confirm(response, operation) === true &&
          this.#effectAuthorityReady &&
          verifyGeneration({ chatId, receiptId, turnToken, generation }) === true
      } catch { /* The SDK call may have succeeded; never retry this ID. */ }
      const now = this.#now()
      const resolvedAt = Number.isSafeInteger(now) && now > 0
        ? Math.max(attemptedAt, now) : attemptedAt
      this.#journal.recordEffectOutcome({ effectId,
        status: confirmed ? 'acked' : 'unknown', resolvedAt })
      if (!confirmed) {
        this.close()
        throw new Error('C2 outbound card outcome unknown; manual recovery required')
      }
      if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
      return response
    } catch (error) { this.close(); throw error }
    finally { this.#externalEffectInFlight = false }
  }

  recordEffect(effectId, status) {
    if (!this.#effectAuthorityReady || this.#opening || this.#externalEffectInFlight ||
        this.#journal.blocked) {
      throw new Error('C2 durable runtime effect authority closed')
    }
    const descriptor = this.#journal.effectDescriptor(effectId)
    if (descriptor?.type === 'scheduleDispatch' &&
        this.#terminalAwaitingSettlement.has(descriptor.scope)) {
      throw new Error('C2 successor schedule awaits prior terminal settlement')
    }
    const result = this.#journal.recordEffect(effectId, status)
    if (this.#journal.byteLength >= this.#maxJournalBytes) this.#sealForCapacity()
    return result
  }

  snapshot() { return this.#journal.snapshot() }

  scopeState(domain, scope) {
    if (typeof domain !== 'string' || typeof scope !== 'string' || !domain || !scope) {
      throw new TypeError('C2 scope required')
    }
    const lane = this.#journal.snapshot().state.lanes[domain]?.[scope]
    return lane === undefined ? null : structuredClone(lane)
  }
}

module.exports = { C2DurableRuntime }
