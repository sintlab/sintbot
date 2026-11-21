'use strict'
// A conversation bound before any model was set up (the setup page no longer
// asks for an executor, 1.4.33): the saved configuration carries
// `awaitingModel: true` (written by the core at setup), no `defaultProvider`,
// and the group no `provider`. A hand-written file without a default is not
// this state: it keeps following the built-in default as before. Until a model is added in the console,
// or Claude Code (the built-in default) is signed in on this Mac, a plain
// message is answered with one line instead of starting a turn that can only
// fail. Commands (`/help`, `/status`, Slack `!help` …) still pass.
//
// Cheap on the message path: the configuration is re-read only when its file
// changes, and the Claude sign-in state is refreshed in the background (local
// `claude auth status --json`, no network, no quota) at most every 30 s.
const fs = require('node:fs')
const { execFile } = require('node:child_process')

const SIGNED_IN_TTL_MS = 30_000

function claudeSignedIn(callback, { exec = execFile, env = process.env } = {}) {
  try {
    exec('claude', ['auth', 'status', '--json'], { timeout: 10_000, maxBuffer: 64 * 1024, env }, (error, stdout) => {
      if (error) return callback(false)
      try { callback(JSON.parse(String(stdout || '{}')).loggedIn === true) } catch { callback(false) }
    })
  } catch { callback(false) }
}

function createModelPending({ configFile, now = Date.now, probe = claudeSignedIn, log = () => {} } = {}) {
  let cached = { mtimeMs: -1, raw: null }
  let signedIn = null
  let checkedAt = -Infinity
  let checking = false
  const readRaw = () => {
    try {
      const st = fs.statSync(configFile)
      if (st.mtimeMs !== cached.mtimeMs) cached = { mtimeMs: st.mtimeMs, raw: JSON.parse(fs.readFileSync(configFile, 'utf8')) }
    } catch { cached = { mtimeMs: -1, raw: null } }
    return cached.raw
  }
  const refresh = () => {
    if (checking || now() - checkedAt < SIGNED_IN_TTL_MS) return
    checking = true
    probe(value => {
      if (signedIn !== value) log(`Claude Code sign-in for conversations without a model: ${value ? 'signed in' : 'not signed in'}`)
      signedIn = value; checkedAt = now(); checking = false
    })
  }
  const deferred = chatId => {
    const raw = readRaw()
    const group = raw?.groups?.[chatId]
    return raw?.awaitingModel === true && !!group && !group.provider && !raw.defaultProvider
  }
  return {
    deferred,
    // True only when the message would start a turn with no usable model.
    // Unknown sign-in state (first moments after start) lets the turn run as before.
    pending(msg) {
      const text = String(msg?.text ?? '').trim()
      if (/^[/!]/.test(text)) return false
      if (!deferred(msg?.chatId)) return false
      refresh()
      return signedIn === false
    },
    // At start: probe once only when some conversation is waiting for a model.
    warm() {
      const raw = readRaw()
      if (raw?.awaitingModel === true && !raw.defaultProvider && Object.values(raw.groups || {}).some(g => g && !g.provider)) refresh()
    },
  }
}

module.exports = { createModelPending, claudeSignedIn }
