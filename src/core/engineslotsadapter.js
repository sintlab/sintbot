'use strict'

const { engineSlotsStep, resetBinaryCore } = require('../agent/privatecore')

// Promise, AbortSignal and waiter handles belong to Node. The binary reducer
// owns capacity, priority and grant order; no callback fires until its complete
// transition has been validated and committed.
class BinarySemaphore {
  constructor(max, step = engineSlotsStep, resetCore = resetBinaryCore) {
    this.state = { max: max > 0 ? max : 0, cur: 0, waiters: [] }
    this.step = step
    this.resetCore = resetCore
    this.handles = new Map()
    this.serial = 0
  }

  get max() { return this.state.max }
  set max(value) { this._transition({ type: 'reload', max: value }) }
  get cur() { return this.state.cur }
  get waiters() { return this.state.waiters.map(waiter => this.handles.get(waiter.id)?.handle).filter(Boolean) }

  _transition(event) {
    let result
    try {
      result = this.step(this.state, event)
      const next = result && result.state
      if (!next || typeof next !== 'object' || Array.isArray(next) ||
          !Number.isSafeInteger(next.cur) || next.cur < 0 || !Array.isArray(next.waiters) ||
          !Array.isArray(result.effects) ||
          (event.type === 'wouldBlock' && typeof result.wouldBlock !== 'boolean')) {
        throw new Error('invalid binary slot transition')
      }
      const ids = new Set()
      for (const waiter of next.waiters) {
        if (!waiter || typeof waiter.id !== 'string' || !waiter.id ||
            !Number.isSafeInteger(waiter.reserve) || waiter.reserve < 0 || ids.has(waiter.id) ||
            (waiter.id !== event.id && !this.handles.has(waiter.id))) {
          throw new Error('invalid binary slot waiter')
        }
        ids.add(waiter.id)
      }
      if (result.effects.length > 1 || result.effects.some(effect =>
        !effect || !['grant', 'reject'].includes(effect.type) || typeof effect.id !== 'string' ||
        (effect.id !== event.id && !this.handles.has(effect.id)))) {
        throw new Error('invalid binary slot effect')
      }
      this.state = next
      return result
    } catch (error) {
      try { this.resetCore(error) } catch { /* preserve the first failure */ }
      throw error
    }
  }

  wouldBlock(reserve = 0) { return this._transition({ type: 'wouldBlock', reserve }).wouldBlock }

  async acquire(signal, reserve = 0, onWait = null) {
    const id = `s${++this.serial}`
    const result = this._transition({ type: 'acquire', id, reserve })
    if (result.effects.some(effect => effect.type === 'grant' && effect.id === id)) return
    return new Promise((resolve, reject) => {
      const record = { resolve, reject, signal, onAbort: null, handle: null }
      const handle = { id,
        get reserve() { return record.reserve },
        set reserve(value) {
          if (value !== 0) throw new TypeError('slot waiter promotion must set reserve to zero')
          if (record.done) { record.reserve = 0; return }
          const changed = record.owner._transition({ type: 'promote', id })
          if (changed.effects.length) throw new Error('slot promotion emitted an effect')
          record.reserve = 0
        } }
      record.owner = this
      record.reserve = reserve
      record.handle = handle
      this.handles.set(id, record)
      if (onWait) onWait(handle)
      const onAbort = () => {
        try {
          const changed = this._transition({ type: 'abort', id })
          if (!changed.effects.some(effect => effect.type === 'reject' && effect.id === id)) return
          record.done = true
          this.handles.delete(id)
          if (signal) signal.removeEventListener('abort', onAbort)
          reject(new Error('aborted while waiting for a concurrency slot'))
        } catch (error) { reject(error) }
      }
      record.onAbort = onAbort
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }
    })
  }

  release() {
    const result = this._transition({ type: 'release' })
    const granted = result.effects.find(effect => effect.type === 'grant')
    if (!granted) return
    const record = this.handles.get(granted.id)
    if (!record) throw new Error('binary slot grant has no host waiter')
    record.done = true
    this.handles.delete(granted.id)
    if (record.signal) record.signal.removeEventListener('abort', record.onAbort)
    record.resolve()
  }
}

module.exports = { BinarySemaphore }
