'use strict'
// Slack: what was said in a thread since the bot last replied there
// (contract I2, 2026-11-22).
//
// In a channel the bot only hears messages that mention it, so a mention
// inside an existing thread would reach the model without the talk around
// it. Before such a message is handed over, the thread is read once
// (conversations.replies, at most two pages, three seconds in all; any
// failure means no context) and the messages the bot did not hear are
// attached to it as `threadContext: [{ createTimeMs, senderName, text }]`.
// The wording the model reads is the built-in core's; this module only
// selects the messages.
//
// Which messages:
//   - before the trigger only (it and anything after it are excluded);
//   - after the bot's own last message in the thread; when the bot has not
//     posted there, from the thread's first message on (inclusive);
//   - the bot's progress message (src/slackprogress.js) is not a reply: the
//     model read nothing when it was posted. It neither sets that point nor
//     appears in the context. The bot's other messages (answers, notices)
//     set it and never appear either;
//   - not messages that mention the bot (each is a turn of its own), not
//     system subtypes (joins, leaves, topic changes, deletions…);
//   - other apps' messages count as people's, under their app's name;
//   - the newest 30, at most 6000 characters of text in all (the oldest go
//     first); one message is cut at 2000 characters.
// When Slack does not return the trigger itself, the thread was not read to
// its end and no context is given.

const { isProgressMessage } = require('./slackprogress')

const PAGE_LIMIT = 200
const MAX_PAGES = 2
const TIMEOUT_MS = 3000
const MAX_MESSAGES = 30
const MAX_CHARS = 6000
const MAX_MESSAGE_CHARS = 2000
// What a person wrote, as Slack marks it: a plain message, one with files, a
// thread reply also sent to the channel, a /me line, and a classic app's post.
const SPOKEN = new Set(['file_share', 'thread_broadcast', 'me_message', 'bot_message'])

// A Slack ts as whole microseconds (exact: well under 2^53), NaN when it is not one.
const tsNum = (ts) => {
  const m = /^(\d{1,12})\.(\d{1,9})$/.exec(String(ts))
  return m ? Number(m[1]) * 1e6 + Number((m[2] + '000000').slice(0, 6)) : NaN
}
const cut = (text, max) => (text.length > max ? text.slice(0, max - 1) + '…' : text)

// File names, the way an inbound file is named to the model when it cannot be saved.
function fileMarks(files) {
  return (Array.isArray(files) ? files : []).filter((file) => file && typeof file === 'object').map((file) => {
    const label = String(file.mimetype || '').startsWith('image/') ? '图片' : '文件'
    const name = String(file.name || file.title || '').replace(/[\r\n\]]+/g, ' ').slice(0, 80).trim()
    return `[${label}${name ? ' ' + name : ''}]`
  })
}

const mentions = (message, botUserId) => !!botUserId && String(message.text || '').includes(`<@${botUserId}>`)
const ownMessage = (message, botUserId) => !!botUserId && message.user === botUserId

/**
 * The messages of a thread (as read from Slack) that go into the context,
 * oldest first, still in Slack's shape. Pure.
 * `complete`: the whole thread up to the trigger was read. When it was not
 * and the bot's last reply is not among what was read, that reply may be in
 * the part not read: the thread's first message is then left out (it would
 * be older than that reply), the rest read is newer than it either way.
 */
function selectThreadMessages(messages, { triggerTs, threadTs = '', botUserId = '', complete = true } = {}) {
  const trigger = tsNum(triggerTs)
  if (!Number.isFinite(trigger)) return []
  const byTs = new Map()
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || typeof message !== 'object' || typeof message.ts !== 'string') continue
    if (!Number.isFinite(tsNum(message.ts)) || tsNum(message.ts) >= trigger) continue
    byTs.set(message.ts, message)
  }
  const ordered = [...byTs.values()].sort((a, b) => tsNum(a.ts) - tsNum(b.ts))
  let start = -1
  for (let i = ordered.length - 1; i >= 0; i--) {
    if (ownMessage(ordered[i], botUserId) && !isProgressMessage(ordered[i])) { start = i + 1; break }
  }
  const window = start >= 0 ? ordered.slice(start)
    : complete ? ordered : ordered.filter((message) => message.ts !== threadTs)
  return window.filter((message) => {
    if (message.subtype && !SPOKEN.has(message.subtype)) return false
    if (ownMessage(message, botUserId)) return false
    if (mentions(message, botUserId)) return false
    return true
  })
}

// Whether the bot's own last reply (not a progress message) is among these.
const anchored = (messages, botUserId) => messages.some((m) => m && ownMessage(m, botUserId) && !isProgressMessage(m))

