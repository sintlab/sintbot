'use strict'

const { BinarySemaphore } = require('./core/engineslotsadapter')
const MAX_CONCURRENT = 32

function cancelled(reason) {
  const error = new Error('The model concurrency wait was cancelled before a permit was delivered')
  error.code = 'C2_CAPACITY_WAIT_CANCELLED'
  if (reason !== undefined) error.cause = reason
  return error
}

// Shared by all per-group Engines. Rust owns capacity and grant order;
// Node retains only Promise/AbortSignal handles. The caller must durably stage
// a receipt before awaiting acquire, and commit dispatch only AFTER acquiring.
// A waiting task is therefore a durable queued receipt, not an attempted model
// effect. This class neither ACKs nor discards a receipt or dispatch.
class C2MultiGroupCapacity {
  #slots
  #records = new Set()
  #closed = false
  #maxConcurrent

  constructor({ maxConcurrent } = {}) {
    if (!Number.isSafeInteger(maxConcurrent) || maxConcurrent < 1 ||
        maxConcurrent > MAX_CONCURRENT) {
      throw new TypeError(`Model concurrency must be an integer from 1 to ${MAX_CONCURRENT}`)
    }
    this.#maxConcurrent = maxConcurrent
    this.#slots = new BinarySemaphore(maxConcurrent)
  }

  snapshot() {
    return Object.freeze({ closed: this.#closed,
      maxConcurrent: this.#maxConcurrent,
      active: [...this.#records].filter(record => record.phase === 'active').length,
      waiting: [...this.#records].filter(record => record.phase === 'waiting').length })
  }

  close(reason) {
    this.#closed = true
    for (const record of this.#records) {
      if (record.phase === 'waiting') record.controller.abort(reason)
    }
    // Already delivered permits remain held until their owners release them
    // after the real runner/turn closes. Shutdown is not proof of closure.
  }

  async acquire({ signal } = {}) {
    if (signal !== undefined && signal !== null &&
        (typeof signal.aborted !== 'boolean' ||
         typeof signal.addEventListener !== 'function' ||
         typeof signal.removeEventListener !== 'function')) {
      throw new TypeError('Model concurrency signal is invalid')
    }
    if (this.#closed || signal?.aborted) throw cancelled(signal?.reason)
    const controller = new AbortController()
    const forwardAbort = () => controller.abort(signal.reason)
    if (signal) signal.addEventListener('abort', forwardAbort, { once: true })
    const record = { controller, phase: 'waiting' }
    this.#records.add(record)
    let acquired = false, released = false
    const detach = () => {
      if (signal) signal.removeEventListener('abort', forwardAbort)
    }
    const release = () => {
      if (released) return
      released = true
      this.#records.delete(record)
      detach()
      if (!acquired) return
      try { this.#slots.release() }
      catch (error) {
        // Never repair a failed binary transition with a JavaScript counter.
        this.close(error)
        throw error
      }
    }
    try {
      try {
        await this.#slots.acquire(controller.signal)
        acquired = true
      } catch (error) {
        if (controller.signal.aborted) throw cancelled(controller.signal.reason)
        this.close(error)
        throw error
      }
      // A release can grant a waiter immediately before shutdown/cancellation.
      // Recheck before delivering a permit and before the caller can dispatch.
      if (this.#closed || controller.signal.aborted) {
        throw cancelled(controller.signal.reason)
      }
      record.phase = 'active'
      detach()
      return release
    } catch (error) {
      release()
      throw error
    }
  }
}

module.exports = { C2MultiGroupCapacity, MAX_CONCURRENT }
