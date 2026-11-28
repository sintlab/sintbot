'use strict'

// The bot's name and picture as the console shows them (sidebar, settings).
// Display data only: it lives in its own file in the data directory, never in
// the connection configuration (an online change of `feishu` there asks for a
// restart). Whose name is shown and when a platform is asked again is the
// binary core's decision (identity_view); this file reads, asks and stores.
//
// File: { feishu: { appId, name, avatar, at, triedAt } }
//   at       when the name was last read from Feishu
//   triedAt  when Feishu was last asked, whatever came of it
// An entry for another app id is not this app's and is ignored.

const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteJSON } = require('./core/store')
const { identityView } = require('./agent/privatecore')

const FILE = 'bot-identity.json'
const text = (value) => (typeof value === 'string' ? value.trim().slice(0, 500) : '')
const time = (value) => (Number.isFinite(value) && value >= 0 ? value : null)

function readStored(stateDir) {
  if (!stateDir) return {}
  try {
    const value = JSON.parse(fs.readFileSync(path.join(stateDir, FILE), 'utf8'))
    return value && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch { return {} }
}

function writeStored(stateDir, value) {
  atomicWriteJSON(path.join(stateDir, FILE), value)
}

// What Feishu returned for the app (src/platform/feishu.js fetchAppIdentity),
// kept as this file's entry. Called at the end of a successful connect and by
// the keeper below.
function saveFeishuIdentity(stateDir, appId, identity, now = Date.now()) {
  const name = text(identity && identity.appName)
  if (!stateDir || !appId || !name) return false
  const stored = readStored(stateDir)
  writeStored(stateDir, { ...stored, feishu: { appId, name, avatar: text(identity.avatarUrl), at: now, triedAt: now } })
  return true
}

const connected = (snapshot) => !!snapshot && snapshot.state === 'connected'

// The facts of every configured platform, in no particular order.
function identityFacts({ raw, stored, conn, triedAt = null }) {
  const one = conn && typeof conn.state === 'string' ? { feishu: conn } : (conn || {})
  const platforms = []
  const fe = raw && raw.feishu
  if (fe && fe.appId) {
    const mine = stored.feishu && stored.feishu.appId === fe.appId ? stored.feishu : null
    // The identity an older version kept in the configuration is the first value.
    const old = fe.identity && typeof fe.identity === 'object' ? fe.identity : {}
    const tried = [time(mine && mine.triedAt), time(triedAt)].filter((v) => v !== null)
    platforms.push({ id: 'feishu', connected: connected(one.feishu),
      name: text(mine && mine.name) || text(old.name), avatar: mine ? text(mine.avatar) : text(old.avatar),
      at: mine ? time(mine.at) : time(old.at), triedAt: tried.length ? Math.max(...tried) : null })
  }
  const we = raw && raw.wecom
  if (we && we.botId) {
    platforms.push({ id: 'wecom', connected: connected(one.wecom),
      name: text(we.botName) || text(one.wecom && one.wecom.botNameLearned), avatar: '', at: null, triedAt: null })
  }
  const sl = raw && raw.slack
  if (sl && sl.botToken) {
    platforms.push({ id: 'slack', connected: connected(one.slack),
      name: text(sl.identity && sl.identity.botName), avatar: '', at: null, triedAt: null })
  }
  return platforms
}

// `fetchFeishu()` resolves with fetchAppIdentity's result for the configured
// app. `stateDir` null (a run without a data directory): nothing is asked or
// stored, the configuration's own values are shown.
function createBotIdentity({ stateDir = null, readRaw, getConn = () => null, fetchFeishu = null,
  onChange = () => {}, log = () => {}, now = Date.now } = {}) {
  if (typeof readRaw !== 'function') throw new TypeError('Bot identity needs the configuration reader')
  let asking = false
  let tried = null // in memory too: a file that cannot be written must not mean asking on every refresh

  function ask(appId) {
    asking = true
    tried = now()
    try {
      const stored = readStored(stateDir)
      const mine = stored.feishu && stored.feishu.appId === appId ? stored.feishu : { appId, name: '', avatar: '', at: null }
      writeStored(stateDir, { ...stored, feishu: { ...mine, triedAt: tried } })
    }
    catch (error) { log('bot identity: ' + (error && error.message)) }
    Promise.resolve().then(fetchFeishu).then((identity) => {
      if (saveFeishuIdentity(stateDir, appId, identity, now())) { try { onChange() } catch {} }
    }).catch((error) => log('bot identity: Feishu did not answer: ' + ((error && error.message) || error)))
      .finally(() => { asking = false })
  }

  // { show, feishu }: what the sidebar shows, and the Feishu entry for the
  // settings card (null when there is none).
  function view() {
    let raw
    try { raw = readRaw() } catch { return { show: null, feishu: null } }
    const stored = readStored(stateDir)
    const platforms = identityFacts({ raw, stored, conn: stateDir ? getConn() : null, triedAt: tried })
    const out = identityView({ now: now(), platforms })
    if (stateDir && fetchFeishu && !asking && out.fetch.includes('feishu')) ask(raw.feishu.appId)
    const fe = platforms.find((p) => p.id === 'feishu')
    return { show: out.show, feishu: fe && fe.name ? { name: fe.name, avatar: fe.avatar, at: fe.at } : null }
  }

  return { view }
}

module.exports = { createBotIdentity, saveFeishuIdentity, identityFacts, readStored, FILE }
