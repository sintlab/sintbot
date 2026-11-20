'use strict'
// Scheduled tasks on disk: the task definitions and the fire ledger.
//
// Both live under the service data directory, in `schedules/`, never in the
// configuration file (a release without scheduled tasks refuses a group that
// carries the old `crons` key, and ignores this directory):
//
//   tasks.json    { "version": 1, "tasks": [ task, … ] }, replaced atomically
//   ledger.jsonl  one JSON object per line, appended and fsynced
//
// The ledger is what makes a due occurrence fire at most once:
//
//   {"v":1,"t":"claim","task":"…","occ":<epoch minute>,"at":<ms>,"decision":"fire"|"skip","reason":<string|null>}
//   {"v":1,"t":"result","task":"…","occ":<epoch minute>,"at":<ms>,"status":"ok"|"failed"|"unknown"|"skipped","reason":<string|null>,"detail":<string|null>}
//   {"v":1,"t":"floor","task":"…","occ":<epoch minute>}
//
// A claim is on disk before anything is posted or started. A claim without a
// result is an occurrence whose effect was interrupted: after a restart it
// reads as "unknown" and stays claimed, so it is never fired again. `floor`
// stands for older claims dropped when the ledger was shortened: every
// occurrence at or below it counts as claimed.
//
// Nothing here decides whether a task fires; the core does (schedule_step).
// A store that cannot be read or written stops scheduled tasks only: `fault`
// says why, every write refuses, and the rest of the service is unaffected.
const fs = require('node:fs')
const path = require('node:path')
const { randomBytes } = require('node:crypto')
const { withFileLock } = require('./core/store')

const DIRECTORY = 'schedules'
const TASKS_FILE = 'tasks.json'
const LEDGER_FILE = 'ledger.jsonl'
const VERSION = 1
const KINDS = Object.freeze(['model', 'script', 'say'])
const STATUSES = Object.freeze(['ok', 'failed', 'unknown', 'skipped'])
const LIMITS = Object.freeze({
  tasks: 20,            // tasks in one conversation
  name: 60,             // characters
  text: 4000,           // characters: the prompt, the command or the message
  timeoutMin: 720,      // a script's longest timeout, minutes
  total: 640,           // tasks in one installation (32 conversations of 20)
  ledgerPerTask: 50,    // occurrences remembered for one task
  ledgerLines: 4000,    // the ledger is rewritten shorter beyond this
  reason: 64, detail: 400,
})
const TASK_ID = /^[0-9a-f]{12}$/
const MAX_MINUTE = 1_000_000_000

class ScheduleStoreError extends Error {
  constructor(code, message) {
    super(message || code)
    this.name = 'ScheduleStoreError'
    this.code = code
  }
}

const isMinute = value => Number.isSafeInteger(value) && value >= 0 && value <= MAX_MINUTE
const isTime = value => Number.isSafeInteger(value) && value >= 0
const textOrNull = (value, max) => value === null || typeof value === 'string' && value.length <= max

// The stored shape of a task, checked the same way when it is written and
// when it is read back. Whether the schedule itself parses is the caller's
// business (it has the parser and the clock).
function assertTask(task) {
  const fail = why => { throw new ScheduleStoreError('invalid-task', `scheduled task is malformed: ${why}`) }
  if (!task || typeof task !== 'object' || Array.isArray(task)) fail('not an object')
  const allowed = ['id', 'chatId', 'name', 'kind', 'expr', 'at', 'tz', 'text', 'enabled', 'once',
    'timeoutMin', 'createdAt', 'updatedAt', 'since', 'retired']
  for (const key of Object.keys(task)) if (!allowed.includes(key)) fail(`unknown key ${key}`)
  if (typeof task.id !== 'string' || !TASK_ID.test(task.id)) fail('id')
  if (typeof task.chatId !== 'string' || !task.chatId || task.chatId.length > 200) fail('chatId')
  if (typeof task.name !== 'string' || !task.name.trim() || task.name.length > LIMITS.name || /[\r\n]/.test(task.name)) fail('name')
  if (!KINDS.includes(task.kind)) fail('kind')
  const hasExpr = typeof task.expr === 'string' && !!task.expr
  const hasAt = typeof task.at === 'string' && !!task.at
  if (hasExpr === hasAt || task.expr !== undefined && !hasExpr || task.at !== undefined && !hasAt) fail('exactly one of expr and at')
  if (task.tz !== undefined && (typeof task.tz !== 'string' || !task.tz || task.tz.length > 64)) fail('tz')
  if (typeof task.text !== 'string' || !task.text.trim() || task.text.length > LIMITS.text) fail('text')
  if (typeof task.enabled !== 'boolean' || typeof task.once !== 'boolean' || task.once !== hasAt) fail('enabled / once')
  if (task.timeoutMin !== undefined && (task.kind !== 'script' || !Number.isSafeInteger(task.timeoutMin) ||
      task.timeoutMin < 1 || task.timeoutMin > LIMITS.timeoutMin)) fail('timeoutMin')
  if (!isTime(task.createdAt) || !isTime(task.updatedAt) || !isTime(task.since)) fail('times')
  if (task.retired !== undefined && (task.retired !== true || task.enabled !== false || !task.once)) fail('retired')
  return task
}

