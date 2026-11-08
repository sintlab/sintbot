'use strict'

const { isDeepStrictEqual } = require('node:util')
const { C2DurableJournal } = require('./c2durablejournal')
const { C2DurableRuntime } = require('./c2durableruntime')
const { EngineStepCoordinator } = require('./enginestepcoordinator')
const { validatePersistentReceipts, validatePersistentRelation } = require('./c2persistrelation')

const RECEIPT_ID = /^[0-9a-f]{32}$/

function queuedReceiptIds(snapshot) {
  const ids = new Set()
  for (const lane of Object.values(snapshot.state.lanes.queue || {})) {
    for (const job of lane.queue) {
      ids.add(job.id.slice('receipt:job:'.length))
      for (const member of job.batch || []) {
        ids.add(member.id.slice('receipt:member:'.length))
      }
    }
  }
  return ids
}

// A close ID is a journal proof only when it binds the exact current pending
// receipt and ACKed dispatch. The Rust boolean alone is deliberately not used
// as evidence. Any unrelated unconfirmed effect keeps the whole fault closed.
function activeFaultTurns(snapshot, journal, active, supplied) {
  if (!Array.isArray(supplied) || supplied.length !== active.length ||
      supplied.length === 0 || supplied.length > 32 ||
      [...snapshot.effects.values()].some(status => status !== 'acked') ||
      [...snapshot.notices.values()].some(item =>
        item.status === 'attempting' || item.status === 'unknown')) {
    throw new Error('C2 active fault has incomplete durable evidence')
  }
  const pending = new Map(snapshot.receipts.pending.map(item => [item.id, item]))
  const queued = queuedReceiptIds(snapshot)
  const expected = active.map(item => item.chatId)
  const listed = []
  const seenReceipts = new Set()
  for (let index = 0; index < supplied.length; index++) {
    const item = supplied[index]
    if (!item || typeof item !== 'object' || Array.isArray(item) ||
        Object.keys(item).sort().join(',') !==
          'chatId,closeEvidenceId,receiptId,runnerClosed,runnerGeneration,turnToken' ||
        item.chatId !== expected[index] || item.turnToken !== active[index].turnToken ||
        !RECEIPT_ID.test(item.receiptId) || !RECEIPT_ID.test(item.runnerGeneration) ||
        item.runnerClosed !== true || seenReceipts.has(item.receiptId) ||
        item.closeEvidenceId !==
          `sbot-c2-runner-closed-v1:${item.receiptId}:${item.runnerGeneration}` ||
        pending.get(item.receiptId)?.chatId !== item.chatId ||
        queued.has(item.receiptId) ||
        snapshot.receipts.pending.filter(receipt =>
          receipt.chatId === item.chatId && !queued.has(receipt.id)).length !== 1 ||
        !isDeepStrictEqual(snapshot.state.lanes.terminal?.[item.chatId] ??
          { finalized: false, outcome: null },
        { finalized: false, outcome: null })) {
      throw new Error('C2 active fault turn differs from pending receipt')
    }
    const proof = journal.lookupRunnerClosed(item.closeEvidenceId)
    const descriptor = proof && journal.effectDescriptor(proof.dispatchEffectId)
    if (!proof || proof.receiptId !== item.receiptId ||
        proof.chatId !== item.chatId || proof.turnToken !== item.turnToken ||
        proof.generation !== item.runnerGeneration ||
        descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
        descriptor.scope !== item.chatId || descriptor.receiptId !== item.receiptId ||
        descriptor.turnToken !== item.turnToken ||
        journal.effectStatus(proof.dispatchEffectId) !== 'acked') {
      throw new Error('C2 active fault runner close evidence invalid')
    }
    seenReceipts.add(item.receiptId)
    listed.push({ chatId: item.chatId, receiptId: item.receiptId,
      turnToken: item.turnToken, runnerGeneration: item.runnerGeneration,
      runnerClosed: true, closeEvidenceId: item.closeEvidenceId })
  }
  return listed
}

