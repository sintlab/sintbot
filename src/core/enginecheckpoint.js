'use strict'

// C2 checkpoint contract. This module does not choose Engine transitions or
// send recovery notices. The caller must keep JSON-safe opaque state with
// handles only and job receipts in one committed snapshot, then acknowledge
// intake/effects.
const fs = require('node:fs')
const path = require('node:path')
const { createHash, randomUUID } = require('node:crypto')
const { stepId, batchStepId } = require('./engineeffectcursor')

const VERSION = 3
const LEGACY_VERSION = 1
const COMPLETED_VERSION = 2
const MAX_TRACKED_IDS = 100_000
const RECEIPT_KEYS = new Set(['id', 'chatId', 'source', 'sourceId', 'acceptedAt', 'notifiedAt', 'quiet'])
const COMPLETED_KEYS = new Set(['id', 'settledAt'])
const RESET_KEYS = new Set(['effectId', 'receiptIds', 'chatId', 'turnToken', 'generation', 'phase', 'status'])
const ID = /^[0-9a-f]{32}$/
const RESET_PHASES = new Set(['acked', 'ready'])
const RESET_STATUSES = new Set(['ok', 'no-reply'])

function jsonState(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TypeError('invalid C2 state')
  const stack = new Set()
  function inspect(item) {
    if (item === null || typeof item === 'string' || typeof item === 'boolean') return
    if (typeof item === 'number' && Number.isFinite(item)) return
    if (!item || typeof item !== 'object' || stack.has(item)) throw new TypeError('C2 state must be JSON-safe')
    const prototype = Object.getPrototypeOf(item)
    if (!Array.isArray(item) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError('C2 state must be JSON-safe')
    }
    stack.add(item)
    const keys = Reflect.ownKeys(item)
    if (Array.isArray(item) && keys.filter(key => key !== 'length').length !== item.length) {
      throw new TypeError('C2 state must be JSON-safe')
    }
    for (const key of keys) {
      if (key === 'length' && Array.isArray(item)) continue
      const descriptor = Object.getOwnPropertyDescriptor(item, key)
      if (typeof key !== 'string' || key === '__proto__' || !descriptor?.enumerable || !('value' in descriptor)) {
        throw new TypeError('C2 state must be JSON-safe')
      }
      inspect(descriptor.value)
    }
    stack.delete(item)
  }
  inspect(value)
  return JSON.parse(JSON.stringify(value))
}

function taskId({ source, chatId, sourceId }) {
  for (const value of [source, chatId, sourceId]) {
    if (typeof value !== 'string' || !value) throw new TypeError('stable task ID needs source, chatId and sourceId')
  }
  return createHash('sha256').update('sintbot-c2-job-v1\0').update(source).update('\0')
    .update(chatId).update('\0').update(sourceId).digest('hex').slice(0, 32)
}

// For sources without a platform trigger ID. Persist this value in the intake
// receipt before acknowledging the trigger; it cannot deduplicate a replay
// after a crash that precedes the first durable receipt.
function newSourceId() { return 'local:' + randomUUID() }

function validate(input, { sourceVersion = VERSION, strict = false } = {}) {
  const legacy = sourceVersion === LEGACY_VERSION
  if (!input || typeof input !== 'object' || Array.isArray(input) ||
      (input.version !== undefined && input.version !== sourceVersion) ||
      !Number.isSafeInteger(input.seq) || input.seq < 0 ||
      !input.state || typeof input.state !== 'object' || Array.isArray(input.state) ||
      !Array.isArray(input.pending) ||
      Object.keys(input).some(key => !['version', 'seq', 'state', 'pending',
        ...(legacy ? [] : ['completed']), ...(sourceVersion === VERSION ? ['sessionResets'] : [])].includes(key)) ||
      (legacy ? Object.hasOwn(input, 'completed') :
        (strict && !Object.hasOwn(input, 'completed'))) ||
      (!legacy && input.completed !== undefined && !Array.isArray(input.completed)) ||
      (sourceVersion === VERSION && (strict && !Object.hasOwn(input, 'sessionResets') ||
        input.sessionResets !== undefined && !Array.isArray(input.sessionResets)))) {
    throw new TypeError('invalid C2 checkpoint shape')
  }
  const completed = legacy ? [] : (input.completed || [])
  const sessionResets = sourceVersion === VERSION ? (input.sessionResets || []) : []
  if (input.pending.length + completed.length > MAX_TRACKED_IDS) {
    throw new RangeError('C2 completed ID capacity exceeded')
  }
  if (sessionResets.length > MAX_TRACKED_IDS) throw new RangeError('C2 session reset capacity exceeded')
  const ids = new Set()
  for (const receipt of input.pending) {
    if (!receipt || typeof receipt !== 'object' || Array.isArray(receipt) ||
        Object.keys(receipt).some(key => !RECEIPT_KEYS.has(key)) ||
        typeof receipt.id !== 'string' || !ID.test(receipt.id) ||
        typeof receipt.chatId !== 'string' || !receipt.chatId ||
        typeof receipt.source !== 'string' || !receipt.source ||
        typeof receipt.sourceId !== 'string' || !receipt.sourceId ||
        !Number.isSafeInteger(receipt.acceptedAt) || receipt.acceptedAt <= 0 ||
        typeof receipt.quiet !== 'boolean' ||
        (receipt.notifiedAt !== undefined && (!Number.isSafeInteger(receipt.notifiedAt) || receipt.notifiedAt <= 0)) ||
        taskId(receipt) !== receipt.id || ids.has(receipt.id)) throw new TypeError('invalid C2 receipt')
    ids.add(receipt.id)
  }
  for (const item of completed) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== 2 || Object.keys(item).some(key => !COMPLETED_KEYS.has(key)) ||
        typeof item.id !== 'string' || !ID.test(item.id) ||
        !Number.isSafeInteger(item.settledAt) || item.settledAt <= 0 || ids.has(item.id)) {
      throw new TypeError('invalid C2 completed ID')
    }
    ids.add(item.id)
  }
  const resetIds = new Set(), resetChats = new Set()
  for (const item of sessionResets) {
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).length !== RESET_KEYS.size ||
        Object.keys(item).some(key => !RESET_KEYS.has(key)) ||
        typeof item.effectId !== 'string' || !ID.test(item.effectId) || resetIds.has(item.effectId) ||
        !Array.isArray(item.receiptIds) || item.receiptIds.length < 1 || item.receiptIds.length > 1024 ||
        item.receiptIds.some(id => typeof id !== 'string' || !ID.test(id) || !ids.has(id)) ||
        new Set(item.receiptIds).size !== item.receiptIds.length ||
        item.effectId !== (item.receiptIds.length === 1
          ? stepId(item.receiptIds[0], 0) : batchStepId(item.receiptIds, 0)) ||
        typeof item.chatId !== 'string' || !item.chatId || resetChats.has(item.chatId) ||
        !Number.isSafeInteger(item.turnToken) || item.turnToken <= 0 ||
        typeof item.generation !== 'string' || !ID.test(item.generation) ||
        !RESET_PHASES.has(item.phase) || !RESET_STATUSES.has(item.status)) {
      throw new TypeError('invalid C2 session reset intent')
    }
    resetIds.add(item.effectId)
    resetChats.add(item.chatId)
  }
  return { version: VERSION, seq: input.seq, state: jsonState(input.state),
    pending: input.pending.map(receipt => ({ ...receipt })),
    completed: completed.map(item => ({ id: item.id, settledAt: item.settledAt })),
    sessionResets: sessionResets.map(item => ({ ...item })) }
}

