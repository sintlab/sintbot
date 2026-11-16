'use strict'
// Presence for Slack conversations, driven by the service's live activity.
// The engine already reports each turn's life to the activity recorder for the
// console (received, started, finished). This wraps that recorder and passes
// the same three moments to the Slack adapter, which shows ⏳ / ✅ on the
// person's message and the native "Working…" status in a channel thread.
//
// It is display only: no durable effect, no retry, no influence on admission,
// delivery or settlement. Every call into the adapter is guarded; a failure
// here can never fail the recorder call it rides on.
const { isSlackChatId, isSlackMessageId } = require('./platform/slack')

const LIMIT = 1024

function withSlackPresence(activity, { getAdapter, log = () => {} } = {}) {
  if (!activity || typeof getAdapter !== 'function') return activity
  const sources = new Map()  // chatId \0 receiptId -> source message id
  const running = new Map()  // chatId \0 receiptId -> source message ids of the turn
  const key = (chatId, receiptId) => `${chatId}\0${receiptId}`
  const bound = (map) => { for (const k of map.keys()) { if (map.size <= LIMIT) break; map.delete(k) } }
  const signal = (method, chatId, ids, answered) => {
    if (!ids.length) return
    try { getAdapter()?.presence?.[method]?.(chatId, ids, answered) }
    catch (error) { log(`Slack presence unavailable: ${error?.message || String(error)}`) }
  }
  const wrapped = Object.create(activity)
  wrapped.receive = value => {
    try {
      if (isSlackChatId(value?.chatId) && isSlackMessageId(value?.sourceMessageId) && typeof value.receiptId === 'string') {
        sources.set(key(value.chatId, value.receiptId), value.sourceMessageId); bound(sources)
      }
    } catch {}
    return activity.receive(value)
  }
  wrapped.start = value => {
    try {
      if (isSlackChatId(value?.chatId) && typeof value.receiptId === 'string') {
        const ids = (Array.isArray(value.receiptIds) && value.receiptIds.length ? value.receiptIds : [value.receiptId])
          .map(id => sources.get(key(value.chatId, id))).filter(Boolean)
        running.set(key(value.chatId, value.receiptId), ids); bound(running)
        signal('working', value.chatId, ids)
      }
    } catch {}
    return activity.start(value)
  }
  wrapped.finish = value => {
    try {
      if (isSlackChatId(value?.chatId) && typeof value.receiptId === 'string') {
        const k = key(value.chatId, value.receiptId)
        const ids = running.get(k)
        if (ids) { running.delete(k); signal('done', value.chatId, ids, value.status === 'answered') }
      }
    } catch {}
    return activity.finish(value)
  }
  // A follow-up merged into the running turn: once the model has read it
  // ('landed'), its message gets ⏳ and later the turn's ✅, like the first one.
  // An only-accepted follow-up shows nothing yet: it may still run on its own.
  wrapped.merge = (chatId, parentReceiptId, receiptIds, state) => {
    try {
      if (state === 'landed' && isSlackChatId(chatId) && Array.isArray(receiptIds)) {
        const ids = running.get(key(chatId, parentReceiptId))
        if (ids) {
          const added = receiptIds.map(id => sources.get(key(chatId, id))).filter(id => id && !ids.includes(id))
          if (added.length) { ids.push(...added); signal('working', chatId, added) }
        }
      }
    } catch {}
    return activity.merge(chatId, parentReceiptId, receiptIds, state)
  }
  // A turn whose outcome became unknown: the signals are cleared, without ✅.
  wrapped.unknown = value => {
    try {
      if (isSlackChatId(value?.chatId)) {
        for (const [k, ids] of running) {
          if (!k.startsWith(`${value.chatId}\0`)) continue
          running.delete(k); signal('done', value.chatId, ids, false)
        }
      }
    } catch {}
    return activity.unknown(value)
  }
  return wrapped
}

module.exports = { withSlackPresence }