function commitActiveFault({ journal, snapshot, turns, assertWriterLock }) {
  const eventId = `sbot-c2-global-fault-v1:${snapshot.cursor}`
  const coordinator = new EngineStepCoordinator({ journal })
  const expectedSessions = structuredClone(snapshot.state.lanes.session || {})
  for (const turn of turns) {
    const lane = expectedSessions[turn.chatId]
    if (!lane) continue
    if (lane.epoch !== turn.turnToken || lane.closeSeen !== true) {
      throw new Error('C2 global fault session lacks matching closed runner')
    }
    lane.settled = true
  }
  const prepared = coordinator.prepare({ id: eventId, domain: 'globalFault',
    scope: 'global', payload: { type: 'abandonActiveTurns',
      externalEffectsReconciled: true, turns },
    validate(result) {
      if (result.effects.length !== 0 || result.effectDescriptors?.length !== 0 ||
          !isDeepStrictEqual(result.decision?.abandonedReceiptIds,
            turns.map(item => item.receiptId)) ||
          result.decision?.requiresStartupRecovery !== true ||
          result.state.seq !== snapshot.cursor + 1 ||
          !isDeepStrictEqual(result.state.lanes.session || {}, expectedSessions) ||
          !isDeepStrictEqual(result.state.lanes.queue,
            snapshot.state.lanes.queue)) {
        throw new Error('C2 global fault reducer result differs from proven closure')
      }
    } })
  if (assertWriterLock() !== true) {
    prepared.cancel()
    throw new Error('C2 global fault writer lock lost before commit')
  }
  const committed = prepared.commit()
  if (journal.cursor !== snapshot.cursor + 1 ||
      !journal.hasEvent(eventId) ||
      !isDeepStrictEqual(journal.snapshot().state, committed.state) ||
      !isDeepStrictEqual(journal.snapshot().receipts, snapshot.receipts)) {
    throw new Error('C2 global fault durable commit unverified')
  }
  return committed
}

// Scoped reducer boundary for a future per-chat recovery path. It is safe to
// call from a prepare validator: even a Rust result with a valid cursor may
// only modify the failed chat's closure lanes. No sibling queue, turn, receipt
// or effect is authorized by a scoped failure.
function validateScopedFaultResult(before, result, chatId, turn, eventId) {
  if (!before || !result || typeof chatId !== 'string' || !chatId ||
      !turn || turn.chatId !== chatId || typeof eventId !== 'string' || !eventId ||
      result.state?.seq !== before.state?.seq + 1 ||
      result.state?.lastEventId !== eventId ||
      !Array.isArray(result.effects) || result.effects.length !== 0 ||
      result.effectDescriptors !== undefined &&
        (!Array.isArray(result.effectDescriptors) || result.effectDescriptors.length !== 0) ||
      !isDeepStrictEqual(result.decision, {
        abandonedReceiptIds: [turn.receiptId],
        requiresStartupRecovery: true, scope: chatId,
      })) {
    throw new Error('C2 scoped fault result invalid')
  }
  const prior = before.state.lanes || {}
  const next = result.state.lanes || {}
  const allowed = new Set(['turn', 'lifecycle', 'handoff', 'session'])
  for (const domain of new Set([...Object.keys(prior), ...Object.keys(next)])) {
    if (!allowed.has(domain)) {
      if (!isDeepStrictEqual(next[domain], prior[domain])) {
        throw new Error('C2 scoped fault changed unrelated lane domain')
      }
      continue
    }
    const a = prior[domain] || {}, b = next[domain] || {}
    for (const scope of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (scope !== chatId && !isDeepStrictEqual(a[scope], b[scope])) {
        throw new Error('C2 scoped fault changed sibling lane')
      }
    }
  }
  return true
}

