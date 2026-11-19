'use strict'
// Slack: what an interrupted round leaves on people's messages, cleared once.
//
// A force-kill or a seal ends a round without an answer. The durable contract
// stays as it is: an unknown outcome is never resent, the group is held, and
// a seal keeps its unsettled source messages out of every later start
// (incidents/*/incident.json). On Slack, though, the ⏳ on those messages and
// the 「已排队」 in a queued message's thread would stay forever. At service
// start, for Slack conversations only, a message a seal left unsettled gets
// ⚠️ instead of ⏳ (its thread stops showing "Working…") and, once, a short
// reply that it did not finish; a message of a group still held gets the ⚠️
// only. The built-in core decides which messages are marked, which get a note
// and in which wording, what the record says before and after each attempt
// and which record entries are kept. This module gathers the facts, reads and
// writes the record, marks the messages and posts the notes.
// Display only: no journal or receipt is changed (a sealed journal is read
// through a private copy, never opened in place), nothing runs again. A note
// is written in the language of its conversation (`groups[chatId].lang`).
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { atomicWriteJSON } = require('./core/store')
const { C2DurableJournal } = require('./core/c2durablejournal')
const { validatePersistentState } = require('./core/c2persiststate')
const { validatePersistentReceipts, validatePersistentRelation } = require('./core/c2persistrelation')
const { chatPlatform } = require('./config')
const { isSlackChatId, isSlackDmChatId, isSlackMessageId, slackMessageRef, slackChannelOf } = require('./platform/slack')
const { chatLang, pick } = require('./chatlang')
const { leftoverStep } = require('./agent/privatecore')

const FILE = 'slack-leftover.json'
const NOTE = '这条没有完成，需要的话请重发。'
const DIRECT_NOTE = '标了 ⚠️ 的消息没有完成，需要的话请重发。'
const NOTE_EN = 'This one did not finish. Please send it again if you still need it.'
const DIRECT_NOTE_EN = 'The messages marked ⚠️ did not finish. Please send them again if you still need them.'

// {} when there is no record yet; null when one exists but cannot be read.
function readNotes(file) {
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch (error) { return error?.code === 'ENOENT' ? {} : null }
  try {
    const data = JSON.parse(raw)
    if (data?.version === 1 && data.notes && typeof data.notes === 'object' && !Array.isArray(data.notes)) {
      return data.notes
    }
  } catch {}
  return null
}

// The sources of a sealed incident whose restart recovery notice was
// attempted: read from a private copy of the sealed journal (opening a
// journal may repair its tail; the evidence itself is never opened). Null
// when that cannot be known.
const VALIDATORS = { validateState: validatePersistentState,
  validateReceipts: validatePersistentReceipts, validateRelation: validatePersistentRelation }
function noticedSources(incident, stateDir) {
  if (typeof incident.dir !== 'string' || typeof incident.journal !== 'string') return null
  const copy = path.join(stateDir, `.slack-leftover-${randomUUID()}.journal`)
  try {
    fs.copyFileSync(path.join(incident.dir, incident.journal), copy, fs.constants.COPYFILE_EXCL)
    fs.chmodSync(copy, 0o600)
    const journal = C2DurableJournal.open(copy, VALIDATORS)
    const noticed = new Set()
    for (const receipt of journal.snapshot().receipts.pending) {
      if (journal.noticeStatus(receipt.id) !== null) noticed.add(receipt.sourceId)
    }
    return noticed
  } catch { return null } finally {
    try { fs.rmSync(copy, { force: true }) } catch {}
  }
}

const slackGroup = (cfg, chatId) => isSlackChatId(chatId) && !!cfg?.groups?.[chatId] &&
  chatPlatform(cfg, chatId) === 'slack'
const ownMessage = (chatId, id) => isSlackMessageId(id) && !!slackMessageRef(id)?.ts &&
  slackMessageRef(id).channel === slackChannelOf(chatId)

