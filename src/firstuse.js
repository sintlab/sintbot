'use strict'
// First use (public issue #1): the first task this installation finished, a
// source the person may pick and a feedback summary they may copy. Nothing
// here touches the network; the summary only reaches the clipboard when the
// person clicks "copy" in the console.
//
// Every rule is the built-in core's (first_use_step, ABI 41): what counts as
// the first success, how failures before it are classed, when the card shows,
// what the summary says. This file only keeps the record file, reads this
// machine's facts and hands the core each event.
//
// The record is one small JSON file in the data directory, so a retry, a
// restart or an upgrade reads the same record and never counts again.

const fs = require('node:fs')
const path = require('node:path')
const { execFileSync } = require('node:child_process')

// The machine facts the summary may carry: service version, macOS major
// version and chip family. Read once, each guarded: a fact that cannot be read
// is null and the summary says unknown.
function machineFacts({ exec = execFileSync, platform = process.platform } = {}) {
  let service = null
  try { service = require('../package.json').version } catch {}
  let osMajor = null, chip = null
  if (platform === 'darwin') {
    try {
      const major = Number(String(exec('/usr/bin/sw_vers', ['-productVersion'], { encoding: 'utf8', timeout: 2000 })).trim().split('.')[0])
      if (Number.isInteger(major) && major > 0) osMajor = major
    } catch {}
    // hw.optional.arm64 is 1 on Apple silicon, also for a process under
    // Rosetta; an Intel Mac has no such key and sysctl fails.
    try { chip = String(exec('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'], { encoding: 'utf8', timeout: 2000 })).trim() === '1' ? 'apple' : 'intel' }
    catch { chip = 'intel' }
  }
  return { service, osMajor, chip }
}

// An App version as the desktop shell reports it to the page; the core
// checks its shape again, so anything else simply reads as unknown.
const appVersion = value => typeof value === 'string' && value.length <= 48 ? value : null

function createFirstUse({ file, answeredBefore = () => false, canWrite = () => true, log = () => {},
  now = Date.now, facts = () => machineFacts(), step = (state, event) => require('./agent/privatecore').firstUseStep(state, event),
  classify = text => require('./agent/privatecore').classifyErrorCode(text) } = {}) {
  if (!path.isAbsolute(file || '')) throw new TypeError('first use needs an absolute record file')
  let state = null
  try {
    state = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (error) {
    // An unreadable record goes to the core as it is: it reads as inherited
    // (no card, no count) and only a clear replaces it.
    if (error.code !== 'ENOENT') { state = 'unreadable'; log('First-use record could not be read; it is kept and nothing is counted') }
  }
  let cachedFacts = null
  const machine = () => (cachedFacts ||= facts())

  function write(next) {
    if (!canWrite()) return false
    const tmp = file + '.tmp'
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true })
      fs.writeFileSync(tmp, JSON.stringify(next) + '\n', { mode: 0o600 })
      fs.renameSync(tmp, file)
      return true
    } catch (error) {
      try { fs.rmSync(tmp, { force: true }) } catch {}
      log(`First-use record could not be saved: ${error.code || error.message}`)
      return false
    }
  }
  function apply(event) {
    let out
    try { out = step(state, event) } catch (error) {
      log(`First-use step ${event.type} refused: ${error.message}`)
      return null
    }
    if (out.changed) write(out.state)
    state = out.state
    return out
  }

  apply({ type: 'open', answeredBefore: (() => { try { return answeredBefore() === true } catch { return true } })() })

  const api = {
    // A turn closed in the activity record (src/ui/liveactivity.js onClose).
    observe({ status, err } = {}) {
      let errCode = 0
      if (err) { try { errCode = classify(String(err).slice(0, 4000)) } catch { errCode = 0 } }
      apply({ type: 'finish', status: String(status || ''), errCode, at: now() })
    },
    view({ lang = 'zh', app = null } = {}) {
      const out = apply({ type: 'view', lang: lang === 'en' ? 'en' : 'zh', facts: { ...machine(), app: appVersion(app) } })
      return out?.view || { show: false }
    },
    shown() {
      const out = apply({ type: 'view', lang: 'zh', facts: {} })
      return out?.view?.show === true
    },
    // The console's three actions; each answers the card as it now reads.
    act({ op, value = null, lang = 'zh', app = null } = {}) {
      const event = op === 'source' ? { type: 'source', value: value === null ? null : String(value) }
        : op === 'dismiss' ? { type: 'dismiss' } : op === 'clear' ? { type: 'clear' } : null
      if (!event) return { ok: false, error: 'unknown action' }
      const out = apply(event)
      if (!out) return { ok: false, error: 'refused' }
      return { ok: true, firstUse: api.view({ lang, app }) }
    },
  }
  return api
}

module.exports = { createFirstUse, machineFacts }