// This commits only the scoped reducer transition. It does not close a live
// runtime, send notices, or reopen ingress; those require runtime-level
// per-chat capabilities. The caller must keep the instance sealed until a
// separate scoped recovery path is proven.
function commitScopedActiveFault({ journal, snapshot, turn, assertWriterLock } = {}) {
  if (!(journal instanceof C2DurableJournal) || !snapshot ||
      !turn || typeof turn.chatId !== 'string' || !turn.chatId ||
      typeof assertWriterLock !== 'function' ||
      assertWriterLock.constructor?.name === 'AsyncFunction' ||
      assertWriterLock() !== true ||
      !isDeepStrictEqual(journal.snapshot(), snapshot)) {
    throw new Error('C2 scoped fault authority invalid')
  }
  const chatId = turn.chatId
  const active = inventory(snapshot).activeTurns.filter(item => item.chatId === chatId)
  if (active.length !== 1 || active[0].turnToken !== turn.turnToken) {
    throw new Error('C2 scoped fault target turn invalid')
  }
  const [proven] = activeFaultTurns(snapshot, journal, active, [turn])
  const eventId = `sbot-c2-scoped-fault-v1:${snapshot.cursor}:${chatId}`
  if (Buffer.byteLength(eventId) > 256 || journal.hasEvent(eventId)) {
    throw new Error('C2 scoped fault event identity invalid')
  }
  const coordinator = new EngineStepCoordinator({ journal })
  const prepared = coordinator.prepare({ id: eventId, domain: 'scopedFault',
    scope: chatId, payload: { type: 'abandonActiveTurn',
      externalEffectsReconciled: true, turn: proven },
    validate: result => validateScopedFaultResult(snapshot, result,
      chatId, proven, eventId) })
  if (assertWriterLock() !== true ||
      !isDeepStrictEqual(journal.snapshot(), snapshot)) {
    prepared.cancel()
    throw new Error('C2 scoped fault authority changed before commit')
  }
  const committed = prepared.commit()
  const after = journal.snapshot()
  if (after.cursor !== snapshot.cursor + 1 || !journal.hasEvent(eventId) ||
      !isDeepStrictEqual(after.state, committed.state) ||
      !isDeepStrictEqual(after.receipts, snapshot.receipts) ||
      !isDeepStrictEqual(after.effects, snapshot.effects) ||
      !isDeepStrictEqual(after.notices, snapshot.notices)) {
    throw new Error('C2 scoped fault durable commit unverified')
  }
  return committed
}

// A read-only adapter keeps callers from treating the global close/rebuild as
// a scoped operation. C2DurableRuntime.close() drops every chat's live runner
// witness and open() recovers every chat, so invoking either for one chat is
// unsafe until the runtime and startup gate have explicit scoped authority.
function assessC2ScopedFault({ runtime, journal, chatId } = {}) {
  if (!(runtime instanceof C2DurableRuntime) ||
      !(journal instanceof C2DurableJournal) ||
      typeof chatId !== 'string' || !chatId) {
    throw new TypeError('C2 scoped fault needs runtime, journal and chat ID')
  }
  const snapshot = journal.snapshot()
  inventory(snapshot)
  if (!isDeepStrictEqual(runtime.snapshot(), snapshot)) {
    return Object.freeze({ status: 'blocked', reason: 'authority-mismatch', chatId })
  }
  return Object.freeze({ status: 'blocked', reason: 'scoped-runtime-recovery-unavailable',
    chatId })
}

function positiveLimit(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 4096) {
    throw new TypeError(`C2 global fault ${name} invalid`)
  }
  return value
}

function multipleVisiblePending(receipts) {
  const seen = new Set()
  for (const receipt of receipts.pending) {
    if (receipt.quiet) continue
    if (seen.has(receipt.chatId)) return true
    seen.add(receipt.chatId)
  }
  return false
}