// languageOf(chatId) -> 'zh' | 'en'; without one, the conversation's own
// setting in `cfg` is read when its note is sent.
async function markSlackLeftovers({ stateDir, cfg, adapter, incidents = [], held = [],
  pendingOf = () => [], now = Date.now, log = () => {},
  languageOf = chatId => chatLang(cfg?.groups?.[chatId], 'slack') } = {}) {
  const done = { marked: 0, noted: 0 }
  // Anything but a clear 'zh' is English, as a Slack conversation is without the setting.
  const langOf = chatId => { try { return languageOf(chatId) === 'zh' ? 'zh' : 'en' } catch { return 'en' } }
  if (!adapter || typeof adapter.replyOnce !== 'function' || typeof stateDir !== 'string') return done
  const mark = (chatId, ids) => {
    if (!ids.length) return
    try { adapter.presence?.unfinished?.(chatId, ids) } catch {}
    done.marked += ids.length
  }
  // The facts, as this platform sees them: its own conversations and the
  // messages it can address there.
  const heldFacts = []
  for (const chatId of held) {
    if (!slackGroup(cfg, chatId)) continue
    let pending = []
    try { pending = pendingOf(chatId) || [] } catch {}
    heldFacts.push({ chatId, sources: pending.map(item => item?.sourceId).filter(id => ownMessage(chatId, id)) })
  }
  const file = path.join(stateDir, FILE)
  const notes = readNotes(file)
  const sealedIncidents = incidents.filter(item => slackGroup(cfg, item?.chatId))
  const sealed = sealedIncidents.map(incident => ({ chatId: incident.chatId, sealedAt: incident.sealedAt,
    direct: isSlackDmChatId(incident.chatId),
    sources: [...(incident.sourceIds || [])].filter(id => ownMessage(incident.chatId, id)) }))
  const facts = { now: now(), record: notes, sealed }
  // The built-in core decides what is marked, what is noted and how, and
  // what the record says before and after each attempt.
  const scan = leftoverStep({ type: 'scan', ...facts, held: heldFacts })
  for (const effect of scan.effects) mark(effect.chatId, effect.ids)
  if (scan.stop) {
    log('Slack leftover notes skipped: their record cannot be read; nothing is posted until it is restored')
    return done
  }
  // Which messages their restart recovery notice already told, for the seals it asks about.
  const noticed = sealed.map(() => null)
  for (const index of scan.need) {
    const told = noticedSources(sealedIncidents[index], stateDir)
    if (told) noticed[index] = [...told]
    else log(`Slack leftover notes skipped for ${sealed[index].chatId}: its sealed journal cannot be read`)
  }
  const plan = leftoverStep({ type: 'plan', ...facts, noticed })
  const keep = new Set(plan.keep)
  const kept = Object.fromEntries(Object.entries(notes).filter(([key]) => keep.has(key)))
  const save = () => atomicWriteJSON(file, { version: 1, notes: kept }, { mode: 0o600 })
  for (const effect of plan.effects) {
    if (effect.type === 'mark') { mark(effect.chatId, effect.ids); continue }
    if (effect.type === 'record') {
      kept[effect.key] = { status: effect.status, at: now() }
      try { save() } catch (error) {
        if (!effect.required) continue
        log(`Slack leftover note skipped; its record could not be saved: ${error?.message || String(error)}`)
        return done
      }
      continue
    }
    let sent = false
    try {
      const lang = langOf(effect.chatId)
      const text = effect.wording === 'direct' ? pick(lang, DIRECT_NOTE, DIRECT_NOTE_EN) : pick(lang, NOTE, NOTE_EN)
      const response = await adapter.replyOnce({ chatId: effect.chatId, messageId: effect.target },
        text, { notice: true })
      sent = response?.code === 0
    } catch {}
    kept[effect.key] = { status: sent ? 'sent' : 'unknown', at: now() }
    try { save() } catch {}
    if (sent) done.noted++
    else log(`Slack leftover note not confirmed for ${effect.chatId}; it is not sent again`)
  }
  if (plan.compact) { try { save() } catch {} }
  return done
}

module.exports = { markSlackLeftovers, NOTE, DIRECT_NOTE, NOTE_EN, DIRECT_NOTE_EN, FILE }
