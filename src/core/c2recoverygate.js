'use strict'

const { isDeepStrictEqual } = require('node:util')
const { recoverMissingPayload } = require('./c2startuprecovery')
const { pruneConfirmedTerminal } = require('./c2terminalprune')
const { validatePersistentReceipts, validatePersistentRelation } = require('./c2persistrelation')

const STARTUP_EFFECT = /^sbot-c2-effect-v1:(\d+):(sbot-c2-startup-queue-v1:.+):0$/
const FEISHU_REPLY_ID = /^om_[A-Za-z0-9_-]{1,124}$/

function validTime(value) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new TypeError('C2 startup time invalid')
  return value
}

function startupEffect(effectId, journal) {
  const match = STARTUP_EFFECT.exec(effectId)
  return !!match && Number(match[1]) === Buffer.byteLength(match[2]) &&
    journal.hasEvent(match[2])
}

function startupEffectForScope(effectId, journal, scope) {
  const match = STARTUP_EFFECT.exec(effectId)
  return !!match && startupEffect(effectId, journal) &&
    match[2].startsWith(`sbot-c2-startup-queue-v1:${scope}:`)
}

function siblingProjection(snapshot, scope, journal, ownIds) {
  const lanes = {}
  for (const [domain, byScope] of Object.entries(snapshot.state.lanes)) {
    lanes[domain] = Object.fromEntries(Object.entries(byScope)
      .filter(([chatId]) => chatId !== scope))
  }
  const siblingReceipts = {
    pending: snapshot.receipts.pending.filter(item => item.chatId !== scope),
    completed: snapshot.receipts.completed.filter(item => !ownIds.has(item.id)),
  }
  const effects = new Map([...snapshot.effects].filter(([id]) =>
    journal.effectDescriptor(id)?.scope !== scope &&
    !startupEffectForScope(id, journal, scope)))
  const notices = new Map([...snapshot.notices].filter(([id]) => !ownIds.has(id)))
  return { lanes, receipts: siblingReceipts, effects, notices }
}

function assertSiblingsUnchanged(before, after, scope, journal) {
  const ownIds = new Set(before.receipts.pending.filter(item => item.chatId === scope)
    .map(item => item.id))
  if (!isDeepStrictEqual(siblingProjection(before, scope, journal, ownIds),
    siblingProjection(after, scope, journal, ownIds))) {
    throw new Error('C2 scoped recovery changed sibling durable state')
  }
}

function assertAuthority(journal, coordinator) {
  const snapshot = journal.snapshot()
  validatePersistentReceipts(snapshot.receipts)
  validatePersistentRelation(snapshot.state, snapshot.receipts)
  if (snapshot.cursor !== snapshot.state.seq ||
      !isDeepStrictEqual(coordinator.snapshot(), snapshot.state)) {
    throw new Error('C2 startup state differs from durable authority')
  }
  return snapshot
}

function unstartedEventId(proof) {
  return `sbot-c2-runner-not-started-commit-v1:${proof.receiptId}:${proof.turnToken}:${proof.generation}`
}

function provedNotStartedEffect(effectId, journal) {
  if (journal.effectStatus(effectId) !== 'notStarted') return false
  const proofs = journal.runnerNotStartedProofs().filter(item =>
    item.dispatchEffectId === effectId)
  return proofs.length === 1 && journal.hasEvent(unstartedEventId(proofs[0]))
}