function inventory(snapshot) {
  validatePersistentReceipts(snapshot.receipts)
  validatePersistentRelation(snapshot.state, snapshot.receipts)
  if (snapshot.cursor !== snapshot.state.seq) {
    throw new Error('C2 global fault cursor differs from durable state')
  }
  const lanes = snapshot.state.lanes
  const groups = new Set(snapshot.receipts.pending.map(item => item.chatId))
  const active = []
  for (const chatId of new Set([
    ...Object.keys(lanes.turn || {}), ...Object.keys(lanes.handoff || {}),
    ...Object.keys(lanes.lifecycle || {}),
  ])) {
    const turn = lanes.turn?.[chatId]
    const handoff = lanes.handoff?.[chatId]
    const lifecycle = lanes.lifecycle?.[chatId]
    if (turn?.active != null || handoff?.phase && handoff.phase !== 'idle' ||
        lifecycle?.busy === true || lifecycle?.controller === true) {
      active.push({ chatId, turnToken: turn?.active ?? handoff?.turnToken ?? null })
      groups.add(chatId)
    }
  }
  for (const chatId of Object.keys(lanes.queue || {})) groups.add(chatId)
  active.sort((a, b) => a.chatId.localeCompare(b.chatId))
  return Object.freeze({ pendingCount: snapshot.receipts.pending.length,
    groups: [...groups].sort(), activeTurns: active,
    unresolvedEffects: [...snapshot.effects.values()].filter(status => status !== 'acked').length,
    ambiguousNotices: [...snapshot.notices.values()].filter(item =>
      item.status === 'attempting' || item.status === 'unknown').length })
}

