'use strict'

// Rule 2 at service start (user, 11-20; ABI 40): a conversation whose journal
// still has a turn running asks the core what to do with it. The host only
// gathers the facts — the crash record written before the last stop sealed the
// journal (src/c2crashstop.js) and what this journal says about that turn —
// and executes the answer:
//   interrupted → one crashInterrupt transition closes that turn's lanes (the
//                 core reducer checks the lanes again), and the core's notice
//                 becomes the one recovery notice of its receipt;
//   hold        → nothing changes; the recovery gate then refuses the running
//                 turn and the group is held, exactly as before.
// Nothing is retried or replayed in either case.
const { isDeepStrictEqual } = require('node:util')
const { EngineStepCoordinator } = require('./enginestepcoordinator')
const { callbackRegistrationId } = require('./c2eventidentity')
const { unfinishedStep } = require('../agent/privatecore')

// What this journal says about the running turn of `chatId`, or null when no
// turn is running.
function runningTurnFacts(journal, chatId) {
  const snapshot = journal.snapshot()
  const lanes = snapshot.state.lanes
  const token = lanes.turn?.[chatId]?.active
  if (token == null) return null
  const handoff = lanes.handoff?.[chatId]
  let dispatch = null
  let unsettled = 0
  let reply = false
  for (const [effectId, status] of snapshot.effects) {
    const descriptor = journal.effectDescriptor(effectId)
    if (descriptor?.domain === 'atomicHandoff' && descriptor.type === 'dispatch' &&
        descriptor.scope === chatId && descriptor.turnToken === token) {
      dispatch = { effectId, receiptId: descriptor.receiptId, status }
      continue
    }
    if (descriptor?.domain === 'terminal' && descriptor.scope === chatId && descriptor.turnToken === token) reply = true
    // A start proven never begun (rule 1) is settled, not an unknown outcome.
    if (status !== 'acked' && status !== 'notStarted') unsettled++
  }
  for (const notice of snapshot.notices.values()) {
    if (notice.status === 'attempting' || notice.status === 'unknown') unsettled++
  }
  const terminal = lanes.terminal?.[chatId]
  if (terminal && !isDeepStrictEqual(terminal, { finalized: false, outcome: null })) reply = true
  const pending = snapshot.receipts.pending
  const receipt = dispatch && pending.find(item => item.id === dispatch.receiptId && item.chatId === chatId)
  return { token, dispatch, receipt: receipt || null, reply, unsettled,
    single: !!handoff && handoff.phase === 'running' && handoff.turnToken === token && handoff.attempt === 0 &&
      Array.isArray(handoff.acceptedReceiptIds) && handoff.acceptedReceiptIds.length === 0 && handoff.nextJobId === null,
    waiting: pending.filter(item => item.chatId === chatId && !item.quiet && item.id !== dispatch?.receiptId).length }
}

// Returns null when nothing runs, else { decision, receiptId }. Throws when the
// transition cannot be committed: the caller holds the group, as before.
function settleCrashedTurn({ journal, chatId, crash, lang, assertWriterLock, notes, store = null, log = () => {} }) {
  const facts = runningTurnFacts(journal, chatId)
  if (!facts) return null
  const entry = crash?.turns?.find(turn => turn.chatId === chatId) || null
  // The record names exactly this dispatch and the runner registered for it:
  // same receipt, turn and dispatch effect, and its generation is the one this
  // journal registered for that receipt's runner. Anything else is ignored.
  let registered = false
  try {
    registered = !!entry && journal.lookupRegistration(callbackRegistrationId({ receiptId: entry.receiptId,
      generation: entry.generation, domain: 'atomicHandoff', kind: 'runnerAccepted' }))?.generation === entry.generation
  } catch { registered = false }
  const matched = !!entry && !!facts.dispatch && !!facts.receipt && registered &&
    entry.receiptId === facts.dispatch.receiptId && entry.turnToken === facts.token &&
    entry.dispatchEffectId === facts.dispatch.effectId
  const decision = unfinishedStep({ type: 'restart', stop: crash ? 'crash' : null,
    turn: { matched, single: facts.single && (!entry || entry.receipts === 1),
      dispatch: facts.dispatch?.status || 'unknown', reply: facts.reply,
      unsettled: facts.unsettled, waiting: facts.waiting },
    sender: matched ? entry.sender || null : null, text: matched ? entry.text || null : null, lang })
  log(`group ${chatId}: a turn was still running at start; core says ${decision.decision} (${decision.reason})`)
  if (decision.decision !== 'interrupted') return { decision, receiptId: null }
  if (assertWriterLock() !== true) throw new Error('C2 crash interruption lost the writer lock')
  const receiptId = facts.dispatch.receiptId
  const token = facts.token
  const generation = entry.generation
  // The session is kept: its next turn tells the model not to continue this
  // request (turn_prompt). Written before the transition, so a restart in
  // between cannot lose it; the engine uses it only if the journal then has
  // the crashInterrupt event and the session is still the same.
  store?.markInterrupted(chatId, { receiptId, turnToken: token, generation,
    sessionId: store.getSession(chatId) || null, text: entry.text || null })
  const coordinator = new EngineStepCoordinator({ journal })
  const result = coordinator.transition({ id: `sbot-c2-crash-interrupt-v1:${receiptId}:${token}:${generation}`,
    domain: 'crashInterrupt', scope: chatId,
    payload: { type: 'abandonInterruptedTurn', receiptId, turnToken: token, runnerGeneration: generation,
      crashEvidenceId: `sbot-c2-crash-stop-v1:${receiptId}:${token}:${generation}` },
    validate: candidate => {
      if (candidate.effects.length || !isDeepStrictEqual(candidate.decision,
        { abandonedReceiptId: receiptId, requiresStartupRecovery: true, scope: chatId })) {
        throw new Error('C2 crash interruption decision invalid')
      }
    } })
  const after = journal.snapshot()
  if (result.decision.requiresStartupRecovery !== true || after.state.lanes.turn?.[chatId]?.active !== null ||
      after.state.lanes.handoff?.[chatId]?.phase !== 'idle' ||
      !after.receipts.pending.some(item => item.id === receiptId)) {
    throw new Error('C2 crash interruption did not close the running turn')
  }
  notes?.set(receiptId, decision.notice)
  return { decision, receiptId }
}

module.exports = { settleCrashedTurn, runningTurnFacts }