function resumeUnstartedDispatch(journal, coordinator, scope, assertLease) {
  for (const proof of journal.runnerNotStartedProofs()) {
    if (scope !== null && proof.chatId !== scope) continue
    const eventId = unstartedEventId(proof)
    if (journal.hasEvent(eventId)) continue
    assertLease()
    const before = assertAuthority(journal, coordinator)
    const descriptor = journal.effectDescriptor(proof.dispatchEffectId)
    if (journal.effectStatus(proof.dispatchEffectId) !== 'notStarted' ||
        descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
        descriptor.scope !== proof.chatId || descriptor.receiptId !== proof.receiptId ||
        descriptor.turnToken !== proof.turnToken ||
        !before.receipts.pending.some(item => item.id === proof.receiptId &&
          item.chatId === proof.chatId) ||
        before.state.lanes.turn?.[proof.chatId]?.active !== proof.turnToken ||
        before.state.lanes.handoff?.[proof.chatId]?.phase !== 'running') {
      throw new Error('C2 startup not-started proof differs from active dispatch')
    }
    const result = coordinator.transition({ id: eventId,
      domain: 'runnerStartFailure', scope: proof.chatId,
      payload: { type: 'abortUnstartedDispatch', receiptId: proof.receiptId,
        turnToken: proof.turnToken, runnerGeneration: proof.generation,
        dispatchEffectId: proof.dispatchEffectId,
        notStartedEvidenceId: proof.evidenceId },
      validate: candidate => {
        if (candidate.effects.length ||
            !isDeepStrictEqual(candidate.decision,
              { abandonedReceiptId: proof.receiptId,
                requiresStartupRecovery: true, scope: proof.chatId,
                dispatchEffectId: proof.dispatchEffectId })) {
          throw new Error('C2 startup not-started decision invalid')
        }
      } })
    const after = assertAuthority(journal, coordinator)
    if (result.decision.requiresStartupRecovery !== true ||
        !isDeepStrictEqual(before.receipts, after.receipts) ||
        after.state.lanes.turn?.[proof.chatId]?.active !== null ||
        after.state.lanes.handoff?.[proof.chatId]?.phase !== 'idle') {
      throw new Error('C2 startup not-started transition changed receipts')
    }
  }
}

// A process restart has no runner, controller, body or scheduled handoff
// capability. Even an atomically settled terminal receipt cannot make an old
// running turn safe to resume or let its successor begin automatically.
function assertNoUnrestorableRun(snapshot, scope = null) {
  const scoped = byScope => scope === null ? Object.values(byScope || {}) :
    Object.hasOwn(byScope || {}, scope) ? [byScope[scope]] : []
  if (scoped(snapshot.state.lanes.stopIntent).length ||
      scoped(snapshot.state.lanes.turn).some(lane => lane.active !== null) ||
      scoped(snapshot.state.lanes.handoff).some(lane => lane.phase !== 'idle') ||
      scoped(snapshot.state.lanes.lifecycle).some(lane =>
        lane.busy === true || lane.controller === true)) {
    throw new Error('C2 startup has unrecoverable running turn or handoff')
  }
}

// The current journal settles one receipt per confirmed notice. Until it can
// atomically settle several receipts from one group, a restart may send at
// most one nonquiet notification per group. Ambiguous siblings stay sealed.
function assertUniqueGroupNotices(snapshot, scope = null) {
  const seen = new Set()
  for (const receipt of snapshot.receipts.pending) {
    if (scope !== null && receipt.chatId !== scope) continue
    if (receipt.quiet) continue
    if (seen.has(receipt.chatId)) {
      throw new Error('C2 startup has multiple visible receipts in one group')
    }
    seen.add(receipt.chatId)
  }
}

