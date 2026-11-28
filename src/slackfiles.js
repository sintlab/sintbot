'use strict'
// Files sent into a Slack conversation, and its recent messages read back, for
// the agent's Slack tools (src/slacktools.js). The adapter (src/platform/slack.js)
// hands in its own Web API call, fetch and name lookup, so every request here
// reaches Slack the way its other requests do: through the service's proxy when
// it has one, file bytes to files.slack.com included.
//
// A file is uploaded in three steps (files.getUploadURLExternal, the bytes to
// the address it returns, files.completeUploadExternal). Only the last one is
// visible in the conversation, and it is sent once: a timeout or a 5xx there is
// reported as unconfirmed, never sent again. A failure before it means nothing
// was shared.
//
// History is returned as structured entries; formatHistory writes the lines the
// agent reads, `[YYYY-MM-DD HH:MM sender] text`, in the service's time zone.
// Nothing is filtered by turn: the message that started the current turn is in
// the output like any other (usually the last line). The agent already has it,
// and leaving it in keeps the order exactly as Slack shows it without needing
// the trigger's id here. What is left out: join/leave notices and the bot's own
// progress message (a plan block), which says nothing about the conversation.
const { getProxyFetch } = require('./core/proxy')
const { fmtStamp } = require('./core/time')
const { parseText } = require('./platform/slack')

// Resolved per request, never at load: the proxy is applied to the environment
// after the configuration loads (same as the adapter's own requests).
const netFetch = (...args) => (getProxyFetch() || fetch)(...args)

const SLACK_TS = /^\d{1,12}\.\d{1,9}$/
const MAX_UPLOAD_BYTES = 50 * 1024 * 1024
const HISTORY = { fallback: 20, max: 100 }
const THREAD = { fallback: 50, max: 200 }
const THREAD_PAGES = 10
const ENTRY_CHARS = 2000
const OUTPUT_CHARS = 60_000
// System notices that are not part of the conversation.
const SKIP_SUBTYPES = new Set(['channel_join', 'channel_leave', 'group_join', 'group_leave', 'bot_add', 'bot_remove',
  'channel_archive', 'channel_unarchive', 'group_archive', 'group_unarchive'])
// A failure of the visible step that does not say whether Slack shared the file.
const UNCONFIRMED = new Set(['request_timeout', 'service_unavailable', 'invalid_response', 'internal_error', 'fatal_error'])

const uploadTimeoutMs = bytes => 60_000 + Math.ceil(bytes / (256 * 1024)) * 1000
const codeOf = e => (e && e.code) || 'unknown_error'

// Model-facing sentences. The agent reads them in its own task, so they say
// what happened and whether trying again makes sense.
function reasonOf(e, { reading = false } = {}) {
  const code = codeOf(e)
  const needed = e && e.payload && e.payload.needed
  if (code === 'not_in_channel' || code === 'channel_not_found') return '机器人不在这个频道，或看不到这个私聊'
  if (code === 'missing_scope') return `应用缺少 ${needed || (reading ? '读取历史' : 'files:write')} 权限，需要管理员在 Slack 应用设置里补上并重装应用`
  if (code === 'thread_not_found' || code === 'invalid_thread_ts') return '找不到当前线程，可能已被删除'
  if (code === 'ratelimited' || code === 'rate_limited') return 'Slack 限流，过一会儿再试'
  if (code === 'request_timeout') return '连不上 Slack，检查网络或代理'
  if (code === 'is_archived') return '这个频道已归档'
  return ''
}
function notSent(e) {
  const reason = reasonOf(e)
  return new Error(`文件没有发出（${codeOf(e)}${reason ? '：' + reason : ''}）`)
}
function unconfirmed(e) {
  return new Error(`发送结果未确认，请勿自动重试（${codeOf(e)}）`)
}
function readFailed(e) {
  const reason = reasonOf(e, { reading: true })
  return new Error(`读取 Slack 历史失败（${codeOf(e)}${reason ? '：' + reason : ''}）`)
}

const count = (value, { fallback, max }) => {
  const n = Number(value)
  return Number.isInteger(n) && n > 0 ? Math.min(n, max) : fallback
}
const cleanName = filename => String(filename || '').replace(/[\r\n\t]+/g, ' ').trim().slice(0, 255) || 'file'

