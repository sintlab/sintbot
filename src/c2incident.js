'use strict'

// Operator tool for a group the service holds after an unresolved fault.
// With the service stopped and the writer lock held, it moves that group's
// journal unchanged under <data>/incidents/, records the source messages it
// left unsettled and the receipts it had settled, then gives the group a new
// empty journal under the same mapped name. Nothing is settled, rewritten,
// replayed or notified; every later start refuses those messages from
// incident.json (see loadC2IncidentQuarantine).
const fs = require('node:fs')
const path = require('node:path')
const { createHash } = require('node:crypto')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { assertJournalScope, assertPrivateDirectory, VALIDATORS } = require('./c2install')

const GROUP_ID = /^(?:oc_|wr)[A-Za-z0-9_-]{1,124}$/
const { validIncidentSourceId } = require('./core/c2sourcequarantine')
const SCHEMA = 'sbot-c2-incident-seal-v1'

const sha256 = file => createHash('sha256').update(fs.readFileSync(file)).digest('hex')
function privateFile(file, label) {
  const st = fs.lstatSync(file)
  if (!st.isFile() || st.isSymbolicLink() ||
      typeof process.getuid === 'function' && st.uid !== process.getuid() ||
      process.platform !== 'win32' && (st.mode & 0o077)) {
    throw new Error(`${label} is not a private regular file owned by this user; preserve it and review`)
  }
  return st
}
function writeNew(file, value) {
  const fd = fs.openSync(file, 'wx', 0o600)
  try { fs.writeSync(fd, JSON.stringify(value, null, 2) + '\n'); fs.fsyncSync(fd) }
  finally { fs.closeSync(fd) }
}
function fsyncDir(dir) {
  const fd = fs.openSync(dir, 'r')
  try { fs.fsyncSync(fd) } finally { fs.closeSync(fd) }
}
const pad = n => String(n).padStart(2, '0')
function stamp(ms) {
  const d = new Date(ms)
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`
}

function sealC2GroupIncident({ installation, chatId, reason = 'operator sealed a held group',
  now = Date.now, acquireLock = require('./core/instancelock').acquire, version = '' } = {}) {
  if (typeof chatId !== 'string' || !GROUP_ID.test(chatId)) {
    throw new Error('Name the held group with --group oc_…')
  }
  if (typeof reason !== 'string' || !reason.trim() || reason.length > 500) {
    throw new Error('The incident reason must be 1 to 500 characters')
  }
  const { stateDir, routes } = installation || {}
  const route = routes?.find(item => item.chatId === chatId)
  if (!route) throw new Error('This group is not in the configuration')
  if ((installation.addedRoutes || []).some(item => item.chatId === chatId)) {
    throw new Error('This group has no journal yet; nothing to seal')
  }
  assertPrivateDirectory(stateDir)
  const lockFile = path.join(stateDir, 'daemon.lock')
  const lock = acquireLock(lockFile)
  if (!lock?.ok) throw new Error('The service is running; stop it before sealing an incident')
  const held = () => {
    try { return fs.readFileSync(lockFile, 'utf8').trim() === String(process.pid) } catch { return false }
  }
  try {
    const file = route.file
    const stat = privateFile(file, 'The group journal')
    const before = { sha256: sha256(file), bytes: stat.size }
    let journal
    try { journal = C2DurableJournal.open(file, VALIDATORS) } catch (error) {
      throw new Error(`The group journal cannot be read (${error.message}); preserve it unchanged and review it manually`)
    }
    const snapshot = assertJournalScope(journal, chatId)
    let settled = true
    try { assertJournalScope(journal, chatId, { requireSettled: true }) } catch { settled = false }
    if (settled) throw new Error('This group journal is settled; nothing to seal. Start the service normally')
    if (sha256(file) !== before.sha256) {
      throw new Error('Opening the group journal changed it; preserve every file for review')
    }
    const pending = snapshot.receipts.pending
    if (pending.some(item => item.source !== 'message' || !validIncidentSourceId(chatId, item.sourceId))) {
      throw new Error('The journal holds a receipt that is not a Feishu message; review it manually')
    }
    const incidents = path.join(stateDir, 'incidents')
    fs.mkdirSync(incidents, { recursive: true, mode: 0o700 })
    fs.chmodSync(incidents, 0o700)
    const sealedAt = now()
    const dir = path.join(incidents, `${stamp(sealedAt)}-group-${chatId.slice(-8)}`)
    fs.mkdirSync(dir, { mode: 0o700 })
    writeNew(path.join(dir, 'incident.json'), { schema: SCHEMA, chatId,
      journal: path.basename(file), sha256: before.sha256, bytes: before.bytes,
      cursor: snapshot.cursor,
      pending: pending.map(item => ({ id: item.id, sourceId: item.sourceId })),
      completedReceiptIds: snapshot.receipts.completed.map(item => item.id),
      sealedAt, reason: reason.trim(),
      handling: 'frozen unchanged; receipts not settled; turn not replayed; source messages refused at admission from incident.json',
      tool: 'sintbot incident seal', version })
    if (!held()) throw new Error('The writer lock was lost before sealing; preserve every file for review')
    const sealed = path.join(dir, path.basename(file))
    fs.renameSync(file, sealed)
    fsyncDir(stateDir); fsyncDir(dir)
    if (sha256(sealed) !== before.sha256 || fs.existsSync(file)) {
      throw new Error('The sealed journal differs; preserve every file for review')
    }
    if (!held()) throw new Error('The writer lock was lost before the new journal; preserve every file for review')
    C2DurableJournal.initialize(file, { state: { version: 2, seq: 0, lanes: {} },
      receipts: { pending: [], completed: [] } }, VALIDATORS)
    fs.chmodSync(file, 0o600)
    const fresh = C2DurableJournal.open(file, VALIDATORS)
    const empty = assertJournalScope(fresh, chatId, { requireSettled: true })
    if (fresh.blocked || empty.cursor !== 0 || empty.eventCount !== 0 ||
        empty.receipts.pending.length || empty.receipts.completed.length ||
        empty.effects.size || empty.notices.size || Object.keys(empty.state.lanes).length) {
      throw new Error('New group journal verification failed; preserve every file for review')
    }
    const result = Object.freeze({ incident: dir, sealed, sealedSha256: before.sha256,
      newJournal: file, newJournalSha256: sha256(file),
      refusedSources: pending.length, settledRemembered: snapshot.receipts.completed.length })
    writeNew(path.join(dir, 'result.json'), result)
    return result
  } finally { lock.release() }
}

module.exports = { sealC2GroupIncident }
