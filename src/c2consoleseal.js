'use strict'

// Seal a held group from the console. The operator tool (`sintbot incident
// seal`, src/c2incident.js) needs the service stopped and the writer lock
// free, so the console only asks for it. With every other group idle and
// settled, admission closes, the service stops, the same tool seals the group
// once the lock is released, and the process exits cleanly for launchd to
// start it again. Nothing else changes: the tool keeps the journal unchanged
// under incidents/, settles nothing and replays nothing, and the next start
// refuses the sealed sources. Only a launchd job that restarts after a clean
// exit offers this; every other run keeps the terminal steps.
const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteJSON } = require('./core/store')

const RECORD = 'console-seal.json'
const NOT_HELD = '这个群没有处于暂停状态，无需封存'
const BUSY = '其他群还有任务或未结记录，等它们结束后再封存'
const UPGRADING = '正在升级，稍后再封存'
const PENDING = '已在封存，服务正在重启'

// KeepAlive true, or { SuccessfulExit: true } alone: launchd starts the job
// again after the clean exit that follows a seal.
function restartsAfterCleanExit(spec) {
  const keep = spec?.KeepAlive
  if (keep === true) return true
  return !!keep && typeof keep === 'object' && !Array.isArray(keep) &&
    Object.keys(keep).length === 1 && keep.SuccessfulExit === true
}

// Whether this run may seal from the console: decided once at startup.
function consoleSealAvailable({ runMode, readPlist }) {
  if (runMode?.mode !== 'managed' || typeof runMode.plist !== 'string') return false
  try { return restartsAfterCleanExit(readPlist(runMode.plist)) } catch { return false }
}

function createConsoleSeal({ getHeld, gate, upgradeActive, beginMaintenance, endMaintenance,
  requestStop, defer = fn => setImmediate(fn) }) {
  for (const callback of [getHeld, gate, upgradeActive, beginMaintenance, endMaintenance, requestStop, defer]) {
    if (typeof callback !== 'function') throw new TypeError('Console seal needs the service hooks')
  }
  let requested = null
  // Anything but the holds themselves keeps the service running: a running,
  // queued or unsettled group would lose its turn's outcome on the stop.
  const blocked = () => gate().filter(reason => reason !== 'held')
  function request(chatId) {
    if (requested) throw new Error(PENDING)
    if (typeof chatId !== 'string' || !getHeld().has(chatId)) throw new Error(NOT_HELD)
    if (upgradeActive()) throw new Error(UPGRADING)
    if (blocked().length) throw new Error(BUSY)
    beginMaintenance()
    if (blocked().length) { endMaintenance(); throw new Error(BUSY) }
    requested = chatId
    // After the reply has left: the stop closes the console server too.
    defer(() => requestStop(chatId))
    return { ok: true, chatId, restarting: true }
  }
  return { request, get requested() { return requested } }
}

// Runs after the service stopped and released the writer lock. A stop that
// did not prove its platform and runners closed seals nothing.
function sealAfterStop({ chatId, result, seal, stateDir, now = Date.now, log = () => {} }) {
  let record
  if (!result || result.platformStopped !== true || result.drained !== true || result.startupStopped === false) {
    record = { chatId, ok: false, at: now(), error: 'The service did not stop cleanly; nothing was sealed' }
  } else {
    try {
      const out = seal(chatId)
      record = { chatId, ok: true, at: now(), incident: path.basename(out.incident),
        refusedSources: out.refusedSources }
    } catch (error) {
      record = { chatId, ok: false, at: now(), error: String(error?.message || error).slice(0, 300) }
    }
  }
  try { atomicWriteJSON(path.join(stateDir, RECORD), record, { mode: 0o600 }) }
  catch (error) { log(`console seal record not written: ${error?.message || String(error)}`) }
  log(record.ok
    ? `console sealed group ${chatId} in incidents/${record.incident}; ${record.refusedSources} source(s) refused from now on`
    : `console seal of group ${chatId} not done: ${record.error}`)
  return record
}

// The last console seal that did not complete, for the group still held.
function lastSealFailure(stateDir) {
  try {
    const record = JSON.parse(fs.readFileSync(path.join(stateDir, RECORD), 'utf8'))
    return record && record.ok === false && typeof record.chatId === 'string'
      ? { chatId: record.chatId, error: String(record.error || ''), at: Number(record.at) || 0 } : null
  } catch { return null }
}

module.exports = { createConsoleSeal, consoleSealAvailable, restartsAfterCleanExit, sealAfterStop,
  lastSealFailure, RECORD }