// Read-only precondition for any future per-chat startup recovery. This does
// not open the global gate, send notices, settle receipts or change a sibling.
// A scoped writer must supply a separate queue interruption and notice path.
function assessScopedRecovery(journal, coordinator, chatId) {
  if (typeof chatId !== 'string' || !chatId ||
      !journal || typeof journal.snapshot !== 'function' ||
      typeof coordinator?.snapshot !== 'function') {
    throw new TypeError('C2 scoped recovery needs chat ID and durable authority')
  }
  const snapshot = assertAuthority(journal, coordinator)
  const lanes = snapshot.state.lanes
  const own = snapshot.receipts.pending.filter(item => item.chatId === chatId)
  const visible = own.filter(item => !item.quiet)
  if (visible.length > 1) throw new Error('C2 scoped recovery has multiple visible receipts')
  if (lanes.turn?.[chatId]?.active != null ||
      lanes.handoff?.[chatId]?.phase && lanes.handoff[chatId].phase !== 'idle' ||
      lanes.lifecycle?.[chatId]?.busy === true ||
      lanes.lifecycle?.[chatId]?.controller === true) {
    throw new Error('C2 scoped recovery has unrecoverable target turn')
  }
  // Unknown external outcomes anywhere in the same journal keep the writer
  // sealed. In particular, a scoped notification cannot safely infer whether
  // another chat has already emitted a reply after an ACK was lost.
  if ([...snapshot.effects.values()].some(status => status !== 'acked') ||
      [...snapshot.notices.values()].some(notice =>
        notice.status === 'attempting' || notice.status === 'unknown')) {
    throw new Error('C2 scoped recovery has unresolved external outcome')
  }
  if (lanes.queue?.[chatId]?.queue?.length) {
    throw new Error('C2 scoped recovery needs scoped queue interruption')
  }
  return Object.freeze({ chatId, pendingReceiptCount: own.length,
    siblingPendingReceiptCount: snapshot.receipts.pending.length - own.length,
    cursor: snapshot.cursor, canOpen: false,
    reason: 'scoped-ingress-and-settlement-unavailable' })
}

