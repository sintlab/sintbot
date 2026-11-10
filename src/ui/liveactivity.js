'use strict'

// An observational read model, never an execution/recovery authority. All
// terminal labels are supplied by the existing acknowledged engine paths.
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { redact } = require('../core/redact')
const LIMIT = 256, TEXT = 16384, FILE_LIMIT = 12 * 1024 * 1024
const CLOSED = new Set(['answered', 'silent', 'stopped', 'recalled', 'timeout', 'error', 'not-started', 'unknown'])
const clean = (s, n = TEXT) => redact(String(s || ''), { pii: false }).slice(0, n)
const finite = n => Number.isFinite(n) && n >= 0

function createLiveActivity({ file, now = Date.now, log = () => {}, canWrite = () => true } = {}) {
  const epoch = randomUUID(), rows = new Map(), aliases = new Map(), contexts = new Map(), listeners = new Set()
  let revision = 0, timer, saveTimer, saving = Promise.resolve(), writing = false, dirty = false, storageError = false
  const key = (chatId, id) => chatId + ':' + id
  const locate = (chatId, id) => rows.get(aliases.get(key(chatId, id)) || key(chatId, id))
  function changed(urgent = false) {
    revision++; dirty = true
    if (!timer) timer = setTimeout(() => {
      timer = null
      for (const fn of listeners) { try { fn() } catch {} }
    }, urgent ? 0 : 150).unref()
    if (!saveTimer && file) saveTimer = setTimeout(() => { saveTimer = null; void flush() }, 1000).unref()
  }
  function touch(row, urgent = false, details = true) {
    row.updatedAt = now(); row.revision = revision + 1
    if (details) row.detailRevision = row.revision
    changed(urgent)
    while (rows.size > LIMIT) {
      const oldest = [...rows.values()].sort((a, b) => Number(!CLOSED.has(a.status)) - Number(!CLOSED.has(b.status)) || a.updatedAt - b.updatedAt)[0]
      rows.delete(key(oldest.chatId, oldest.id))
      for (const id of oldest.receiptIds) aliases.delete(key(oldest.chatId, id))
    }
  }
  function receive({ chatId, receiptId, text, sender, acceptedAt }) {
    if (locate(chatId, receiptId)) return
    const row = { id: receiptId, chatId, receiptIds: [receiptId], ts: acceptedAt || now(),
      status: 'queued', text: clean(text, 160), sender: clean(sender, 120),
      messages: [{ id: receiptId, text: clean(text), sender: clean(sender, 120), state: 'accepted' }],
      truncated: String(text || '').length > TEXT, reply: '', tools: [], milestones: [] }
    rows.set(key(chatId, receiptId), row); touch(row, true)
  }
  function merge(chatId, parentId, ids, state) {
    const row = locate(chatId, parentId)
    if (!row) return
    for (const id of ids) {
      const child = locate(chatId, id)
      if (child && child !== row) {
        row.messages.push(...child.messages)
        row.receiptIds.push(...child.receiptIds)
        rows.delete(key(chatId, child.id))
      }
      if (!row.receiptIds.includes(id)) row.receiptIds.push(id)
      aliases.set(key(chatId, id), key(chatId, row.id))
      const msg = row.messages.find(m => m.id === id)
      if (msg) msg.state = state
    }
    // Bound the entire message body, not only each message, and disclose loss.
    let budget = TEXT
    if (row.messages.length > 64) row.truncated = true
    row.messages = row.messages.slice(0, 64).map(m => {
      const text = m.text.slice(0, budget); budget -= text.length
      if (text !== m.text) row.truncated = true
      return { ...m, text }
    })
    touch(row, true)
    return row
  }
  function start({ chatId, receiptId, receiptIds, generation, sessionId, model, runner, project }) {
    const row = merge(chatId, receiptId, receiptIds || [receiptId], 'landed')
    if (!row) return
    row.status = 'running'; row.generation = generation
    row.startedAt ||= now(); row.sessionId = sessionId || null
    Object.assign(row, { model: clean(model, 120), runner, project: clean(project, 120) })
    const prior = contexts.get(chatId)
    if (!prior || prior.sessionId !== sessionId) contexts.delete(chatId)
    else contexts.set(chatId, { ...prior, generation, quality: 'previous' })
    touch(row, true)
  }
  function observe({ chatId, receiptId, generation, event, doing, milestones }) {
    const row = locate(chatId, receiptId)
    if (!row || row.generation !== generation || CLOSED.has(row.status)) return
    if (event.sessionId) row.sessionId = event.sessionId
    const compact = event.type === 'system' && event.subtype === 'compact' || event.contextCompacted && !event.contextTokens
    const measured = finite(event.contextTokens) && event.contextSampled !== false
    if (compact || measured) {
      const prior = contexts.get(chatId)
      contexts.set(chatId, { sessionId: row.sessionId, generation,
        usedTokens: compact ? null : event.contextTokens,
        windowTokens: finite(event.contextWindowTokens) && event.contextWindowTokens > 0 ? event.contextWindowTokens : prior?.generation === generation ? prior.windowTokens : null,
        measuredAt: now(), quality: compact ? 'compacted' : 'reported', source: row.runner })
    }
    if (event.tools) {
      for (const tool of event.tools) {
        const name = clean(tool.name, 100), found = row.tools.find(t => t.name === name)
        if (found) found.count++
        else if (row.tools.length < 50) row.tools.push({ name, count: 1 })
      }
    }
    if (doing) row.doing = doing.map(x => clean(x, 160)).slice(-3)
    if (milestones) row.milestones = milestones.map(x => clean(x, 200)).slice(-12)
    // No model text deltas: only user-facing milestones and tool descriptions.
    if (compact || measured || event.tools?.length || milestones)
      touch(row, compact, !!event.tools?.length || !!milestones)
  }
  function finish({ chatId, receiptId, status, reply, err, tokens, sessionId }) {
    const row = locate(chatId, receiptId)
    if (!row || CLOSED.has(row.status)) return
    row.status = status; row.endedAt = now(); row.ms = row.startedAt ? row.endedAt - row.startedAt : 0
    row.reply = clean(reply); row.err = clean(err, 1000); row.tokens = tokens || null
    row.truncated ||= String(reply || '').length > TEXT
    if (sessionId) row.sessionId = sessionId
    const ctx = contexts.get(chatId)
    if (ctx && ctx.generation === row.generation) {
      ctx.sessionId = row.sessionId; ctx.quality = ctx.quality === 'compacted' ? 'compacted' : 'previous'
    }
    touch(row, true)
  }
  function sending({ chatId, receiptId }) {
    const row = locate(chatId, receiptId)
    if (row && !CLOSED.has(row.status)) { row.status = 'sending'; touch(row, true) }
  }
  function unknown({ chatId }) {
    for (const row of rows.values()) if (row.chatId === chatId && !CLOSED.has(row.status)) {
      finish({ chatId, receiptId: row.id, status: 'unknown', err: '结果尚未确认，请查看群状态' })
    }
  }
  const summary = row => {
    const { messages, reply, tools, milestones, receiptIds, generation, sessionId, ...rest } = row
    return { ...rest, preview: (row.err || reply || '').slice(0, 160), messageCount: messages.length,
      kind: CLOSED.has(row.status) ? 'done' : 'start', details: true }
  }
  function list({ chatId, status, offset = 0, limit = 30 } = {}) {
    const all = [...rows.values()].filter(r => (!chatId || r.chatId === chatId) && (!status || r.status === status))
      .sort((a, b) => Number(CLOSED.has(a.status)) - Number(CLOSED.has(b.status)) || b.ts - a.ts)
    offset = Math.max(0, Math.min(LIMIT, Number(offset) || 0)); limit = Math.max(1, Math.min(100, Number(limit) || 30))
    return { epoch, revision, storageError, total: all.length, activity: all.slice(offset, offset + limit).map(summary) }
  }
  function detail(chatId, id) {
    const row = locate(chatId, id)
    return row ? { epoch, revision: row.revision, ...structuredClone(row) } : null
  }
  function context(chatId, sessionId, busy = false, generation = null) {
    const c = contexts.get(chatId)
    if (!c || !(busy && generation && c.generation === generation) && (!sessionId || c.sessionId !== sessionId)) return null
    return { ...c, quality: busy ? c.quality : c.quality === 'reported' ? 'previous' : c.quality }
  }
  function flush() {
    clearTimeout(saveTimer); saveTimer = null
    if (writing) return saving
    if (!file || !dirty || !canWrite()) return saving
    dirty = false
    const data = JSON.stringify({ version: 1, rows: [...rows.values()], contexts: [...contexts] })
    writing = true
    saving = saving.then(async () => {
      if (!canWrite()) return
      if (Buffer.byteLength(data) > FILE_LIMIT) throw new Error('activity size limit')
      await fs.promises.mkdir(path.dirname(file), { recursive: true })
      const tmp = file + '.tmp'
      await fs.promises.writeFile(tmp, data, { mode: 0o600 })
      if (canWrite()) await fs.promises.rename(tmp, file)
      storageError = false
    }).catch(() => { storageError = true; log('Activity history could not be saved') })
      .finally(() => {
        writing = false
        if (dirty && !saveTimer) saveTimer = setTimeout(() => { saveTimer = null; void flush() }, 1000).unref()
      })
    return saving
  }
  if (file) {
    try {
      if (fs.statSync(file).size > FILE_LIMIT) throw new Error('activity size limit')
      const data = JSON.parse(fs.readFileSync(file, 'utf8'))
      if (data.version !== 1 || !Array.isArray(data.rows) || data.rows.length > LIMIT) throw new Error('activity format')
      for (const row of data.rows) {
        if (!row || typeof row.id !== 'string' || typeof row.chatId !== 'string' || !Array.isArray(row.receiptIds) || !Array.isArray(row.messages)) continue
        if (!CLOSED.has(row.status)) { row.status = 'unknown'; row.err = '服务重启，结果需要核实' }
        rows.set(key(row.chatId, row.id), row)
        revision = Math.max(revision, Number(row.revision) || 0)
        for (const id of row.receiptIds) aliases.set(key(row.chatId, id), key(row.chatId, row.id))
      }
      for (const [id, value] of (data.contexts || []).slice(0, 32)) contexts.set(id, { ...value, quality: value.quality === 'compacted' ? 'compacted' : 'historical' })
    } catch (error) { if (error.code !== 'ENOENT') { storageError = true; log('Activity history could not be loaded') } }
  }
  return { receive, start, observe, finish, sending, unknown, merge, list, detail, context, flush,
    has: (chatId, id) => !!locate(chatId, id),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
    async close() { clearTimeout(timer); listeners.clear(); await flush(); await flush(); clearTimeout(saveTimer) } }
}

module.exports = { createLiveActivity }