// ── Rendering a message ─────────────────────────────────────────────────────
// A person's message is read from `text`. A bot's message is read from its
// blocks when they render: its `text` is only the short push line (the bot's
// own answers are a markdown block, which Slack stores as rich_text).
function inline(elements, names) {
  let out = ''
  for (const el of Array.isArray(elements) ? elements : []) {
    if (!el || typeof el !== 'object') continue
    if (el.type === 'text') out += el.style && el.style.code ? '`' + (el.text || '') + '`' : (el.text || '')
    else if (el.type === 'link') out += el.text && el.text !== el.url ? `[${el.text}](${el.url})` : (el.url || '')
    else if (el.type === 'user') out += '@' + (names.get(el.user_id) || el.user_id || '')
    else if (el.type === 'channel') out += '#' + (el.channel_id || '')
    else if (el.type === 'usergroup') out += '@group'
    else if (el.type === 'broadcast') out += '@' + (el.range || 'here')
    else if (el.type === 'emoji') out += el.unicode ? safeEmoji(el.unicode) : `:${el.name || ''}:`
    else if (el.type === 'date') out += el.fallback || ''
    else if (typeof el.text === 'string') out += el.text
  }
  return out
}
function safeEmoji(unicode) {
  try { return String(unicode).split('-').map(hex => String.fromCodePoint(parseInt(hex, 16))).join('') } catch { return '' }
}
function richText(block, names) {
  const parts = []
  for (const el of Array.isArray(block.elements) ? block.elements : []) {
    if (!el || typeof el !== 'object') continue
    if (el.type === 'rich_text_section') parts.push(inline(el.elements, names))
    else if (el.type === 'rich_text_preformatted') parts.push('```\n' + inline(el.elements, names) + '\n```')
    else if (el.type === 'rich_text_quote') parts.push(inline(el.elements, names).split('\n').map(line => '> ' + line).join('\n'))
    else if (el.type === 'rich_text_list') {
      const pad = '  '.repeat(Math.max(0, Math.min(8, Number(el.indent) || 0)))
      const start = Number(el.offset) || 0
      parts.push((Array.isArray(el.elements) ? el.elements : []).map((item, i) =>
        pad + (el.style === 'ordered' ? `${start + i + 1}. ` : '• ') + inline(item && item.elements, names)).join('\n'))
    }
  }
  return parts.join('\n')
}
function blocksText(blocks, names) {
  const parts = []
  for (const block of Array.isArray(blocks) ? blocks : []) {
    if (!block || typeof block !== 'object') continue
    if (block.type === 'rich_text') parts.push(richText(block, names))
    else if (block.type === 'markdown' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'header' || block.type === 'section') {
      if (block.text && typeof block.text.text === 'string') parts.push(block.text.text)
      for (const field of Array.isArray(block.fields) ? block.fields : []) if (field && typeof field.text === 'string') parts.push(field.text)
    } else if (block.type === 'context') {
      parts.push((Array.isArray(block.elements) ? block.elements : []).map(el => (el && typeof el.text === 'string' ? el.text : '')).filter(Boolean).join(' '))
    } else if (block.type === 'table' && Array.isArray(block.rows)) {
      parts.push(block.rows.map(row => (Array.isArray(row) ? row : []).map(cell => cell && cell.type === 'rich_text' ? richText(cell, names)
        : cell && typeof cell.text === 'string' ? cell.text : '').join(' | ')).join('\n'))
    }
  }
  return parts.filter(part => part && part.trim()).join('\n').trim()
}
function blockUsers(blocks, ids) {
  const walk = node => {
    if (Array.isArray(node)) { for (const item of node) walk(item); return }
    if (!node || typeof node !== 'object') return
    if (node.type === 'user' && typeof node.user_id === 'string') ids.add(node.user_id)
    if (node.elements) walk(node.elements)
    if (node.rows) walk(node.rows)
  }
  walk(blocks)
}
// The bot's own progress messages: plan blocks, or the plain-line fallback
// that keeps the same block id prefix.
const { isProgressMessage } = require('./slackprogress')
const hasPlan = blocks => Array.isArray(blocks) && blocks.some(block => block && block.type === 'plan')
const isProgress = m => hasPlan(m.blocks) || isProgressMessage(m)
const MENTION = /<@([UW][A-Z0-9]+)(?:\|[^>]*)?>/g