// Development-only startup gate. The caller owns the daemon single-writer
// lock and a platform sender that returns a confirmed reply ID. A begun notice
// whose outcome is lost remains ambiguous on disk and is never retried here.
async function recoverAndOpen({ gate, journal, coordinator, resolveTarget, send,
  now = Date.now, assertWriterLock = null, singleNoticePerGroup = false,
  scope = null } = {}) {
  if (!gate || typeof gate.close !== 'function' || typeof gate.open !== 'function' ||
      typeof gate.isClosed !== 'function' || !journal ||
      !['snapshot', 'hasEvent', 'effectStatus', 'effectDescriptor',
        'runnerNotStartedProofs', 'terminalSettlement',
        'noticeStatus', 'beginNotice',
        'recordNoticeOutcome', 'settleQuietReceipt', 'recordEffect'].every(name =>
        typeof journal[name] === 'function') ||
      !coordinator || typeof coordinator.snapshot !== 'function' ||
      typeof coordinator.transition !== 'function' ||
      typeof resolveTarget !== 'function' || typeof send !== 'function' ||
      typeof now !== 'function' ||
      (assertWriterLock !== null && typeof assertWriterLock !== 'function') ||
      typeof singleNoticePerGroup !== 'boolean') {
    throw new TypeError('C2 recovery gate needs durable authority and confirmed sender')
  }
  if (scope !== null && (typeof scope !== 'string' ||
      !/^[A-Za-z0-9_-]{1,128}$/.test(scope) || gate.scope !== scope ||
      typeof assertWriterLock !== 'function')) {
    throw new TypeError('C2 scoped recovery needs matching scoped gate and writer lock')
  }
  const assertLease = () => {
    if (assertWriterLock && assertWriterLock() !== true) {
      throw new Error('C2 startup writer lock lost')
    }
  }
  gate.close()
  if (gate.isClosed() !== true) throw new Error('C2 startup ingress is not closed')

  assertLease()
  resumeUnstartedDispatch(journal, coordinator, scope, assertLease)
  const beforeRecovery = assertAuthority(journal, coordinator)
  assertNoUnrestorableRun(beforeRecovery, scope)
  if (singleNoticePerGroup) assertUniqueGroupNotices(beforeRecovery, scope)
  if (scope !== null && ([...beforeRecovery.effects].some(([effectId, status]) =>
    status !== 'acked' && !provedNotStartedEffect(effectId, journal) &&
      (status !== 'pending' || !startupEffectForScope(effectId, journal, scope))) ||
      [...beforeRecovery.notices.values()].some(notice =>
        notice.status === 'attempting' || notice.status === 'unknown'))) {
    throw new Error('C2 scoped recovery has unresolved external outcome')
  }
  assertLease()
  recoverMissingPayload({ gate, journal, coordinator, scope })
  const initial = assertAuthority(journal, coordinator)
  if (scope !== null) assertSiblingsUnchanged(beforeRecovery, initial, scope, journal)
  assertNoUnrestorableRun(initial, scope)
  if (singleNoticePerGroup) assertUniqueGroupNotices(initial, scope)
  assertLease()
  const pending = initial.receipts.pending.filter(item => scope === null || item.chatId === scope)
    .sort((a, b) =>
    a.chatId.localeCompare(b.chatId) || a.id.localeCompare(b.id))
  // Prove that all receipts can be completed without a queue or handoff owner.
  // Resolve every external target before the first durable notice intent.
  const hypothetical = { pending: initial.receipts.pending.filter(item =>
    scope !== null && item.chatId !== scope), completed: [
    ...initial.receipts.completed,
    ...pending.map(item => ({ id: item.id, settledAt: validTime(now()) })),
  ] }
  validatePersistentRelation(initial.state, hypothetical)
  const completed = new Map(initial.receipts.completed.map(item => [item.id, item.settledAt]))
  const terminalFinalIds = new Set(Object.values(initial.state.lanes.terminal || {})
    .filter(lane => lane.finalized).map(lane => lane.pendingEffectIds.at(-1)))
  for (const [effectId, status] of initial.effects) {
    const descriptor = journal.effectDescriptor(effectId)
    if (status === 'acked' && (terminalFinalIds.has(effectId) ||
        descriptor?.domain === 'terminal' &&
        ['finalReply', 'quietCompletion'].includes(descriptor.type))) {
      const settlement = journal.terminalSettlement(effectId)
      if (!descriptor || !settlement || settlement.effectId !== effectId ||
          settlement.receiptId !== descriptor.receiptId ||
          settlement.chatId !== descriptor.scope ||
          settlement.turnToken !== descriptor.turnToken ||
          completed.get(descriptor.receiptId) !== settlement.settledAt) {
        throw new Error('C2 terminal effect ACK lacks atomic receipt settlement')
      }
    }
    if (status !== 'acked' && !provedNotStartedEffect(effectId, journal) &&
        (status !== 'pending' || !startupEffect(effectId, journal) ||
        scope !== null && !startupEffectForScope(effectId, journal, scope))) {
      throw new Error('C2 startup has unresolved external effect')
    }
  }
  // A terminal ACK and its receipt may already have shared one fsynced record
  // when the process died before the separate, idempotent lane prune. Keep
  // ingress closed until each such lane is durably removed. No external send
  // or receipt settlement is needed for this cleanup.
  for (const terminalScope of (scope === null
    ? Object.keys(initial.state.lanes.terminal || {}).sort()
    : Object.hasOwn(initial.state.lanes.terminal || {}, scope) ? [scope] : [])) {
    assertLease()
    const lane = initial.state.lanes.terminal[terminalScope]
    const finalEffectId = lane.pendingEffectIds?.at(-1)
    if (!lane.finalized || !finalEffectId ||
        !journal.terminalSettlement(finalEffectId)) {
      throw new Error('C2 startup terminal lane lacks atomic settlement proof')
    }
    pruneConfirmedTerminal({ journal, coordinator, scope: terminalScope })
  }
  if (scope !== null) assertSiblingsUnchanged(initial,
    assertAuthority(journal, coordinator), scope, journal)
  const targets = new Map()
  for (const receipt of pending) {
    assertLease()
    if (receipt.quiet) continue
    if (journal.noticeStatus(receipt.id) !== null) {
      throw new Error('C2 startup notice attempt is ambiguous')
    }
    const target = await resolveTarget({ id: receipt.id, chatId: receipt.chatId,
      source: receipt.source, sourceId: receipt.sourceId })
    assertLease()
    const afterTarget = assertAuthority(journal, coordinator)
    if (scope !== null) assertSiblingsUnchanged(initial, afterTarget, scope, journal)
    if (!target || typeof target !== 'object' || Array.isArray(target) ||
        target.receiptId !== receipt.id || target.chatId !== receipt.chatId ||
        target.sourceId !== receipt.sourceId || !Object.hasOwn(target, 'replyCtx') ||
        target.replyCtx == null) {
      throw new Error('C2 startup notification target is unverified')
    }
    targets.set(receipt.id, target)
  }

  const settled = []
  for (const receipt of pending) {
    assertLease()
    if (!gate.isClosed()) throw new Error('C2 startup ingress opened during recovery')
    if (receipt.quiet) {
      journal.settleQuietReceipt({ receiptId: receipt.id, chatId: receipt.chatId,
        settledAt: validTime(now()) })
    } else {
      const attemptedAt = validTime(now())
      journal.beginNotice({ receiptId: receipt.id, chatId: receipt.chatId, attemptedAt })
      assertLease()
      let replyId
      try { replyId = await send({ id: receipt.id, chatId: receipt.chatId,
        source: receipt.source, sourceId: receipt.sourceId }, targets.get(receipt.id)) }
      catch { replyId = null }
      // If the lease was lost during the SDK call, keep the fsynced attempt
      // ambiguous. Another process must not treat its outcome as replayable.
      assertLease()
      const at = Math.max(attemptedAt, validTime(now()))
      if (typeof replyId !== 'string' || !FEISHU_REPLY_ID.test(replyId)) {
        journal.recordNoticeOutcome({ receiptId: receipt.id, chatId: receipt.chatId,
          status: 'unknown', resolvedAt: at })
        throw new Error('C2 startup notification outcome is unknown')
      }
      journal.recordNoticeOutcome({ receiptId: receipt.id, chatId: receipt.chatId,
        status: 'acked', settledAt: at })
    }
    const after = assertAuthority(journal, coordinator)
    if (scope !== null) assertSiblingsUnchanged(initial, after, scope, journal)
    if (after.receipts.pending.some(item => item.id === receipt.id) ||
        !after.receipts.completed.some(item => item.id === receipt.id)) {
      throw new Error('C2 startup receipt was not durably settled')
    }
    settled.push(receipt.id)
  }

  // The interruptMissingPayload effect is an internal recovery instruction.
  // It is complete only after all affected receipts have been settled.
  const beforeOpen = assertAuthority(journal, coordinator)
  for (const [effectId, status] of beforeOpen.effects) {
    assertLease()
    if (status === 'pending' && startupEffect(effectId, journal) &&
        (scope === null || startupEffectForScope(effectId, journal, scope))) {
      journal.recordEffect(effectId, 'acked')
    }
  }
  const final = assertAuthority(journal, coordinator)
  if (scope !== null) assertSiblingsUnchanged(initial, final, scope, journal)
  if (final.receipts.pending.some(item => scope === null || item.chatId === scope) ||
      (scope === null
        ? Object.values(final.state.lanes.queue || {}).some(lane => lane.queue.length)
        : (final.state.lanes.queue?.[scope]?.queue?.length || 0) > 0) ||
      (scope === null
        ? Object.keys(final.state.lanes.terminal || {}).length > 0
        : Object.hasOwn(final.state.lanes.terminal || {}, scope)) ||
      [...final.effects].some(([effectId, status]) =>
        status !== 'acked' && !provedNotStartedEffect(effectId, journal)) ||
      [...final.notices.values()].some(notice =>
        notice.status === 'attempting' || notice.status === 'unknown')) {
    throw new Error('C2 startup has unresolved durable work')
  }
  try {
    assertLease()
    gate.open()
    if (gate.isClosed() !== false) throw new Error('C2 startup ingress did not open')
    assertLease()
  } catch (error) {
    gate.close()
    throw error
  }
  return { settledReceiptIds: settled, ingressClosed: false }
}

module.exports = { recoverAndOpen, assessScopedRecovery }
