'use strict'

// The console's own conversation, shaped like a chat platform. A local
// conversation is a route like any group: its messages enter through the
// service's one ingress, take a durable receipt and are answered by the same
// terminal effect. Only the transport differs: instead of a chat service, the
// transcript is an append-only file in the data directory and the reader is
// the console page.
//
// Identities reuse the two shapes the durable path already validates and can
// never collide with a real chat service ID: `oc_local_<a-z0-9>` for a
// conversation, `om_local_<24 hex>` for a message.
//
// Contract with the durable path:
//   - a user line is on disk (fsynced) before the service sees the message,
//     so the receipt's source ID always names a line the page can show;
//   - replyOnce appends exactly one line per call and reports it in the same
//     shape as a chat service's reply; a failed append throws and is never
//     retried here (the caller's effect stays unknown, as on any platform);
//   - nothing in this file decides whether a message is processed.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomBytes } = require('node:crypto')

const LOCAL_CHAT_ID = /^oc_local_[a-z0-9]{1,48}$/
const LOCAL_MESSAGE_ID = /^om_local_[a-f0-9]{24}$/
const REQUEST_ID = /^[0-9a-f]{32}$/
const DIRECTORY = 'local-chats'
const MAX_INPUT_CHARS = 20_000
const MAX_LINE_BYTES = 2 * 1024 * 1024
const MAX_CACHED = 2_000
const ROLES = new Set(['user', 'assistant', 'notice'])

const isLocalChatId = value => typeof value === 'string' && LOCAL_CHAT_ID.test(value)
const isLocalMessageId = value => typeof value === 'string' && LOCAL_MESSAGE_ID.test(value)
const newLocalChatId = () => `oc_local_${randomBytes(6).toString('hex')}`

class LocalChatError extends Error {
  constructor(reason, message) {
    super(message || reason)
    this.name = 'LocalChatError'
    this.reason = reason
  }
}

function messageIdFor(chatId, requestId) {
  if (requestId === undefined || requestId === null) return `om_local_${randomBytes(12).toString('hex')}`
  if (typeof requestId !== 'string' || !REQUEST_ID.test(requestId)) {
    throw new LocalChatError('request-id', 'local message request key invalid')
  }
  return 'om_local_' + createHash('sha256').update('sintbot-local-message-v1\0')
    .update(chatId).update('\0').update(requestId).digest('hex').slice(0, 24)
}