function createSlackFiles({ call, fetchImpl = null, nameOf = async () => null, selfId = () => '', log = () => {} } = {}) {
  if (typeof call !== 'function') throw new TypeError('Slack files need the adapter\'s Web API call')
  const doFetch = (...args) => (fetchImpl || netFetch)(...args)
  const self = () => { try { return selfId() || '' } catch { return '' } }

  // Shares one file in a conversation (in `thread` when given). Resolves to
  // the file id once Slack confirms the share; throws otherwise. A well-formed
  // `thread` that Slack does not know (its first message deleted) is not
  // refused: Slack shares the file at the top of the channel instead (seen
  // live 2026-11-22). Raw bytes in the POST body are accepted by the upload
  // address, through the proxy as well.
  async function upload(channel, buffer, { filename, thread = null } = {}) {
    if (typeof channel !== 'string' || !channel) throw new Error('Slack 会话不可用')
    const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer || [])
    if (bytes.length < 1 || bytes.length > MAX_UPLOAD_BYTES) throw new Error('文件必须在 1 字节至 50 MiB 之间')
    if (thread != null && (typeof thread !== 'string' || !SLACK_TS.test(thread))) throw new Error('线程标识格式不对')
    const name = cleanName(filename)
    let target
    try { target = await call('files.getUploadURLExternal', { filename: name, length: bytes.length }, { retries: 1 }) } catch (e) { throw notSent(e) }
    let url = null
    try { url = new URL(target && target.upload_url) } catch {}
    if (!url || url.protocol !== 'https:' || typeof target.file_id !== 'string' || !target.file_id) throw notSent({ code: 'invalid_response' })
    // The bytes go to the address Slack gave, which carries its own
    // authorization; the token is not sent there.
    let res
    try {
      res = await doFetch(url.href, { method: 'POST', headers: { 'Content-Type': 'application/octet-stream' },
        body: bytes, signal: AbortSignal.timeout(uploadTimeoutMs(bytes.length)) })
    } catch (e) {
      log(`slack 文件上传未完成: ${(e && e.message) || e}`)
      throw notSent({ code: 'upload_failed' })
    }
    const status = Number(res && res.status)
    try { if (res && typeof res.text === 'function') await res.text() } catch {}
    if (!(status >= 200 && status < 300)) throw notSent({ code: `upload_http_${status || 0}` })
    let done
    try {
      done = await call('files.completeUploadExternal', { files: [{ id: target.file_id, title: name }], channel_id: channel,
        ...(thread ? { thread_ts: thread } : {}) }, { retries: 0, retry429: 1 })
    } catch (e) {
      log(`slack files.completeUploadExternal 失败: ${codeOf(e)}`)
      throw UNCONFIRMED.has(codeOf(e)) ? unconfirmed(e) : notSent(e)
    }
    const files = Array.isArray(done && done.files) ? done.files : []
    if (!files.some(file => file && file.id === target.file_id)) throw unconfirmed({ code: 'no_confirmation' })
    return target.file_id
  }

  async function namesFor(messages) {
    const ids = new Set()
    const me = self()
    for (const m of messages) {
      if (typeof m.user === 'string' && m.user) ids.add(m.user)
      for (const hit of String(m.text || '').matchAll(MENTION)) ids.add(hit[1])
      blockUsers(m.blocks, ids)
    }
    if (me) ids.add(me)
    const names = new Map()
    const queue = [...ids]
    const worker = async () => {
      while (queue.length) {
        const id = queue.shift()
        let name = null
        try { name = await nameOf(id) } catch {}
        if (typeof name === 'string' && name.trim()) names.set(id, name.replace(/[[\]\r\n]+/g, ' ').trim())
      }
    }
    await Promise.all(Array.from({ length: Math.min(5, queue.length) }, worker))
    return names
  }

  function entryOf(m, names, { inThread }) {
    const me = self()
    const own = !!me && m.user === me
    const sender = own ? (names.get(me) ? `${names.get(me)}（你）` : '你')
      : m.user ? (names.get(m.user) || m.user)
        : String((m.bot_profile && m.bot_profile.name) || m.username || m.bot_id || 'unknown').replace(/[[\]\r\n]+/g, ' ')
    let text
    if (m.subtype === 'tombstone') text = '（这条消息已删除）'
    else {
      const fromBlocks = m.bot_id || !m.text ? blocksText(m.blocks, names) : ''
      text = fromBlocks || parseText(String(m.text || '').replace(MENTION, (all, id) => names.has(id) ? `<@${id}|${names.get(id)}>` : all))
    }
    const files = (Array.isArray(m.files) ? m.files : []).filter(file => file && typeof file === 'object').map(file => {
      if (file.mode === 'tombstone') return '[文件已删除]'
      const name = String(file.name || file.title || '').replace(/[\r\n\]]+/g, ' ').slice(0, 120)
      return `[${String(file.mimetype || '').startsWith('image/') ? '图片' : '文件'}${name ? ' ' + name : ''}]`
    })
    const replies = !inThread && m.thread_ts === m.ts && Number(m.reply_count) > 0 ? Number(m.reply_count) : 0
    return { ts: m.ts, timeMs: Math.round(parseFloat(m.ts) * 1000), sender, own, text, files, replies }
  }
  const visible = m => m && typeof m.ts === 'string' && SLACK_TS.test(m.ts) && !SKIP_SUBTYPES.has(m.subtype)
    && !(self() && m.user === self() && isProgress(m))

  // The conversation's latest messages, oldest first.
  async function readChannel(channel, limit) {
    const n = count(limit, HISTORY)
    const kept = []
    let cursor = '', more = false
    for (let page = 0; page < 3 && kept.length < n; page++) {
      let r
      try { r = await call('conversations.history', { channel, limit: Math.min(200, n + 10), ...(cursor ? { cursor } : {}) }, { retries: 1 }) } catch (e) { throw readFailed(e) }
      for (const m of Array.isArray(r && r.messages) ? r.messages : []) if (visible(m)) kept.push(m)
      cursor = (r && r.response_metadata && r.response_metadata.next_cursor) || ''
      more = !!(r && r.has_more)
      if (!more || !cursor) break
    }
    const chosen = kept.slice(0, n).reverse()
    const names = await namesFor(chosen)
    return { thread: null, messages: chosen.map(m => entryOf(m, names, { inThread: false })), omitted: 0, more: more || kept.length > n }
  }
  // One thread: its first message, then its latest replies.
  async function readThread(channel, thread, limit) {
    if (typeof thread !== 'string' || !SLACK_TS.test(thread)) throw new Error('线程标识格式不对')
    const n = count(limit, THREAD)
    const seen = new Map()
    let cursor = '', truncated = false
    for (let page = 0; page < THREAD_PAGES; page++) {
      let r
      try { r = await call('conversations.replies', { channel, ts: thread, limit: 200, ...(cursor ? { cursor } : {}) }, { retries: 1 }) } catch (e) { throw readFailed(e) }
      // Each page may repeat the first message; ts identifies a message.
      for (const m of Array.isArray(r && r.messages) ? r.messages : []) if (visible(m) && !seen.has(m.ts)) seen.set(m.ts, m)
      cursor = (r && r.response_metadata && r.response_metadata.next_cursor) || ''
      if (!(r && r.has_more) || !cursor) break
      if (page === THREAD_PAGES - 1) truncated = true
    }
    const all = [...seen.values()].sort((a, b) => parseFloat(a.ts) - parseFloat(b.ts))
    let chosen = all, omitted = 0
    if (all.length > n) {
      const head = all[0] && all[0].ts === thread ? [all[0]] : []
      chosen = [...head, ...all.slice(-(n - head.length))]
      omitted = all.length - chosen.length
    }
    const names = await namesFor(chosen)
    return { thread, messages: chosen.map(m => entryOf(m, names, { inThread: true })), omitted, more: false, truncated }
  }

  async function read(channel, { thread = null, limit } = {}) {
    if (typeof channel !== 'string' || !channel) throw new Error('Slack 会话不可用')
    return thread ? readThread(channel, thread, limit) : readChannel(channel, limit)
  }

  return { upload, read }
}

