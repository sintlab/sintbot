'use strict'

// Startup upgrade announcement. After a version change each configured group
// that is neither paused nor held receives one notice card (text where the
// chat has no card capability), built from CHANGELOG.json like the console's
// version history. First run and downgrades only record the baseline; so does
// a start with the console's announcement preference turned off.
//
// The new baseline is recorded before anything is sent: a crash during the
// broadcast loses the announcement instead of repeating it on the next start.
// Every failure is logged per group and never reaches startup.
const fs = require('node:fs')
const path = require('node:path')
const { cmpVersion } = require('./upgrade')
const { deliverUpgradeNotice } = require('./platform/noticesend')
const { redact } = require('./core/redact')

function readChangelog(file = path.join(__dirname, '..', 'CHANGELOG.json')) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return Array.isArray(value) ? value : []
  } catch { return [] }
}

function announceUpgradeOnStart({ store, cfg = {}, platform, changelog = [], currentVersion,
  heldGroups = [], log = () => {}, deliver = deliverUpgradeNotice } = {}) {
  const skipped = state => ({ state, chats: [], done: Promise.resolve([]) })
  let last
  try {
    last = store.getLastVersion()
    if (!currentVersion || last === currentVersion) return skipped('unchanged')
    store.setLastVersion(currentVersion)
  } catch (error) {
    // Without a durable baseline every restart would announce again.
    log(`升级播报: 版本基线没有记下,本次不播报: ${error && error.message}`)
    return skipped('baseline-failed')
  }
  if (!last) return skipped('first-run')
  if (cmpVersion(currentVersion, last) <= 0) return skipped('downgrade')
  if (cfg.ui?.announceUpdates === false) return skipped('disabled')
  if (!platform) { log('升级播报: 平台未连接,本次不播报'); return skipped('no-platform') }
  const held = new Set(heldGroups instanceof Map ? heldGroups.keys() : heldGroups)
  const chats = []
  const deliveries = []
  for (const [chatId, g] of Object.entries(cfg.groups || {})) {
    if (!g || g.paused || held.has(chatId)) continue // 暂停 = 别打扰;被挂起的群不发
    chats.push(chatId)
    deliveries.push(Promise.resolve()
      .then(() => deliver(platform, chatId, last, currentVersion, changelog, cfg.brand,
        { redact: s => redact(s, { pii: g.redactPii !== false }), log }))
      .then(r => {
        if (r && r.result == null) log(`升级播报未送达(${chatId}):平台确认没发出去`)
        return { chatId, mode: r ? r.mode : null, delivered: !!(r && r.result != null) }
      }, error => {
        log(`升级播报(${chatId}): ${error && error.message}`)
        return { chatId, mode: null, delivered: false }
      }))
  }
  return { state: 'announced', chats, done: Promise.all(deliveries) }
}

module.exports = { announceUpgradeOnStart, readChangelog }