/**
 * The context entries for the selected messages: newest 30, ≤ 6000
 * characters, oldest first. `nameOf(message)` gives a sender name or null.
 */
function contextEntries(selected, { parseText = (text) => String(text || '').trim(), botUserId = '', nameOf = () => null } = {}) {
  const entries = []
  for (const message of selected) {
    const body = parseText(message.text || '', { botUserId })
    const text = cut([body, ...fileMarks(message.files)].filter(Boolean).join('\n'), MAX_MESSAGE_CHARS)
    if (!text.trim()) continue
    const createTimeMs = Math.round(tsNum(message.ts) / 1000)
    const fallback = (message.bot_profile && message.bot_profile.name) || message.username || message.user || message.bot_id || 'user'
    entries.push({ createTimeMs, senderName: String(nameOf(message) || fallback), text })
  }
  const kept = []
  let chars = 0
  for (let i = entries.length - 1; i >= 0 && kept.length < MAX_MESSAGES; i--) {
    if (chars + entries[i].text.length > MAX_CHARS) break
    chars += entries[i].text.length
    kept.unshift(entries[i])
  }
  return kept
}

const TIMED_OUT = Symbol('timed out')
// The value of `work`, or TIMED_OUT after `ms`; the timer never outlives the race.
async function within(work, ms) {
  let timer = null
  try {
    return await Promise.race([work, new Promise((resolve) => { timer = setTimeout(() => resolve(TIMED_OUT), Math.max(0, ms)) })])
  } finally { clearTimeout(timer) }
}

/**
 * Reads the thread and returns the context entries; [] on any failure.
 * @param {object} o
 *   call        the adapter's Web API helper
 *   channel     Slack channel id; threadTs: the thread; triggerTs: the message being handed over
 *   botUserId   the bot's own user id
 *   nameOf      async (userId) => name | null (the adapter's cached lookup)
 *   parseText   the adapter's inbound text expansion
 *   onError     (code) => void, for the log
 */
async function fetchThreadContext({ call, channel, threadTs, triggerTs, botUserId = '', nameOf = async () => null,
  parseText, timeoutMs = TIMEOUT_MS, now = Date.now, onError = () => {} } = {}) {
  if (typeof call !== 'function' || !channel || !threadTs || !triggerTs || threadTs === triggerTs) return []
  const deadline = now() + timeoutMs
  const left = () => deadline - now()
  try {
    const messages = []
    let cursor = ''
    let more = false
    for (let page = 0; page < MAX_PAGES; page++) {
      // Up to the trigger, inclusive: whatever order Slack pages in, seeing
      // the trigger proves the read reached the thread's end.
      const reply = await within(call('conversations.replies', { channel, ts: threadTs, latest: triggerTs, inclusive: true,
        limit: PAGE_LIMIT, ...(cursor ? { cursor } : {}) }, { retries: 0 }), left())
      if (reply === TIMED_OUT) { onError('timeout'); return [] }
      if (reply && Array.isArray(reply.messages)) messages.push(...reply.messages)
      cursor = (reply && reply.response_metadata && reply.response_metadata.next_cursor) || ''
      more = !!(reply && reply.has_more) || !!cursor
      if (!cursor || left() <= 0) break
      // Slack pages from the newest back. Once the trigger and the bot's last
      // reply are both in hand, or more messages than are kept, an older page
      // changes nothing.
      if (messages.some((m) => m && m.ts === triggerTs) && (anchored(messages, botUserId) ||
        selectThreadMessages(messages, { triggerTs, threadTs, botUserId, complete: false }).length >= MAX_MESSAGES)) break
    }
    if (!messages.some((message) => message && message.ts === triggerTs)) { onError('incomplete'); return [] }
    const selected = selectThreadMessages(messages, { triggerTs, threadTs, botUserId, complete: !more })
    if (!selected.length) return []
    // Sender names: the adapter's cache, looked up together within what is left of the time.
    const users = [...new Set(selected.filter((m) => !m.bot_id && typeof m.user === 'string').map((m) => m.user))]
    const names = new Map()
    if (users.length) {
      await within(Promise.all(users.map((user) => Promise.resolve().then(() => nameOf(user))
        .then((name) => { if (name) names.set(user, name) }, () => {}))), Math.min(left(), 1500))
    }
    return contextEntries(selected, { parseText, botUserId, nameOf: (message) => (message.bot_id ? null : names.get(message.user) || null) })
  } catch (error) {
    onError((error && error.code) || (error && error.message) || 'error')
    return []
  }
}

module.exports = { fetchThreadContext, selectThreadMessages, contextEntries, MAX_MESSAGES, MAX_CHARS, MAX_MESSAGE_CHARS, PAGE_LIMIT }
