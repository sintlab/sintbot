'use strict'

const { randomUUID } = require('node:crypto')
const { engineStep, resetBinaryCore } = require('../agent/privatecore')

// Development bridge for the unified C2 entry. A prepared result reserves the
// coordinator while other host reducers validate; only commit publishes it.
// Persistence is opt-in: lifecycle state can contain turnText, so callers must
// provide an approved durable representation before enabling a writer.
class EngineStepCoordinator {
  #committed
  #blocked = false
  #pending = null
  #step
  #reset
  #persist
  #journal

  constructor({ state = { version: 1, seq: 0, lanes: {} }, step = engineStep,
    reset = resetBinaryCore, persist = null, journal = null } = {}) {
    const durable = journal?.snapshot?.()
    if (journal) state = durable?.state
    if (typeof step !== 'function' || typeof reset !== 'function' ||
        (persist !== null && (typeof persist !== 'function' || persist.constructor?.name === 'AsyncFunction')) ||
        (journal !== null && (persist !== null || typeof journal.snapshot !== 'function' ||
          typeof journal.hasEvent !== 'function' || typeof journal.appendTransition !== 'function' ||
          state?.version !== 2 || durable.cursor !== state.seq)) || !validState(state)) {
      throw new TypeError('invalid C2 step coordinator')
    }
    this.#committed = structuredClone(state)
    this.#step = step
    this.#reset = reset
    this.#persist = persist
    this.#journal = journal
  }

