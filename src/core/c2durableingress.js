'use strict'

const { isDeepStrictEqual } = require('node:util')
const { taskId } = require('./enginecheckpoint')
const { platformMessageEventId } = require('./c2eventidentity')
const { validatePersistentReceipts, validatePersistentRelation } = require('./c2persistrelation')
const { EngineStepCoordinator } = require('./enginestepcoordinator')

const RECEIPT_KEYS = ['id', 'source', 'chatId', 'sourceId', 'acceptedAt', 'quiet']
const FLAGS = ['quiet', 'polled', 'synthetic', 'wantsAck', 'resetSessionAfter',
  'emptyRetried', 'freshRetried', 'firstResumed', 'failedOver']
const MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/
const SCOPE = /^[A-Za-z0-9_-]{1,128}$/

function exactKeys(value, keys, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.getPrototypeOf(value) !== Object.prototype ||
      Reflect.ownKeys(value).length !== keys.length ||
      Reflect.ownKeys(value).some(key => typeof key !== 'string' || !keys.includes(key) ||
        !Object.getOwnPropertyDescriptor(value, key)?.enumerable ||
        !Object.hasOwn(Object.getOwnPropertyDescriptor(value, key), 'value'))) {
    throw new TypeError(`invalid C2 ${label}`)
  }
  return value
}

// Development-only first acceptance. The platform source ID must already be
// stable, but its receipt is still a candidate here. Identity and receipt are
// published only by the same fsynced queue transition; a crash before commit
// leaves neither accepted. The daemon's single-writer lock is required.
class C2DurableIngress {
  #journal
  #host
  #startupBlocked
  #gate = null

  constructor(journal, { host = null } = {}) {
    if (!journal || typeof journal.snapshot !== 'function' ||
        typeof journal.hasEvent !== 'function' ||
        typeof journal.appendTransition !== 'function') {
      throw new TypeError('C2 durable ingress needs a journal')
    }
    this.#journal = journal
    this.#host = host || new EngineStepCoordinator({ journal })
    if (host && (typeof host.snapshot !== 'function' || typeof host.prepare !== 'function' ||
        host.blocked || !isDeepStrictEqual(host.snapshot(), journal.snapshot().state))) {
      throw new Error('C2 ingress coordinator differs from durable authority')
    }
    // A newly constructed adapter has no proof of prior payloads, callbacks
    // or external effects. Only a fresh genesis may admit first acceptance;
    // formal startup recovery must supply a separate verified reopen path.
    const snapshot = journal.snapshot()
    this.#startupBlocked = snapshot.cursor !== 0 ||
      snapshot.receipts.pending.length !== 0 ||
      Object.keys(snapshot.state.lanes).length !== 0
  }

  // Recovery may settle old receipts, but it cannot recreate lost payloads or
  // runner handles. A new ingress adapter is authorized only by the opened
  // startup gate and a completely quiescent durable snapshot.
  static resumeAfterVerifiedRecovery({ journal, coordinator, gate } = {}) {
    if (!journal || !coordinator || typeof coordinator.snapshot !== 'function' ||
        coordinator.blocked ||
        !gate || typeof gate.isClosed !== 'function' || gate.isClosed() !== false ||
        journal.blocked) throw new Error('C2 ingress recovery gate is not verified open')
    const snapshot = journal.snapshot()
    if (snapshot.state?.version !== 2 || snapshot.cursor !== snapshot.state.seq ||
        !isDeepStrictEqual(coordinator.snapshot(), snapshot.state) ||
        !snapshot.effects || !(snapshot.effects instanceof Map) ||
        !snapshot.notices || !(snapshot.notices instanceof Map)) {
      throw new Error('C2 ingress differs from verified durable authority')
    }
    validatePersistentReceipts(snapshot.receipts)
    validatePersistentRelation(snapshot.state, snapshot.receipts)
    const lanes = snapshot.state.lanes
    const unresolved = snapshot.receipts.pending.length > 0 ||
      Object.values(lanes.queue || {}).some(lane => lane.queue.length > 0) ||
      [...snapshot.effects].some(([effectId, status]) => status !== 'acked' &&
        !(status === 'notStarted' && journal.runnerNotStartedProofs().some(proof =>
          proof.dispatchEffectId === effectId && journal.hasEvent(
            `sbot-c2-runner-not-started-commit-v1:${proof.receiptId}:${proof.turnToken}:${proof.generation}`)))) ||
      [...snapshot.notices.values()].some(notice =>
        notice.status === 'attempting' || notice.status === 'unknown') ||
      Object.values(lanes.lifecycle || {}).some(lane => lane.busy || lane.controller) ||
      Object.values(lanes.turn || {}).some(lane => lane.active !== null) ||
      Object.values(lanes.terminal || {}).some(lane => lane.finalized) ||
      Object.values(lanes.handoff || {}).some(lane => lane.phase !== 'idle') ||
      Object.values(lanes.intake || {}).some(lane => lane.pending !== null) ||
      Object.values(lanes.session || {}).some(lane => !lane.settled)
    if (unresolved) throw new Error('C2 ingress has unresolved durable or host work')
    const ingress = new C2DurableIngress(journal, { host: coordinator })
    ingress.#startupBlocked = false
    ingress.#gate = gate
    return ingress
  }

