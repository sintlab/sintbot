'use strict'

const { C2DurableJournal } = require('./c2durablejournal')
const { C2DurableRuntime } = require('./c2durableruntime')

// The daemon supplies its single-writer lock and installs `accept` as its
// ingress callback before calling start(). This opt-in bridge never installs
// a route or starts a service by itself. In particular, journal recovery may
// await a platform notice while the callback remains closed.
function createC2ServiceStartGate({ enabled = false, journal, assertWriterLock,
  resolveTarget, send, now, maxEventCount, maxJournalBytes,
  maxCompletionEvents, maxCompletionBytes, singleNoticePerGroup = false } = {}) {
  if (enabled !== true || !(journal instanceof C2DurableJournal) ||
      typeof assertWriterLock !== 'function' ||
      assertWriterLock.constructor?.name === 'AsyncFunction' ||
      typeof resolveTarget !== 'function' || typeof send !== 'function' ||
      typeof singleNoticePerGroup !== 'boolean') {
    throw new TypeError('C2 service start requires explicit durable authority and writer lock')
  }

  const runtime = new C2DurableRuntime({ journal,
    resolveTarget: (...args) => {
      assertHeld()
      return resolveTarget(...args)
    },
    send: async (...args) => {
      assertHeld()
      const result = await send(...args)
      assertHeld()
      return result
    }, now,
    maxEventCount, maxJournalBytes, maxCompletionEvents, maxCompletionBytes,
    assertWriterLock, singleNoticePerGroup })
  let started = false
  let starting = false

  function assertHeld() {
    if (assertWriterLock() !== true) {
      throw new Error('C2 service writer lock is not held')
    }
  }

  function accept(options) {
    if (!started || starting || runtime.blocked) {
      throw new Error('C2 service ingress is closed')
    }
    try {
      assertHeld()
      return runtime.enqueueMessage(options)
    } catch (error) {
      runtime.close()
      started = false
      throw error
    }
  }

  async function start() {
    if (starting) throw new Error('C2 service startup already in progress')
    if (started) {
      try { assertHeld() } catch (error) {
        stop()
        throw error
      }
      if (runtime.blocked) throw new Error('C2 service authority closed')
      return runtime.snapshot()
    }
    starting = true
    try {
      assertHeld()
      const snapshot = await runtime.open()
      // A lock lost during an awaited notice must not expose the reopened
      // runtime to the platform callback.
      assertHeld()
      if (runtime.blocked) throw new Error('C2 service authority remained closed')
      started = true
      return snapshot
    } catch (error) {
      runtime.close()
      started = false
      throw error
    } finally { starting = false }
  }

  function stop() {
    started = false
    runtime.close()
  }

  return { start, stop, accept,
    get blocked() { return !started || starting || runtime.blocked },
    // An Engine integration may use the authority only after start() proves
    // recovery and the writer lock. It cannot bypass the closed ingress gate.
    get runtime() {
      if (!started || starting || runtime.blocked) return null
      try { assertHeld() } catch (error) {
        stop()
        throw error
      }
      return runtime
    } }
}

module.exports = { createC2ServiceStartGate }