  get blocked() { return this.#blocked }
  snapshot() { return structuredClone(this.#committed) }

  prepare({ domain, scope, payload, seed, id, validate = null, receipts = null } = {}) {
    if (this.#blocked) throw new Error('C2 step coordinator needs recovery')
    if (this.#pending) throw new Error('C2 step coordinator has an uncommitted transition')
    if (this.#journal && id === undefined) throw new Error('durable C2 event ID required')
    id ??= randomUUID()
    const token = {}
    this.#pending = token
    const event = { id, domain, scope, expectedCursor: this.#committed.seq, payload }
    if (seed !== undefined) event.seed = seed
    try {
      if (![id, domain, scope].every(value => typeof value === 'string' &&
          Buffer.byteLength(value) > 0 && Buffer.byteLength(value) <= 256) ||
          !payload || typeof payload !== 'object' || Array.isArray(payload) ||
          (seed !== undefined && (!seed || typeof seed !== 'object' || Array.isArray(seed)))) {
        throw new TypeError('invalid C2 step event')
      }
      if (validate !== null && typeof validate !== 'function') throw new TypeError('invalid C2 step validator')
      if (validate && validate.constructor?.name === 'AsyncFunction') throw new TypeError('C2 step validator must be synchronous')
      if (this.#journal && this.#journal.hasEvent(id)) throw new Error('C2 event already committed')
      const durableReceipts = this.#journal
        ? structuredClone(receipts ?? this.#journal.snapshot().receipts) : null
      const admission = this.#journal
        ? { version: 1, cursor: this.#committed.seq, eventId: id, unseen: true } : undefined
      const result = this.#step(this.snapshot(), event, admission)
      const copy = structuredClone(result)
      if (!validResult(copy, this.#committed.seq, id, domain, scope)) {
        throw new Error('invalid C2 step result')
      }
      if (validate) {
        const verdict = validate(structuredClone(copy))
        if (verdict && typeof verdict.then === 'function') throw new TypeError('C2 step validator must be synchronous')
      }
      return {
        result: structuredClone(copy),
        commit: () => {
          if (this.#pending !== token || this.#blocked) throw new Error('C2 step preparation is no longer current')
          try {
            if (this.#journal) {
              this.#journal.appendTransition({ eventId: id, before: this.#committed.seq,
                after: copy.state.seq, state: copy.state, receipts: durableReceipts,
                effectIds: copy.effects.map(effect => effect.effectId),
                ...(copy.effectDescriptors === undefined ? {} :
                  { effectDescriptors: copy.effectDescriptors }) })
            } else if (this.#persist) {
              const saved = this.#persist(structuredClone(copy.state))
              if (saved && typeof saved.then === 'function') throw new TypeError('C2 step persistence must be synchronous')
            }
            this.#committed = structuredClone(copy.state)
            this.#pending = null
            return structuredClone(copy)
          } catch (error) {
            this.#pending = null
            this.#blocked = true
            throw error
          }
        },
        cancel: () => {
          if (this.#pending !== token) return false
          this.#pending = null
          return true
        },
      }
    } catch (error) {
      this.#pending = null
      this.#blocked = true
      throw error
    }
  }

  transition(options) { return this.prepare(options).commit() }

  recover(state) {
    if (this.#journal) throw new Error('durable C2 recovery needs verified journal reopen')
    // A failed durable writer may have committed before reporting an error.
    // Its last trusted on-disk snapshot must be supplied by the caller.
    if (this.#persist && state === undefined) throw new Error('C2 recovery needs durable state import')
    if (state !== undefined && !validState(state)) throw new TypeError('invalid C2 recovery state')
    this.#reset()
    if (state !== undefined) this.#committed = structuredClone(state)
    this.#pending = null
    this.#blocked = false
    return this.snapshot()
  }

  recoverFromJournal(journal) {
    if (!this.#journal || !journal || typeof journal.snapshot !== 'function' ||
        typeof journal.hasEvent !== 'function' || typeof journal.appendTransition !== 'function') {
      throw new TypeError('durable C2 journal required')
    }
    const durable = journal.snapshot()
    if (!validState(durable.state) || durable.state.version !== 2 ||
        durable.cursor !== durable.state.seq) throw new TypeError('invalid durable C2 state')
    this.#reset()
    this.#journal = journal
    this.#committed = structuredClone(durable.state)
    this.#pending = null
    this.#blocked = false
    return this.snapshot()
  }
}

function validState(state) {
  if (!state || typeof state !== 'object' || Array.isArray(state) ||
      ![1, 2].includes(state.version) || !Number.isSafeInteger(state.seq) || state.seq < 0 ||
      !state.lanes || typeof state.lanes !== 'object' || Array.isArray(state.lanes)) return false
  if (state.version === 2) return Object.keys(state).every(key =>
    ['version', 'seq', 'lanes', 'lastEventId'].includes(key)) &&
    (state.seq === 0 ? state.lastEventId === undefined :
      typeof state.lastEventId === 'string' && !!state.lastEventId &&
      Buffer.byteLength(state.lastEventId) <= 256)
  if (state.seq === 0 && state.committedEventIds === undefined && state.lastEventId === undefined) return true
  const ids = state.committedEventIds
  if (!ids || typeof ids !== 'object' || Array.isArray(ids) ||
      Object.keys(ids).length !== state.seq || Object.keys(ids).length > 100_000 ||
      Object.entries(ids).some(([id, value]) => value !== true || !id || Buffer.byteLength(id) > 256)) return false
  if (state.seq === 0) return state.lastEventId === undefined
  if (typeof state.lastEventId !== 'string' || !state.lastEventId ||
      Buffer.byteLength(state.lastEventId) > 256 || !Object.hasOwn(ids, state.lastEventId)) return false
  return true
}

function validResult(result, priorSeq, id, domain, scope) {
  if (!result || typeof result !== 'object' || Array.isArray(result) ||
      !validState(result.state) || result.state.seq !== priorSeq + 1 ||
      result.cursor !== result.state.seq || result.eventId !== id ||
      (result.state.lastEventId !== undefined && result.state.lastEventId !== id) ||
      (result.state.committedEventIds !== undefined && !Object.hasOwn(result.state.committedEventIds, id)) ||
      !Array.isArray(result.effects) ||
      (result.effectDescriptors !== undefined &&
        (!Array.isArray(result.effectDescriptors) ||
          result.effectDescriptors.length !== result.effects.length ||
          result.effectDescriptors.some((descriptor, index) =>
            !descriptor || typeof descriptor !== 'object' || Array.isArray(descriptor) ||
            descriptor.effectId !== result.effects[index]?.effectId ||
            descriptor.type !== result.effects[index]?.type ||
            descriptor.domain !== domain || descriptor.scope !== scope))) ||
      !result.decision ||
      typeof result.decision !== 'object' || Array.isArray(result.decision)) return false
  return result.effects.every((effect, index) => effect && typeof effect === 'object' &&
    !Array.isArray(effect) && typeof effect.type === 'string' && !!effect.type &&
    effect.effectId === `sbot-c2-effect-v1:${Buffer.byteLength(id)}:${id}:${index}`)
}

module.exports = { EngineStepCoordinator }