// The lines the agent reads. A message's later lines are indented, so every
// message starts its own `[` line. Long messages are cut, and when the whole
// is too long the oldest go first (a thread keeps its first message).
function formatHistory(result, { tz } = {}) {
  const r = result && typeof result === 'object' ? result : {}
  const entries = Array.isArray(r.messages) ? r.messages : []
  const inThread = !!r.thread
  if (!entries.length) return inThread ? '（这个线程里还没有发言）' : '（还没有发言）'
  const lines = entries.map(e => {
    let body = [e.text, ...(Array.isArray(e.files) ? e.files : [])].filter(Boolean).join(' ')
    if (e.replies) body += `（线程里 ${e.replies} 条回复）`
    if (body.length > ENTRY_CHARS) body = body.slice(0, ENTRY_CHARS) + '…（后文省略）'
    return `[${fmtStamp(Number(e.timeMs) || 0, tz)} ${e.sender}] ${body.split('\n').join('\n  ')}`
  })
  let omitted = Number(r.omitted) || 0
  let more = !!r.more
  const keep = inThread ? 1 : 0
  let total = lines.reduce((sum, line) => sum + line.length + 1, 0)
  while (total > OUTPUT_CHARS && lines.length > keep + 1) {
    total -= lines.splice(keep, 1)[0].length + 1
    if (inThread) omitted += 1; else more = true
  }
  if (inThread) {
    if (omitted) lines.splice(1, 0, `  …（中间省略 ${omitted} 条）`)
    if (r.truncated) lines.push('（线程太长，更新的发言没有读到）')
  } else if (more) lines.unshift('（更早的发言没有列出）')
  return lines.join('\n')
}

module.exports = { createSlackFiles, formatHistory, blocksText, MAX_UPLOAD_BYTES, HISTORY_LIMITS: { history: HISTORY, thread: THREAD } }