function checksum(body) { return createHash('sha256').update(JSON.stringify(body)).digest('hex') }

function writeCheckpoint(file, input) {
  const body = validate(input)
  const previous = readCheckpoint(file, { allowMissing: true })
  if (!previous && body.seq !== 0) throw new Error('C2 checkpoint must be initialized at sequence zero')
  if (previous && body.seq <= previous.seq) throw new Error('C2 checkpoint sequence must advance')
  const bytes = Buffer.from(JSON.stringify({ body, checksum: checksum(body) }) + '\n')
  const dir = path.dirname(file)
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
  const temp = file + '.' + process.pid + '.' + createHash('sha256').update(String(process.hrtime.bigint())).digest('hex').slice(0, 12) + '.tmp'
  let fd
  try {
    fd = fs.openSync(temp, 'wx', 0o600)
    fs.writeFileSync(fd, bytes)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(temp, file)
    // Directory fsync makes the rename durable on POSIX. Some filesystems and
    // Windows do not support it; the data file is already synced there.
    try {
      const dirFd = fs.openSync(dir, 'r')
      try { fs.fsyncSync(dirFd) } finally { fs.closeSync(dirFd) }
    } catch {}
  } finally {
    if (fd !== undefined) fs.closeSync(fd)
    try { fs.unlinkSync(temp) } catch {}
  }
  return body
}

function readCheckpoint(file, { allowMissing = false } = {}) {
  let bytes
  try { bytes = fs.readFileSync(file, 'utf8') }
  catch (error) {
    if (error.code === 'ENOENT' && allowMissing) return null
    if (error.code === 'ENOENT') throw new Error('C2 checkpoint missing; recovery cannot assume an empty queue')
    throw error
  }
  let envelope
  try { envelope = JSON.parse(bytes) } catch { throw new Error('C2 checkpoint is corrupt') }
  if (!envelope || typeof envelope !== 'object' || !envelope.body ||
      ![LEGACY_VERSION, COMPLETED_VERSION, VERSION].includes(envelope.body.version) ||
      envelope.checksum !== checksum(envelope.body)) {
    throw new Error('C2 checkpoint checksum or version mismatch')
  }
  return validate(envelope.body, { sourceVersion: envelope.body.version, strict: true })
}

function outstanding(checkpoint) {
  return validate(checkpoint).pending.filter(receipt => receipt.notifiedAt === undefined)
}

function markNotified(checkpoint, id, at) {
  const body = validate(checkpoint)
  if (!Number.isSafeInteger(at) || at <= 0) throw new TypeError('notification time required')
  const receipt = body.pending.find(item => item.id === id)
  if (!receipt) throw new Error('unknown C2 task receipt')
  receipt.notifiedAt = at
  body.seq++
  return body
}

function markDone(checkpoint, id, settledAt = Date.now()) {
  const body = validate(checkpoint)
  if (!Number.isSafeInteger(settledAt) || settledAt <= 0) throw new TypeError('settlement time required')
  const index = body.pending.findIndex(item => item.id === id)
  if (index < 0) throw new Error('unknown C2 task receipt')
  body.pending.splice(index, 1)
  body.completed.push({ id, settledAt })
  body.seq++
  return body
}

module.exports = { taskId, newSourceId, writeCheckpoint, readCheckpoint, outstanding, markNotified, markDone, MAX_TRACKED_IDS }