function ownedRegular(file) {
  let stat
  try { stat = fs.lstatSync(file) } catch (error) { if (error.code === 'ENOENT') return false; throw error }
  if (!stat.isFile() || stat.isSymbolicLink() ||
      typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
    throw new Error(`${path.basename(file)} is not an owned regular file`)
  }
  return true
}

function fsyncDirectory(dir) {
  let fd
  try { fd = fs.openSync(dir, 'r'); fs.fsyncSync(fd) } catch { /* not every file system syncs a directory */ }
  finally { if (fd !== undefined) fs.closeSync(fd) }
}

// Replace a file in one step: a reader sees the old contents or the new ones.
function writeAtomic(file, contents) {
  const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
  let fd
  try {
    fd = fs.openSync(tmp, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL, 0o600)
    fs.writeFileSync(fd, contents)
    fs.fsyncSync(fd)
    fs.closeSync(fd); fd = undefined
    fs.renameSync(tmp, file)
    fsyncDirectory(path.dirname(file))
  } catch (error) {
    if (fd !== undefined) { try { fs.closeSync(fd) } catch {} }
    try { fs.unlinkSync(tmp) } catch {}
    throw error
  }
}

function createScheduleStore({ stateDir, canWrite = () => true, log = () => {}, limits = {} } = {}) {
  if (typeof stateDir !== 'string' || !path.isAbsolute(stateDir) || typeof canWrite !== 'function' || typeof log !== 'function') {
    throw new TypeError('schedule store needs the installation data directory and explicit hooks')
  }
  const bounds = { ...LIMITS, ...limits }
  const dir = path.join(stateDir, DIRECTORY)
  const tasksFile = path.join(dir, TASKS_FILE)
  const ledgerFile = path.join(dir, LEDGER_FILE)
  let fault = 'scheduled task store is not open'
  let opened = false
  let tasks = new Map()      // id -> task (frozen)
  let ledger = new Map()     // task id -> Map(occ -> entry), oldest first
  let floors = new Map()     // task id -> highest occurrence dropped from the ledger
  let lines = 0
  let needsSeparator = false

  const failClosed = (why, error) => {
    fault = `${why}: ${error?.message || String(error)}`
    log(`scheduled tasks stopped: ${fault}`)
  }
  const writable = () => {
    if (fault) throw new ScheduleStoreError('unavailable', fault)
    let held = false
    try { held = canWrite() === true } catch {}
    if (!held) throw new ScheduleStoreError('not-writer', 'this process does not hold the service writer lock')
  }

  function readTasks() {
    const next = new Map()
    if (!ownedRegular(tasksFile)) return next
    const parsed = JSON.parse(fs.readFileSync(tasksFile, 'utf8'))
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.version !== VERSION ||
        !Array.isArray(parsed.tasks) || Object.keys(parsed).some(key => !['version', 'tasks'].includes(key))) {
      throw new Error('tasks.json has an unknown shape or version')
    }
    if (parsed.tasks.length > bounds.total) throw new Error('tasks.json holds more tasks than this release keeps')
    for (const task of parsed.tasks) {
      assertTask(task)
      if (next.has(task.id)) throw new Error('tasks.json repeats a task id')
      next.set(task.id, Object.freeze({ ...task }))
    }
    return next
  }

  function applyLine(entries, lows, item) {
    if (!item || typeof item !== 'object' || item.v !== VERSION || typeof item.task !== 'string' ||
        !TASK_ID.test(item.task) || !isMinute(item.occ)) throw new Error('ledger line is malformed')
    if (item.t === 'floor') {
      lows.set(item.task, Math.max(lows.get(item.task) ?? -1, item.occ))
      return
    }
    let own = entries.get(item.task)
    if (item.t === 'claim') {
      if (!isTime(item.at) || !['fire', 'skip'].includes(item.decision) || !textOrNull(item.reason, bounds.reason)) {
        throw new Error('ledger claim is malformed')
      }
      if (!own) entries.set(item.task, own = new Map())
      // The first claim of an occurrence is the one that counts.
      if (!own.has(item.occ)) own.set(item.occ, { occ: item.occ, at: item.at, decision: item.decision, reason: item.reason, result: null })
      return
    }
    if (item.t === 'result') {
      if (!isTime(item.at) || !STATUSES.includes(item.status) || !textOrNull(item.reason, bounds.reason) ||
          !textOrNull(item.detail, bounds.detail)) throw new Error('ledger result is malformed')
      const entry = own?.get(item.occ)
      if (!entry) throw new Error('ledger result has no claim')
      if (!entry.result) entry.result = { status: item.status, reason: item.reason, detail: item.detail, at: item.at }
      return
    }
    throw new Error('ledger line has an unknown type')
  }

  function readLedger() {
    const entries = new Map(), lows = new Map()
    let count = 0, torn = false
    if (ownedRegular(ledgerFile)) {
      const contents = fs.readFileSync(ledgerFile, 'utf8')
      const parts = contents.split('\n')
      const tail = parts.pop()
      for (const line of parts) {
        if (!line) continue
        applyLine(entries, lows, JSON.parse(line))
        count++
      }
      // Only the last line can be cut short by a crash. A cut claim was never
      // followed by its effect; a cut result leaves its claim, read as unknown.
      if (tail) {
        try { applyLine(entries, lows, JSON.parse(tail)); count++ } catch { /* dropped below */ }
        torn = true
      }
    }
    return { entries, lows, count, torn }
  }

  // Entries of the previous process that never got a result: interrupted.
  const interrupted = new Set()

  // Forget the earliest occurrences beyond what one task keeps. Never one
  // whose claim is still open in this process (a script can outlast many
  // later occurrences; its result must still find its claim), and by time,
  // not by when it was written: an occurrence recorded while the clock was
  // ahead must not become a floor above the present.
  const isOpen = (taskId, entry) => !entry.result && entry.decision === 'fire' && !interrupted.has(`${taskId}:${entry.occ}`)
  function trim(taskId) {
    const own = ledger.get(taskId)
    if (!own || own.size <= bounds.ledgerPerTask) return
    const closed = [...own.values()].filter(entry => !isOpen(taskId, entry)).map(entry => entry.occ).sort((a, b) => a - b)
    for (const occ of closed) {
      if (own.size <= bounds.ledgerPerTask) break
      own.delete(occ)
      floors.set(taskId, Math.max(floors.get(taskId) ?? -1, occ))
    }
  }

  function ledgerText() {
    const out = []
    for (const [taskId, floor] of floors) {
      if (tasks.has(taskId)) out.push(JSON.stringify({ v: VERSION, t: 'floor', task: taskId, occ: floor }))
    }
    for (const [taskId, own] of ledger) {
      if (!tasks.has(taskId)) continue
      for (const entry of own.values()) {
        out.push(JSON.stringify({ v: VERSION, t: 'claim', task: taskId, occ: entry.occ, at: entry.at,
          decision: entry.decision, reason: entry.reason }))
        if (entry.result) {
          out.push(JSON.stringify({ v: VERSION, t: 'result', task: taskId, occ: entry.occ, at: entry.result.at,
            status: entry.result.status, reason: entry.result.reason, detail: entry.result.detail }))
        }
      }
    }
    return out
  }

  // Rewrite the ledger with what is still remembered: the last occurrences of
  // the tasks that exist, and a floor for what was dropped.
  function compact() {
    for (const taskId of [...ledger.keys()]) {
      if (!tasks.has(taskId)) { ledger.delete(taskId); floors.delete(taskId) } else trim(taskId)
    }
    for (const taskId of [...floors.keys()]) if (!tasks.has(taskId)) floors.delete(taskId)
    const out = ledgerText()
    writeAtomic(ledgerFile, out.length ? out.join('\n') + '\n' : '')
    lines = out.length
    needsSeparator = false
  }

  function append(items) {
    writable()
    const text = (needsSeparator ? '\n' : '') + items.map(item => JSON.stringify(item) + '\n').join('')
    let fd
    try {
      ownedRegular(ledgerFile)
      fd = fs.openSync(ledgerFile, fs.constants.O_WRONLY | fs.constants.O_APPEND | fs.constants.O_CREAT |
        (fs.constants.O_NOFOLLOW || 0), 0o600)
      const bytes = Buffer.from(text)
      let offset = 0
      while (offset < bytes.length) {
        const written = fs.writeSync(fd, bytes, offset, bytes.length - offset)
        if (written <= 0) throw new Error('ledger write made no progress')
        offset += written
      }
      fs.fsyncSync(fd)
      needsSeparator = false
      lines += items.length
    } catch (error) {
      // A partial line may be on disk and this occurrence has no proven
      // claim: nothing fires until the store is opened again.
      failClosed('ledger write failed', error)
      throw new ScheduleStoreError('unavailable', fault)
    } finally { if (fd !== undefined) { try { fs.closeSync(fd) } catch {} } }
  }

  function saveTasks(next) {
    writable()
    withFileLock(tasksFile, () => {
      writeAtomic(tasksFile, JSON.stringify({ version: VERSION, tasks: [...next.values()] }, null, 2) + '\n')
    })
    tasks = next
  }

  // Read both files. Returns true when scheduled tasks can run. Creates the
  // directory (0700) when missing; never repairs a file it cannot read.
  function open() {
    opened = true
    try {
      let held = false
      try { held = canWrite() === true } catch {}
      if (!held) throw new Error('this process does not hold the service writer lock')
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
      const stat = fs.lstatSync(dir)
      if (!stat.isDirectory() || stat.isSymbolicLink() ||
          typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        throw new Error('schedules is not an owned directory')
      }
      if ((stat.mode & 0o077) !== 0) fs.chmodSync(dir, 0o700)
      for (const file of [tasksFile, ledgerFile]) {
        if (ownedRegular(file) && (fs.lstatSync(file).mode & 0o077) !== 0) fs.chmodSync(file, 0o600)
      }
      const nextTasks = readTasks()
      const read = readLedger()
      tasks = nextTasks
      ledger = read.entries
      floors = read.lows
      lines = read.count
      // Whatever the previous process claimed and never finished is interrupted.
      interrupted.clear()
      for (const [taskId, own] of ledger) {
        if (!tasks.has(taskId)) continue
        for (const entry of own.values()) if (!entry.result && entry.decision === 'fire') interrupted.add(`${taskId}:${entry.occ}`)
      }
      // Lines of a task that no longer exists wait on disk for the next rewrite.
      for (const taskId of [...ledger.keys()]) { if (tasks.has(taskId)) trim(taskId); else ledger.delete(taskId) }
      for (const taskId of [...floors.keys()]) if (!tasks.has(taskId)) floors.delete(taskId)
      for (const key of [...interrupted]) { const [taskId, occ] = key.split(':'); if (!ledger.get(taskId)?.has(Number(occ))) interrupted.delete(key) }
      fault = null
      const kept = [...ledger.values()].reduce((sum, own) => sum + own.size, 0)
      if (read.torn || lines > bounds.ledgerLines || lines > 2 * (kept * 2 + floors.size) + 64) compact()
      return true
    } catch (error) {
      tasks = new Map(); ledger = new Map(); floors = new Map()
      failClosed('store unreadable', error)
      return false
    }
  }

  const entryOf = (taskId, occ) => ledger.get(taskId)?.get(occ) || null
  // What the list shows for one entry: its result, or why there is none yet.
  function resultOf(taskId, entry) {
    if (entry.result) return { occurrence: entry.occ, ...entry.result }
    if (entry.decision === 'skip') return { occurrence: entry.occ, status: 'skipped', reason: entry.reason, detail: null, at: entry.at }
    if (interrupted.has(`${taskId}:${entry.occ}`)) {
      return { occurrence: entry.occ, status: 'unknown', reason: 'interrupted', detail: null, at: entry.at }
    }
    return null // claimed in this process, still running
  }

  return {
    dir, limits: bounds,
    get fault() { return opened ? fault : 'scheduled task store is not open' },
    open,
    tasks: () => [...tasks.values()],
    get: id => tasks.get(id) || null,

    add(task) {
      assertTask(task)
      if (tasks.has(task.id)) throw new ScheduleStoreError('invalid-task', 'task id already exists')
      if (tasks.size >= bounds.total) throw new ScheduleStoreError('limit', 'too many scheduled tasks in this installation')
      const next = new Map(tasks)
      next.set(task.id, Object.freeze({ ...task }))
      saveTasks(next)
      return next.get(task.id)
    },
    replace(task) {
      assertTask(task)
      if (!tasks.has(task.id)) throw new ScheduleStoreError('no-task', 'no such scheduled task')
      const next = new Map(tasks)
      next.set(task.id, Object.freeze({ ...task }))
      saveTasks(next)
      return next.get(task.id)
    },
    remove(id) {
      if (!tasks.has(id)) throw new ScheduleStoreError('no-task', 'no such scheduled task')
      const next = new Map(tasks)
      next.delete(id)
      saveTasks(next)
      ledger.delete(id); floors.delete(id)
    },

    // Is (task, occurrence) in the ledger? Also true at or below the floor.
    claimed(taskId, occ) {
      return !!entryOf(taskId, occ) || (floors.get(taskId) ?? -1) >= occ
    },
    // The newest occurrence the ledger knows for a task at or before `upto`
    // (one recorded while the clock was ahead is not counted), or null.
    latestOccurrence(taskId, upto = Infinity) {
      const floor = floors.get(taskId)
      let latest = floor === undefined ? null : Math.min(floor, upto)
      for (const occ of ledger.get(taskId)?.keys() || []) if (occ <= upto && (latest === null || occ > latest)) latest = occ
      return latest
    },
    // Write the claim and fsync it. Throws when it is not proven on disk; the
    // caller then does nothing for this occurrence.
    claim(taskId, occ, { decision, reason = null, at }) {
      if (!tasks.has(taskId) || !isMinute(occ) || !['fire', 'skip'].includes(decision) || !isTime(at) ||
          !textOrNull(reason, bounds.reason)) throw new ScheduleStoreError('invalid-claim', 'schedule claim is malformed')
      if (this.claimed(taskId, occ)) throw new ScheduleStoreError('claimed', 'this occurrence is already in the ledger')
      append([{ v: VERSION, t: 'claim', task: taskId, occ, at, decision, reason }])
      let own = ledger.get(taskId)
      if (!own) ledger.set(taskId, own = new Map())
      own.set(occ, { occ, at, decision, reason, result: null })
    },
    // Write how a claimed occurrence ended. One result per claim.
    settle(taskId, occ, { status, reason = null, detail = null, at }) {
      const entry = entryOf(taskId, occ)
      if (!entry || entry.result || !STATUSES.includes(status) || !isTime(at)) {
        throw new ScheduleStoreError('invalid-result', 'schedule result has no open claim')
      }
      const clean = (value, max) => value === null || value === undefined ? null : String(value).slice(0, max)
      const result = { status, reason: clean(reason, bounds.reason), detail: clean(detail, bounds.detail), at }
      append([{ v: VERSION, t: 'result', task: taskId, occ, at, status, reason: result.reason, detail: result.detail }])
      entry.result = result
      trim(taskId)
      if (lines > bounds.ledgerLines) {
        try { compact() } catch (error) { failClosed('ledger rewrite failed', error) }
      }
    },
    // The newest finished (or interrupted) occurrence of a task, for the list.
    last(taskId) {
      const own = ledger.get(taskId)
      if (!own) return null
      let best = null
      for (const entry of own.values()) {
        const result = resultOf(taskId, entry)
        if (result && (!best || result.occurrence > best.occurrence)) best = result
      }
      return best
    },
    // Claims of this process that have no result yet.
    running(taskId) {
      for (const entry of ledger.get(taskId)?.values() || []) {
        if (isOpen(taskId, entry)) return true
      }
      return false
    },
    interrupted: () => [...interrupted],
    ledgerLines: () => lines,
  }
}

const newTaskId = () => randomBytes(6).toString('hex')

module.exports = { createScheduleStore, assertTask, newTaskId, ScheduleStoreError, LIMITS, KINDS, STATUSES,
  DIRECTORY, TASKS_FILE, LEDGER_FILE }