function createLocalPlatform({ stateDir, onEvent = () => {}, log = () => {}, now = Date.now,
  senderName = '' } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || stateDir !== path.resolve(stateDir) ||
      typeof onEvent !== 'function' || typeof log !== 'function' || typeof now !== 'function') {
    throw new TypeError('local platform needs the installation data directory and explicit hooks')
  }
  const dir = path.join(stateDir, DIRECTORY)
  const cache = new Map() // chatId -> { messages, ids }
  let onMessage = null
  let hooks = {}
  let started = false
  let intakeClosed = false
  let since = 0
  let lastEventAt = 0

  const fileOf = chatId => {
    if (!isLocalChatId(chatId)) throw new LocalChatError('chat-id', 'local conversation identity invalid')
    return path.join(dir, `${chatId}.jsonl`)
  }
  function ownedRegular(file) {
    let stat
    try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
      throw new Error('local conversation transcript is not an owned regular file')
    }
    return true
  }
  function load(chatId) {
    const hit = cache.get(chatId)
    if (hit) return hit
    const file = fileOf(chatId)
    const entry = { messages: [], ids: new Map(), needsSeparator: false }
    if (ownedRegular(file)) {
      const contents = fs.readFileSync(file, 'utf8')
      entry.needsSeparator = contents.length > 0 && !contents.endsWith('\n')
      for (const line of contents.split('\n')) {
        if (!line) continue
        let item
        // A line cut short by a crash is the last one; it never had a receipt.
        try { item = JSON.parse(line) } catch { continue }
        if (!item || !isLocalMessageId(item.id) || !ROLES.has(item.role) ||
            typeof item.text !== 'string' || !Number.isSafeInteger(item.ts)) continue
        entry.ids.set(item.id, item)
        entry.messages.push(item)
      }
      if (entry.messages.length > MAX_CACHED) entry.messages = entry.messages.slice(-MAX_CACHED)
    }
    cache.set(chatId, entry)
    return entry
  }
  function record(chatId, item) {
    const entry = load(chatId)
    const line = JSON.stringify(item) + '\n'
    if (Buffer.byteLength(line) > MAX_LINE_BYTES) throw new LocalChatError('too-long', 'local message is too large to store')
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    const file = fileOf(chatId)
    ownedRegular(file)
    const fd = fs.openSync(file, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
      (fs.constants.O_NOFOLLOW || 0), 0o600)
    try {
      // Preserve a crash fragment but end its line before appending. Otherwise
      // the next valid message joins that fragment and disappears on restart.
      const bytes = Buffer.from((entry.needsSeparator ? '\n' : '') + line)
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error('local transcript write made no progress')
        offset += written
      }
      fs.fsyncSync(fd)
      entry.needsSeparator = false
    } catch (error) {
      entry.needsSeparator = true
      throw error
    } finally { fs.closeSync(fd) }
    entry.ids.set(item.id, item)
    entry.messages.push(item)
    if (entry.messages.length > MAX_CACHED) entry.messages.splice(0, entry.messages.length - MAX_CACHED)
    lastEventAt = item.ts
    try { onEvent({ type: 'message', chatId, message: item }) } catch (error) {
      log('local event listener failed: ' + (error?.message || String(error)))
    }
    return item
  }
  function outbound(chatId, role, text, replyTo) {
    if (typeof text !== 'string' || !text) throw new TypeError('local reply needs text')
    const item = { id: `om_local_${randomBytes(12).toString('hex')}`, role, text, ts: now(),
      ...(isLocalMessageId(replyTo) ? { replyTo } : {}) }
    return record(chatId, item).id
  }
  function closeFatalIntake(error) {
    if (intakeClosed) return
    intakeClosed = true
    if (typeof hooks.onFatal !== 'function') return
    try {
      Promise.resolve(hooks.onFatal(error)).catch(failure =>
        log('local fatal intake hook rejected: ' + (failure?.message || String(failure))))
    } catch (failure) { log('local fatal intake hook threw: ' + (failure?.message || String(failure))) }
  }

  return {
    name: 'local',
    // No cards, no pinned replies, no group tools: each answer is one plain
    // line, which the engine accepts only from a platform that says so.
    features: { plainReplies: true },
    chatLabel: '本机对话',

    async start(handler, startHooks = {}) {
      if (typeof handler !== 'function') throw new TypeError('local platform needs a message handler')
      if (startHooks.onFatal !== undefined && typeof startHooks.onFatal !== 'function') {
        throw new TypeError('local fatal intake hook must be a function')
      }
      onMessage = handler
      hooks = startHooks
      started = true
      intakeClosed = false
      since = now()
    },
    async stop() {
      started = false
      onMessage = null
      return true
    },
    connHealth() {
      return { state: started && !intakeClosed ? 'connected' : 'stopped', since, lastReadyAt: since,
        lastEventAt, reconnects: 0, rebuilds: 0, lastError: null }
    },

    // The durable terminal effect: one line, reported like a chat service reply.
    async replyOnce(replyCtx, content) {
      const messageId = replyCtx?.messageId
      if (!isLocalMessageId(messageId) || !isLocalChatId(replyCtx.chatId) ||
          typeof content !== 'string' || !content) {
        throw new TypeError('durable local reply needs exact message target and text')
      }
      const id = outbound(replyCtx.chatId, 'assistant', content, messageId)
      return { code: 0, data: { message_id: id } }
    },
    async reply(replyCtx, content) {
      if (!isLocalChatId(replyCtx?.chatId) || typeof content !== 'string' || !content) return null
      try { return outbound(replyCtx.chatId, 'assistant', content, replyCtx.messageId) } catch (error) {
        log('local reply failed: ' + (error?.message || String(error)))
        return null
      }
    },
    async send(chatId, content) {
      if (!isLocalChatId(chatId) || typeof content !== 'string' || !content) return null
      try { return outbound(chatId, 'notice', content) } catch (error) {
        log('local send failed: ' + (error?.message || String(error)))
        return null
      }
    },
    // One recovery notice under an accepted message; returns its ID or null.
    notice(chatId, text, replyTo) {
      if (!isLocalChatId(chatId) || !isLocalMessageId(replyTo)) throw new TypeError('local notice needs an exact target')
      try { return outbound(chatId, 'notice', text, replyTo) } catch (error) {
        log('local notice failed: ' + (error?.message || String(error)))
        return null
      }
    },

    // A line typed in the console. It is stored first, then handed to the
    // service ingress exactly like a platform message. `settled` resolves when
    // the service has finished with the message (for an admitted one: when its
    // turn ends). The same request key always maps to the same message.
    submit(chatId, text, { requestId = null, sender = senderName } = {}) {
      if (!isLocalChatId(chatId)) throw new LocalChatError('chat-id', 'local conversation identity invalid')
      if (!started || intakeClosed || typeof onMessage !== 'function') {
        throw new LocalChatError('not-serving', 'local conversation intake is closed')
      }
      if (typeof text !== 'string' || !text.trim()) throw new LocalChatError('empty', 'message is empty')
      if (text.length > MAX_INPUT_CHARS) throw new LocalChatError('too-long', 'message is too long')
      const id = messageIdFor(chatId, requestId)
      const prior = load(chatId).ids.get(id)
      if (prior && (prior.role !== 'user' || prior.text !== text)) {
        throw new LocalChatError('request-id', 'request key was already used for another message')
      }
      const item = prior || record(chatId, { id, role: 'user', text, ts: now(),
        ...(typeof sender === 'string' && sender ? { sender: sender.slice(0, 64) } : {}) })
      const msg = { chatId, userId: 'local', senderName: item.sender || '我', text, msgId: id,
        createTimeMs: item.ts, replyCtx: { chatId, messageId: id } }
      const handler = onMessage
      const settled = Promise.resolve().then(() => handler(msg)).catch(error => {
        log('local onMessage error: ' + (error?.message || String(error)))
        closeFatalIntake(error)
        throw error
      })
      // The caller decides what to await; an unobserved failure is already logged.
      settled.catch(() => {})
      return { id, duplicate: !!prior, settled }
    },

    // Newest `limit` lines in order; `after` (a message ID) returns only what follows it.
    history(chatId, { limit = 200, after = null } = {}) {
      if (!isLocalChatId(chatId)) throw new LocalChatError('chat-id', 'local conversation identity invalid')
      const { messages } = load(chatId)
      const bound = Math.max(1, Math.min(1_000, Number(limit) || 200))
      if (after) {
        const index = messages.findIndex(item => item.id === after)
        if (index >= 0) return messages.slice(index + 1).slice(-bound)
      }
      return messages.slice(-bound)
    },
    has(chatId, messageId) {
      return isLocalChatId(chatId) && load(chatId).ids.has(messageId)
    },
  }
}

module.exports = { createLocalPlatform, isLocalChatId, isLocalMessageId, newLocalChatId,
  LocalChatError, LOCAL_CHAT_ID, LOCAL_MESSAGE_ID }
