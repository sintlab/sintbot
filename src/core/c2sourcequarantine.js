'use strict'

const FEISHU_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/

// An operator must carry these exact source IDs across every restart of a
// restricted trial. A fresh journal alone cannot recognize messages already
// accepted by different, preserved authorities.
function createC2V2SourceQuarantine(value, { required = false } = {}) {
  if (typeof required !== 'boolean') throw new TypeError('C2 source quarantine mode invalid')
  const raw = Array.isArray(value) ? value : [value]
  if (!raw.length || raw.length > 2 ||
      (raw.length === 2 && (raw[0] === undefined || raw[0] === '') &&
        raw[1] !== undefined && raw[1] !== '')) {
    throw new TypeError('C2 v2 blocked source list invalid')
  }
  const ids = raw.filter(id => id !== undefined && id !== '')
  if (!ids.length) {
    if (required) throw new Error('C2 v2 formal service needs an explicit blocked source message ID')
    return null
  }
  if (ids.some(id => typeof id !== 'string' || !FEISHU_MESSAGE_ID.test(id)) ||
      new Set(ids).size !== ids.length) {
    throw new TypeError('C2 v2 blocked source message ID invalid')
  }
  const sourceIds = Object.freeze([...ids])
  return Object.freeze({ sourceId: sourceIds[0], sourceIds,
    rejects: message => sourceIds.includes(message?.msgId) })
}

// Every sealed incident under <data>/incidents/*/incident.json keeps its
// unsettled source messages out of admission for that group, on every start.
// A seal written by `sintbot incident seal` also lists the receipts its
// journal had already settled, so the group's new journal never runs one of
// those messages again. A malformed seal stops startup: an unreadable fence
// cannot be skipped.
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,124}$/
const RECEIPT_ID = /^[0-9a-f]{32}$/
function loadC2IncidentQuarantine(stateDir, { fs = require('node:fs'), path = require('node:path') } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir)) {
    throw new TypeError('C2 incident quarantine needs the installation directory')
  }
  const root = path.join(stateDir, 'incidents')
  // Loaded here so the source quarantine above stays a standalone module.
  const { taskId } = require('./enginecheckpoint')
  const byChat = new Map()
  const settled = new Map()
  const fail = name => { throw new Error(`Sealed incident record is invalid: ${name}; preserve it and review`) }
  let entries = []
  try { entries = fs.readdirSync(root, { withFileTypes: true }) }
  catch (error) { if (error.code !== 'ENOENT') throw error }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const file = path.join(root, entry.name, 'incident.json')
    let stat
    try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') continue; throw error }
    if (!stat.isFile() || stat.isSymbolicLink() ||
        typeof process.getuid === 'function' && stat.uid !== process.getuid() ||
        process.platform !== 'win32' && (stat.mode & 0o077)) fail(entry.name)
    let record
    try { record = JSON.parse(fs.readFileSync(file, 'utf8')) } catch { fail(entry.name) }
    if (record?.schema !== 'sbot-c2-incident-seal-v1' || !CHAT_ID.test(record.chatId || '') ||
        !Array.isArray(record.pending) ||
        record.pending.some(item => !FEISHU_MESSAGE_ID.test(item?.sourceId || '')) ||
        record.completedReceiptIds !== undefined && (!Array.isArray(record.completedReceiptIds) ||
          record.completedReceiptIds.some(id => typeof id !== 'string' || !RECEIPT_ID.test(id)))) fail(entry.name)
    const ids = byChat.get(record.chatId) || new Set()
    for (const item of record.pending) ids.add(item.sourceId)
    byChat.set(record.chatId, ids)
    if (record.completedReceiptIds?.length) {
      const done = settled.get(record.chatId) || new Set()
      for (const id of record.completedReceiptIds) done.add(id)
      settled.set(record.chatId, done)
    }
  }
  const sourceIds = Object.freeze([...byChat.values()].flatMap(ids => [...ids]))
  const settledBefore = message => {
    const done = settled.get(message?.chatId)
    if (!done || typeof message.msgId !== 'string' || !message.msgId) return false
    return done.has(taskId({ source: 'message', chatId: message.chatId, sourceId: message.msgId }))
  }
  return Object.freeze({ sourceIds,
    rejects: message => !!byChat.get(message?.chatId)?.has(message?.msgId) || settledBefore(message) })
}

module.exports = { createC2V2SourceQuarantine, loadC2IncidentQuarantine }