  get blocked() { return this.#startupBlocked || this.#host.blocked || this.#journal.blocked ||
    (this.#gate !== null && this.#gate.isClosed() !== false) }
  snapshot() { return this.#journal.snapshot() }

  enqueueMessage({ receipt, flags, front = false } = {}) {
    if (this.blocked) throw new Error('C2 ingress closed pending startup recovery')
    exactKeys(receipt, RECEIPT_KEYS, 'message receipt')
    exactKeys(flags, FLAGS, 'queue flags')
    if (receipt.source !== 'message' || typeof receipt.sourceId !== 'string' ||
        !MESSAGE_ID.test(receipt.sourceId) || typeof receipt.chatId !== 'string' ||
        !SCOPE.test(receipt.chatId) || ['__proto__', 'constructor', 'prototype'].includes(receipt.chatId) ||
        receipt.id !== taskId(receipt) ||
        flags.quiet !== receipt.quiet || flags.synthetic !== false ||
        typeof front !== 'boolean') {
      throw new TypeError('C2 ingress needs a stable platform message and matching flags')
    }
    for (const key of FLAGS) {
      if (typeof flags[key] !== 'boolean') throw new TypeError(`invalid C2 queue flag ${key}`)
    }
    validatePersistentReceipts({ pending: [receipt], completed: [] })
    const before = this.#journal.snapshot()
    if (before.state.version !== 2 || this.#host.snapshot().seq !== before.cursor ||
        !isDeepStrictEqual(this.#host.snapshot(), before.state)) {
      throw new Error('C2 ingress differs from durable authority')
    }
    if (before.receipts.pending.some(item => item.id === receipt.id) ||
        before.receipts.completed.some(item => item.id === receipt.id)) {
      throw new Error('C2 message receipt already accepted')
    }
    const id = platformMessageEventId({ receiptId: receipt.id, domain: 'queue',
      kind: 'enqueue', lookupReceipt: lookupId => lookupId === receipt.id ? receipt : null })
    if (this.#journal.hasEvent(id)) throw new Error('C2 platform event already committed')
    const job = { id: `receipt:job:${receipt.id}` }
    for (const key of FLAGS) job[key] = flags[key]
    const receipts = { pending: [...before.receipts.pending, structuredClone(receipt)],
      completed: before.receipts.completed }
    const prepared = this.#host.prepare({ id, domain: 'queue', scope: receipt.chatId,
      ...(before.state.lanes.queue?.[receipt.chatId] ? {} : { seed: { queue: [] } }),
      payload: { type: 'enqueue', job, front }, receipts,
      validate: result => {
        const lane = result.state?.lanes?.queue?.[receipt.chatId]
        if (!lane || !Array.isArray(lane.queue) ||
            lane.queue.filter(item => item.id === job.id).length !== 1 ||
            result.effects.length !== 0) {
          throw new Error('C2 ingress returned invalid queue result')
        }
      } })
    return prepared.commit()
  }
}

module.exports = { C2DurableIngress }