// Explicit daemon fault boundary. A running turn can be abandoned only after
// every runner close and outward effect has durable proof, under the single
// writer lock. Otherwise it remains sealed and requires a nonzero exit.
// Fresh startup then handles residual receipts and notifications once.
async function coordinateC2GlobalFault({ runtime, journal, assertWriterLock,
  abortTurn, createAuthority, activeTurnProofs = null,
  maxReceipts = 64, maxGroups = 32 } = {}) {
  if (!(runtime instanceof C2DurableRuntime) ||
      !(journal instanceof C2DurableJournal) ||
      typeof assertWriterLock !== 'function' ||
      assertWriterLock.constructor?.name === 'AsyncFunction' ||
      typeof abortTurn !== 'function' ||
      abortTurn.constructor?.name === 'AsyncFunction' ||
      typeof createAuthority !== 'function' ||
      createAuthority.constructor?.name === 'AsyncFunction') {
    throw new TypeError('C2 global fault needs explicit durable authority and synchronous controls')
  }
  positiveLimit(maxReceipts, 'receipt limit')
  positiveLimit(maxGroups, 'group limit')

  // Close before reading or invoking any callback. Late platform ingress or
  // model callbacks must be rejected while every group is being inspected.
  runtime.close()
  const exit = (reason, observed = null) => Object.freeze({ status: 'exit',
    exitCode: 1, reason, inventory: observed, runtime: null, journal: null })
  let observed
  try {
    if (assertWriterLock() !== true) return exit('writer-lock-lost')
    let snapshot = journal.snapshot()
    if (!isDeepStrictEqual(runtime.snapshot(), snapshot)) return exit('authority-mismatch')
    let journalBytes = journal.byteLength
    observed = inventory(snapshot)
    if (runtime.blocked !== true || journal.blocked) return exit('authority-not-sealed', observed)
    if (observed.pendingCount > maxReceipts || observed.groups.length > maxGroups) {
      return exit('fault-work-exceeds-bound', observed)
    }
    // Recovery records and ACKs one notice per receipt. Until a single group
    // notice can settle siblings atomically, do not issue two visible notices
    // to the same group after a process-wide fault.
    if (multipleVisiblePending(snapshot.receipts)) {
      return exit('multiple-visible-receipts', observed)
    }
    if (observed.activeTurns.length) {
      let allAborted = true
      for (const turn of observed.activeTurns) {
        try { if (abortTurn(turn) !== true) allAborted = false }
        catch { allAborted = false }
        // The abort callback is process-local, but it may synchronously lose
        // the lease or touch the shared authority. Never use the pre-abort
        // snapshot as proof after either change.
        if (assertWriterLock() !== true) return exit('active-turn-proof-unverified', observed)
        if (journal.byteLength !== journalBytes ||
            !isDeepStrictEqual(journal.snapshot(), snapshot)) {
          return exit('authority-changed-during-abort', observed)
        }
      }
      if (!allAborted) return exit('active-turn-abort-unconfirmed', observed)
      if (activeTurnProofs === null) return exit('active-turn-unrestorable', observed)
      try {
        const turns = activeFaultTurns(snapshot, journal,
          observed.activeTurns, activeTurnProofs)
        if (assertWriterLock() !== true) return exit('writer-lock-lost', observed)
        commitActiveFault({ journal, snapshot, turns, assertWriterLock })
        if (assertWriterLock() !== true) return exit('writer-lock-lost', observed)
        snapshot = journal.snapshot()
        journalBytes = journal.byteLength
        observed = inventory(snapshot)
        if (observed.activeTurns.length || observed.unresolvedEffects ||
            observed.ambiguousNotices) return exit('active-fault-commit-unresolved', observed)
      } catch {
        return exit('active-turn-proof-unverified', observed)
      }
    }
    if (observed.ambiguousNotices || observed.unresolvedEffects &&
        !Object.values(snapshot.state.lanes.queue || {}).some(lane => lane.queue?.length)) {
      return exit('external-outcome-unresolved', observed)
    }
    if (assertWriterLock() !== true) return exit('writer-lock-lost', observed)

    // The replacement must carry this same lease check into every awaited
    // startup notification, and must reject sibling visible notices per group.
    const replacement = createAuthority(assertWriterLock)
    if (assertWriterLock() !== true) {
      replacement?.runtime?.close?.()
      return exit('rebuild-not-ready', observed)
    }
    if (journal.byteLength !== journalBytes ||
        !isDeepStrictEqual(journal.snapshot(), snapshot)) {
      replacement?.runtime?.close?.()
      return exit('authority-changed-before-rebuild', observed)
    }
    if (!replacement || replacement.runtime === runtime ||
        !(replacement.runtime instanceof C2DurableRuntime) ||
        replacement.journal === journal ||
        !(replacement.journal instanceof C2DurableJournal) ||
        replacement.runtime.blocked !== true ||
        replacement.runtime.hasRecoveryPolicy({ assertWriterLock,
          singleNoticePerGroup: true }) !== true ||
        !isDeepStrictEqual(replacement.journal.snapshot(), snapshot) ||
        !isDeepStrictEqual(replacement.runtime.snapshot(), snapshot)) {
      replacement?.runtime?.close?.()
      return exit('fresh-authority-unverified', observed)
    }
    try {
      await replacement.runtime.open()
      if (assertWriterLock() !== true || replacement.runtime.blocked ||
          replacement.journal.blocked ||
          !isDeepStrictEqual(replacement.runtime.snapshot(),
            replacement.journal.snapshot())) {
        replacement.runtime.close()
        return exit('rebuild-not-ready', observed)
      }
      const recovered = inventory(replacement.journal.snapshot())
      if (recovered.pendingCount || recovered.activeTurns.length ||
          recovered.unresolvedEffects || recovered.ambiguousNotices) {
        replacement.runtime.close()
        return exit('rebuild-left-work', recovered)
      }
      return Object.freeze({ status: 'recovered', exitCode: 0, reason: null,
        inventory: recovered, runtime: replacement.runtime,
        journal: replacement.journal })
    } catch {
      replacement.runtime.close()
      return exit('rebuild-failed', inventory(replacement.journal.snapshot()))
    }
  } catch {
    return exit('fault-audit-failed', observed || null)
  }
}

module.exports = { coordinateC2GlobalFault, validateScopedFaultResult,
  assessC2ScopedFault, commitScopedActiveFault }
