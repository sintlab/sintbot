'use strict'

// Crash provenance for rule 2 (user, 11-20; ABI 40 unfinished_step "restart").
//
// When an uncaught error stops the service (src/fatal.js), the turns still
// running are written down here BEFORE the normal stop seals the journals:
// which conversation, which receipt and turn, who sent the message and the
// start of its text. At the next start a conversation whose journal still has
// exactly that turn running asks the core; an "interrupted" answer closes that
// turn and the conversation is told once which message was cut off. Nothing is
// redone. A stop by signal, an upgrade or a console seal writes no record and
// keeps the earlier behaviour (the group is held).
//
// One small private file in the data directory, written atomically and
// fsynced, removed once a start has opened every group. The quoted text is
// redacted and kept short; it only ever goes back into its own conversation.
const fs = require('node:fs')
const path = require('node:path')
const { atomicWriteJSON } = require('./core/store')
const { redact } = require('./core/redact')

const FILE = 'crash-stop.json'
const SCHEMA = 'sintbot-crash-stop-v1'
const KINDS = ['uncaughtException', 'unhandledRejection']
const RECEIPT_ID = /^[0-9a-f]{32}$/
const MAX_TURNS = 64
const MAX_TEXT = 400
const MAX_SENDER = 120

const crashStopFile = stateDir => path.join(stateDir, FILE)

// The turn a conversation's engine is running right now, as its journal sees
// it: one dispatched receipt, its turn token, and that message's sender and
// text. Null when nothing runs or the two disagree.
function runningTurn(chatId, binding) {
  const rt = binding?.engine?.rts?.get?.(chatId)
  const dispatch = rt?.v2DispatchEffect
  const token = rt?.v2TurnToken
  if (!rt || dispatch?.type !== 'dispatch' || !Number.isSafeInteger(token) || token <= 0 ||
      dispatch.turnToken !== token || !Array.isArray(dispatch.receiptIds) || dispatch.receiptIds.length < 1) return null
  let lanes
  try { lanes = binding.journal.snapshot().state.lanes } catch { return null }
  if (lanes.turn?.[chatId]?.active !== token) return null
  const receiptId = dispatch.receiptIds[0]
  // The one runner of the one dispatch that was running: a later attempt or
  // another process's record never matches it at the next start.
  const generation = rt.v2RunnerGeneration
  const dispatchEffectId = dispatch.effectId
  if (!RECEIPT_ID.test(receiptId || '') || !RECEIPT_ID.test(generation || '') ||
      typeof dispatchEffectId !== 'string' || !dispatchEffectId || dispatchEffectId.length > 512) return null
  const msg = Array.isArray(rt.v2RunningJobs) ? rt.v2RunningJobs.find(job => job?.msg?._c2ReceiptId === receiptId)?.msg ||
    rt.v2RunningJobs[0]?.msg : null
  const sender = typeof msg?.senderName === 'string' && msg.senderName.trim() ? msg.senderName
    : typeof msg?.userId === 'string' ? msg.userId : ''
  const text = typeof msg?.text === 'string' ? redact(msg.text).slice(0, MAX_TEXT) : ''
  return { chatId, receiptId, turnToken: token, generation, dispatchEffectId, receipts: dispatch.receiptIds.length,
    sender: sender.slice(0, MAX_SENDER), text }
}

// Synchronous on purpose: called from the fatal handler before the stop, and
// the process may be cut off at the stop ceiling. Never throws. Nothing is
// recorded once a stop has begun (SIGTERM, upgrade, console seal, a service
// fault): the turns it cuts off are the stop's, and keep the earlier hold.
function recordCrashStop({ stateDir, kind, bindings, stopping = false, now = Date.now, pid = process.pid, version = '', log = () => {} }) {
  if (stopping) { log('crash stop not recorded: a stop was already under way'); return null }
  try {
    const turns = []
    for (const [chatId, binding] of bindings || []) {
      const turn = runningTurn(chatId, binding)
      if (turn && turns.length < MAX_TURNS) turns.push(turn)
    }
    if (!turns.length) { log('crash stop: no turn was running'); return null }
    const record = { schema: SCHEMA, kind: KINDS.includes(kind) ? kind : 'uncaughtException', at: now(), pid, version, turns }
    atomicWriteJSON(crashStopFile(stateDir), record, { mode: 0o600 })
    log(`crash stop recorded ${turns.length} running turn(s): ${turns.map(t => t.chatId).join(', ')}`)
    return record
  } catch (error) {
    log(`crash stop record not written: ${error?.message || String(error)}`)
    return null
  }
}

// The record a crash left, checked field by field; anything else is ignored
// (the turns it would have named stay held, as without it).
function readCrashStop(stateDir, log = () => {}) {
  const file = crashStopFile(stateDir)
  let raw
  try { raw = fs.readFileSync(file, 'utf8') } catch { return null }
  try {
    const st = fs.lstatSync(file)
    if (!st.isFile() || st.isSymbolicLink() || process.platform !== 'win32' && (st.mode & 0o077)) throw new Error('not a private file')
    const record = JSON.parse(raw)
    if (!record || record.schema !== SCHEMA || !KINDS.includes(record.kind) || !Array.isArray(record.turns) ||
        record.turns.length > MAX_TURNS) throw new Error('unknown shape')
    const turns = record.turns.filter(t => t && typeof t.chatId === 'string' && t.chatId &&
      RECEIPT_ID.test(t.receiptId || '') && Number.isSafeInteger(t.turnToken) && t.turnToken > 0 &&
      RECEIPT_ID.test(t.generation || '') && typeof t.dispatchEffectId === 'string' && t.dispatchEffectId &&
      t.dispatchEffectId.length <= 512 &&
      Number.isSafeInteger(t.receipts) && t.receipts >= 1 &&
      typeof t.sender === 'string' && t.sender.length <= MAX_SENDER && typeof t.text === 'string' && t.text.length <= MAX_TEXT)
    return { kind: record.kind, at: Number(record.at) || 0, turns }
  } catch (error) {
    log(`crash stop record ignored: ${error?.message || String(error)}`)
    return null
  }
}

function clearCrashStop(stateDir, log = () => {}) {
  try { fs.unlinkSync(crashStopFile(stateDir)); return true }
  catch (error) {
    if (error?.code !== 'ENOENT') log(`crash stop record not removed: ${error?.message || String(error)}`)
    return false
  }
}

module.exports = { recordCrashStop, readCrashStop, clearCrashStop, crashStopFile, runningTurn, FILE }
