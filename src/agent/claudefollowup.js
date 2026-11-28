'use strict'

// Transport adapter only: the binary decides readiness, landing and segment boundaries.
const { randomUUID } = require('node:crypto')
const { claudeFollowupStep } = require('./privatecore')

function createClaudeFollowup({ write, end, onReady, onLanded, onFailure,
  receiptTimeoutMs = 10000, holdMs = 20000 } = {}) {
  let state = null, disposed = false, holdTimer = null, sessionId = null
  const firstId = randomUUID()
  const pending = new Map(), messages = new Map()
  const step = event => { const result = claudeFollowupStep(state, event); state = result.state; return result }
  const clearHold = () => { clearTimeout(holdTimer); holdTimer = null }
  const settle = (id, error) => {
    const waiter = pending.get(id)
    if (!waiter) return
    pending.delete(id); clearTimeout(waiter.timer)
    if (error) waiter.reject(error); else waiter.resolve(true)
  }
  const dispose = () => {
    disposed = true; clearHold()
    for (const id of pending.keys()) settle(id, new Error('Follow-up closed before receipt'))
  }
  const fail = error => { if (disposed) return; dispose(); onFailure(error) }
  const control = {
    steerDurable({ msgId, text } = {}) {
      if (disposed) return Promise.resolve(false)
      if (typeof msgId !== 'string' || !msgId || typeof text !== 'string' || !text || text.length > 200000) {
        return Promise.resolve(false)
      }
      if ([...messages.values()].includes(msgId)) return Promise.reject(new Error('Duplicate follow-up message'))
      const id = randomUUID()
      const decision = step({ type: 'write', id })
      if (decision.action === 'reject') return Promise.resolve(false)
      messages.set(id, msgId)
      const promise = new Promise((resolve, reject) => {
        const timer = setTimeout(() => fail(new Error('Follow-up receipt timed out; delivery unknown')), receiptTimeoutMs)
        pending.set(id, { resolve, reject, timer })
      })
      // Register identity and waiter before writing: a receipt may arrive immediately.
      try { write({ type: 'user', uuid: id, message: { role: 'user', content: text } }) }
      catch (error) { fail(error) }
      return promise
    },
  }
  return {
    start(prompt) { write({ type: 'user', uuid: firstId, message: { role: 'user', content: prompt } }) },
    protocol(raw) {
      if (raw.type === 'control_response') return true
      if (raw.type !== 'command_lifecycle') return false
      if (raw.command_uuid === firstId) return true
      if (sessionId && raw.session_id && raw.session_id !== sessionId) throw new Error('Follow-up session mismatch')
      if (disposed) return true
      const decision = step({ type: 'lifecycle', id: raw.command_uuid, status: raw.state })
      if (decision.accepted) settle(raw.command_uuid)
      if (decision.landed) { clearHold(); onLanded?.(messages.get(raw.command_uuid)) }
      return true
    },
    init(raw) {
      if (sessionId) {
        if (raw.session_id !== sessionId) throw new Error('Follow-up init session changed')
        return 'none'
      }
      sessionId = raw.session_id
      const decision = step({ type: 'init', capabilities: raw.capabilities })
      if (decision.action === 'ready') onReady?.(control)
      else end()
      return decision.action
    },
    result(event) {
      const decision = step({ type: 'result', usage: event.usage, isError: event.isError })
      clearHold()
      if (decision.action === 'continue') {
        holdTimer = setTimeout(() => fail(new Error('Follow-up landing timed out; replay forbidden')), holdMs)
        return { ...event, type: 'turn_continue', usage: decision.usage }
      }
      end()
      return { ...event, usage: { ...event.usage, ...decision.usage } }
    },
    stop() {
      if (!disposed) step({ type: 'stop' })
      dispose()
      write({ type: 'control_request', request_id: `stop-${randomUUID()}`,
        request: { subtype: 'interrupt', cancel_queued: true } })
      end()
    },
    dispose,
    fail,
  }
}

module.exports = { createClaudeFollowup }
