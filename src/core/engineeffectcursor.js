'use strict'

// C2 effect commit cursor. The binary adapter validates a transition before
// calling stage(); this journal stores only opaque IDs and confirmations. An
// unconfirmed external effect is ambiguous after a crash and is never replayed.
const { createHash } = require('node:crypto')

const ID = /^[0-9a-f]{32}$/
const MAX_EFFECTS = 1024
const MAX_BATCH_MEMBERS = 1024
const hash = (...parts) => createHash('sha256').update(parts.join('\0')).digest('hex').slice(0, 32)

function batchId(receiptIds) {
  if (!Array.isArray(receiptIds) || receiptIds.length < 2 || receiptIds.length > MAX_BATCH_MEMBERS ||
      receiptIds.some(id => !ID.test(id)) || new Set(receiptIds).size !== receiptIds.length) {
    throw new TypeError('invalid C2 batch members')
  }
  // Preserve dispatch order: two differently ordered prompts cannot share an
  // external effect identity even when they contain the same accepted inputs.
  return hash('sintbot-c2-batch-v2', String(receiptIds.length), ...receiptIds)
}

function batchStepId(receiptIds, ordinal) {
  if (!Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError('invalid C2 batch step identity')
  return hash('sintbot-c2-batch-step-v2', batchId(receiptIds), String(ordinal))
}

function batchEffectId(step, index) {
  if (!ID.test(step) || !Number.isSafeInteger(index) || index < 0 || index >= MAX_EFFECTS) {
    throw new TypeError('invalid C2 batch effect identity')
  }
  return hash('sintbot-c2-batch-effect-v2', step, String(index))
}

function stepId(taskId, ordinal) {
  if (!ID.test(taskId) || !Number.isSafeInteger(ordinal) || ordinal < 0) throw new TypeError('invalid C2 step identity')
  return hash('sintbot-c2-step-v1', taskId, String(ordinal))
}

function effectId(step, index) {
  if (!ID.test(step) || !Number.isSafeInteger(index) || index < 0 || index >= MAX_EFFECTS) {
    throw new TypeError('invalid C2 effect identity')
  }
  return hash('sintbot-c2-effect-v1', step, String(index))
}

function readCursor(state) {
  const cursor = Object.hasOwn(state, 'effectCursor') ? state.effectCursor : { version: 1, steps: [] }
  if (!cursor || ![1, 2].includes(cursor.version) || !Array.isArray(cursor.steps) ||
      Object.keys(cursor).some((key) => !['version', 'steps'].includes(key))) throw new TypeError('invalid C2 effect cursor')
  const seen = new Set(), seenBatches = new Set()
  for (const step of cursor.steps) {
    const isBatch = !!step && Object.hasOwn(step, 'receiptIds')
    const keys = isBatch ? ['id', 'batchId', 'receiptIds', 'ordinal', 'effects', 'confirmed']
      : ['id', 'taskId', 'ordinal', 'effects', 'confirmed', 'notifiedAt']
    if (!step || Object.keys(step).some((key) => !keys.includes(key)) ||
        !ID.test(step.id) || !Number.isSafeInteger(step.ordinal) || step.ordinal < 0 ||
        (isBatch ? cursor.version !== 2 || !Array.isArray(step.receiptIds) ||
          step.batchId !== batchId(step.receiptIds) || batchStepId(step.receiptIds, step.ordinal) !== step.id
          : !ID.test(step.taskId) || stepId(step.taskId, step.ordinal) !== step.id) ||
        seen.has(step.id) || (isBatch && seenBatches.has(step.batchId)) ||
        !Array.isArray(step.effects) || step.effects.length > MAX_EFFECTS ||
        !Array.isArray(step.confirmed) ||
        (step.notifiedAt !== undefined && (!Number.isSafeInteger(step.notifiedAt) || step.notifiedAt <= 0))) {
      throw new TypeError('invalid C2 effect cursor step')
    }
    seen.add(step.id)
    if (isBatch) seenBatches.add(step.batchId)
    const expected = step.effects.map((_, index) => isBatch ? batchEffectId(step.id, index) : effectId(step.id, index))
    if (new Set(step.effects).size !== step.effects.length ||
        expected.some((id, index) => id !== step.effects[index]) ||
        new Set(step.confirmed).size !== step.confirmed.length ||
        step.confirmed.some((id, index) => id !== step.effects[index])) {
      throw new TypeError('invalid C2 effect cursor IDs')
    }
  }
  return cursor
}

class EngineEffectCursor {
  constructor(journal, { now = Date.now } = {}) {
    if (!journal || typeof journal.commitState !== 'function' || typeof journal.snapshot !== 'function') {
      throw new TypeError('C2 effect cursor requires the shared receipt journal')
    }
    if (typeof now !== 'function') throw new TypeError('C2 effect cursor clock required')
    this.journal = journal
    this.now = now
    this.live = new Set() // only steps staged by this process may perform effects
    this.blocked = new Set() // an ambiguous external failure cannot be retried here
    this._read()
  }

  _read() {
    const disk = this.journal.snapshot()
    if (disk.seq !== this.journal.current.seq) throw new Error('C2 effect cursor has a stale journal owner')
    return readCursor(disk.state)
  }

  _save(cursor, sessionResetIntent = null) {
    this.journal.commitState({ ...this.journal.current.state, effectCursor: cursor },
      { sessionResetIntent })
  }

  _sessionResetIntent(step, receipts, identity) {
    if (!identity || !Number.isSafeInteger(identity.turnToken) || identity.turnToken <= 0 ||
        typeof identity.generation !== 'string' || !ID.test(identity.generation) ||
        identity.resetSessionAfter !== true || !['ok', 'no-reply'].includes(identity.status) ||
        Object.keys(identity).some(key => !['turnToken', 'generation', 'resetSessionAfter', 'status'].includes(key)) ||
        step.ordinal !== 0) {
      throw new TypeError('C2 session reset needs an eligible terminal and turn identity')
    }
    if (this.journal.current.sessionResets.some(item =>
      item.chatId === receipts[0].chatId && item.effectId !== step.id)) {
      throw new Error('C2 group already has an unresolved session reset')
    }
    return { effectId: step.id, receiptIds: step.receiptIds || [step.taskId],
      chatId: receipts[0].chatId, turnToken: identity.turnToken,
      generation: identity.generation, phase: 'acked', status: identity.status }
  }

  _forgetSettled(steps) {
    for (const step of steps) {
      this.live.delete(step.id)
      this.blocked.delete(step.id)
    }
  }

  _receipt(taskId) {
    const receipt = this.journal.snapshot().pending.find((item) => item.id === taskId)
    if (!receipt) throw new Error('C2 effect has no durable target receipt')
    return receipt
  }

  _batchReceipts(receiptIds) {
    batchId(receiptIds)
    const byId = new Map(this.journal.snapshot().pending.map(receipt => [receipt.id, receipt]))
    const receipts = receiptIds.map(id => byId.get(id))
    if (receipts.some(receipt => !receipt)) throw new Error('C2 batch effect has no durable target receipt')
    if (new Set(receipts.map(receipt => receipt.chatId)).size !== 1) {
      throw new Error('C2 batch members must belong to one group')
    }
    return receipts
  }

  // Call only after the reducer output and all effect IDs have been validated.
  // The effect count is projected from that output; no payload is stored.
  stage(taskId, ordinal, effectCount, { sessionReset = null } = {}) {
    if (!Number.isSafeInteger(effectCount) || effectCount < 0 || effectCount > MAX_EFFECTS) {
      throw new TypeError('invalid C2 effect count')
    }
    const id = stepId(taskId, ordinal)
    const effects = Array.from({ length: effectCount }, (_, index) => effectId(id, index))
    const cursor = this._read()
    const receipt = this._receipt(taskId)
    if (sessionReset && effectCount !== 0) throw new Error('C2 reset intent requires final effect ACK')
    if (cursor.steps.some(step => step.receiptIds?.includes(taskId))) {
      throw new Error('C2 batch member is already bound to an effect')
    }
    const existing = cursor.steps.find((step) => step.id === id)
    if (existing) {
      if (existing.effects.length !== effectCount) throw new Error('C2 step identity changed its effects')
      if (sessionReset) {
        const expected = this._sessionResetIntent(existing, [receipt], sessionReset)
        if (!this.journal.current.sessionResets.some(item => JSON.stringify(item) === JSON.stringify(expected))) {
          throw new Error('C2 reset intent identity changed')
        }
      }
      return { id, effects: [...existing.effects], reused: true }
    }
    const nextStep = { id, taskId, ordinal, effects, confirmed: [] }
    this._save({ version: cursor.version, steps: [...cursor.steps, nextStep] },
      sessionReset ? this._sessionResetIntent(nextStep, [receipt], sessionReset) : null)
    this.live.add(id)
    return { id, effects, reused: false }
  }

  // A zero-effect batch records a confirmed silent terminal decision. If the
  // following atomic receipt settlement fails, startup can finish it quietly.
  stageBatch(receiptIds, ordinal, effectCount, { sessionReset = null } = {}) {
    if (!Number.isSafeInteger(effectCount) || effectCount < 0 || effectCount > MAX_EFFECTS) {
      throw new TypeError('invalid C2 batch effect count')
    }
    const shared = batchId(receiptIds)
    const members = [...receiptIds]
    const id = batchStepId(members, ordinal)
    const effects = Array.from({ length: effectCount }, (_, index) => batchEffectId(id, index))
    const cursor = this._read()
    const receipts = this._batchReceipts(members)
    if (sessionReset && effectCount !== 0) throw new Error('C2 reset intent requires final effect ACK')
    const existing = cursor.steps.find(step => step.id === id)
    if (existing) {
      if (existing.effects.length !== effectCount) throw new Error('C2 batch step identity changed its effects')
      if (sessionReset) {
        const expected = this._sessionResetIntent(existing, receipts, sessionReset)
        if (!this.journal.current.sessionResets.some(item => JSON.stringify(item) === JSON.stringify(expected))) {
          throw new Error('C2 reset intent identity changed')
        }
      }
      return { id, batchId: shared, receiptIds: members, effects: [...existing.effects], reused: true }
    }
    const memberSet = new Set(members)
    if (cursor.steps.some(step => step.receiptIds
      ? step.receiptIds.some(member => memberSet.has(member)) : memberSet.has(step.taskId))) {
      throw new Error('C2 batch member is already bound to an effect')
    }
    const nextStep = { id, batchId: shared, receiptIds: members, ordinal, effects, confirmed: [] }
    this._save({ version: 2, steps: [...cursor.steps, nextStep] },
      sessionReset ? this._sessionResetIntent(nextStep, receipts, sessionReset) : null)
    this.live.add(id)
    return { id, batchId: shared, receiptIds: members, effects, reused: false }
  }

  async apply(id, index, perform, { sessionReset = null } = {}) {
    if (typeof perform !== 'function') throw new TypeError('C2 effect performer required')
    const cursor = this._read()
    const step = cursor.steps.find((item) => item.id === id)
    if (!step || !Number.isSafeInteger(index) || index < 0 || index >= step.effects.length) {
      throw new TypeError('unknown C2 effect')
    }
    const effect = step.effects[index]
    if (sessionReset && index !== step.effects.length - 1) {
      throw new Error('C2 reset intent requires final effect ACK')
    }
    const resetIntent = sessionReset ? this._sessionResetIntent(step,
      step.receiptIds ? this._batchReceipts(step.receiptIds) : [this._receipt(step.taskId)], sessionReset) : null
    if (step.confirmed.includes(effect)) {
      if (resetIntent && !this.journal.current.sessionResets.some(item =>
        JSON.stringify(item) === JSON.stringify(resetIntent))) {
        throw new Error('C2 confirmed effect has no matching reset intent')
      }
      return { id: effect, status: 'already-confirmed' }
    }
    if (index !== step.confirmed.length) throw new Error('C2 effects must commit in order')
    if (!this.live.has(id) || this.blocked.has(id) || step.notifiedAt !== undefined) {
      throw new Error('C2 unconfirmed effect requires interruption notice')
    }
    try {
      if (await perform(effect) !== true) throw new Error('C2 effect was not confirmed')
      const fresh = this._read()
      const next = fresh.steps.map((item) => item.id === id
        ? { ...item, confirmed: [...item.confirmed, effect] } : item)
      this._save({ version: fresh.version, steps: next }, resetIntent)
      return { id: effect, status: 'confirmed' }
    } catch (error) {
      this.blocked.add(id)
      throw error
    }
  }

  unconfirmed() {
    return this._read().steps.filter((step) => step.notifiedAt === undefined)
      .map((step) => ({ id: step.id,
        ...(step.receiptIds ? { batchId: step.batchId, receiptIds: [...step.receiptIds] } : { taskId: step.taskId }),
        effects: step.effects.filter((id) => !step.confirmed.includes(id)) }))
      .filter((step) => step.effects.length)
  }

  snapshot() { return JSON.parse(JSON.stringify(this._read())) }

  // Call only AFTER the task receipt is settled. Reversing that order would
  // leave a crash window where the task can restart without its effect IDs.
  pruneConfirmedTask(taskId) {
    if (!ID.test(taskId)) throw new TypeError('invalid C2 task identity')
    const cursor = this._read()
    if (cursor.steps.some(step => step.receiptIds?.includes(taskId))) {
      throw new Error('C2 batch member requires atomic settlement')
    }
    const mine = cursor.steps.filter((step) => step.taskId === taskId)
    if (mine.some((step) => step.confirmed.length !== step.effects.length)) {
      throw new Error('C2 task still has unconfirmed effects')
    }
    if (mine.length && this.journal.snapshot().pending.some((item) => item.id === taskId)) {
      throw new Error('C2 task receipt is still pending')
    }
    if (mine.length) {
      this._save({ version: cursor.version, steps: cursor.steps.filter((step) => step.taskId !== taskId) })
      this._forgetSettled(mine)
    }
    return mine.length
  }

  // Normal terminal path: remove the accepted task receipt and all of its
  // confirmed effect IDs in ONE checkpoint write. A failed write leaves both
  // in place; neither half can disappear independently.
  settleConfirmedTask(taskId) {
    if (!ID.test(taskId)) throw new TypeError('invalid C2 task identity')
    const cursor = this._read()
    if (cursor.steps.some(step => step.receiptIds?.includes(taskId))) {
      throw new Error('C2 batch member requires atomic settlement')
    }
    const mine = cursor.steps.filter((step) => step.taskId === taskId)
    if (mine.some((step) => step.confirmed.length !== step.effects.length)) {
      throw new Error('C2 task still has unconfirmed effects')
    }
    this._receipt(taskId)
    const nextState = { ...this.journal.current.state, effectCursor: {
      version: cursor.version, steps: cursor.steps.filter((step) => step.taskId !== taskId),
    } }
    this.journal.settle(taskId, nextState)
    this._forgetSettled(mine)
    return mine.length
  }

  // Recovery-only terminal path. The caller must have a confirmed targeted
  // interruption notice (or a previously durable notifiedAt receipt). This
  // single checkpoint commit clears the receipt and every effect step.
  settleInterruptedTask(taskId, { noticeConfirmed = false } = {}) {
    if (noticeConfirmed !== true) throw new Error('C2 interruption notice is not confirmed')
    if (!ID.test(taskId)) throw new TypeError('invalid C2 task identity')
    const cursor = this._read()
    if (cursor.steps.some(step => step.receiptIds?.includes(taskId))) {
      throw new Error('C2 batch member requires atomic settlement')
    }
    this._receipt(taskId)
    const mine = cursor.steps.filter((step) => step.taskId === taskId)
    this.journal.settle(taskId, { ...this.journal.current.state, effectCursor: {
      version: cursor.version, steps: cursor.steps.filter((step) => step.taskId !== taskId),
    } })
    this._forgetSettled(mine)
    return mine.length
  }

  settleConfirmedBatch(receiptIds) {
    const shared = batchId(receiptIds)
    const members = [...receiptIds]
    const cursor = this._read()
    const mine = cursor.steps.filter(step => step.batchId === shared)
    if (!mine.length) throw new Error('unknown C2 batch effect')
    if (mine.some(step => step.confirmed.length !== step.effects.length)) {
      throw new Error('C2 batch still has unconfirmed effects')
    }
    this._batchReceipts(members)
    this.journal.settleBatch(members, { ...this.journal.current.state, effectCursor: {
      version: 2, steps: cursor.steps.filter(step => step.batchId !== shared),
    } })
    this._forgetSettled(mine)
    return mine.length
  }

  settleInterruptedBatch(receiptIds) {
    const shared = batchId(receiptIds)
    const members = [...receiptIds]
    const cursor = this._read()
    const mine = cursor.steps.filter(step => step.batchId === shared)
    if (!mine.length) throw new Error('unknown C2 batch effect')
    if (this._batchReceipts(members).some(receipt => receipt.notifiedAt === undefined)) {
      throw new Error('C2 batch interruption notices are not all confirmed')
    }
    this.journal.settleBatch(members, { ...this.journal.current.state, effectCursor: {
      version: 2, steps: cursor.steps.filter(step => step.batchId !== shared),
    } })
    this._forgetSettled(mine)
    return mine.length
  }

  // send() must confirm a targeted interruption notice. A failed or ambiguous
  // send leaves the step pending; a confirmed one is recorded before returning.
  async notifyUnconfirmed(send) {
    if (typeof send !== 'function') throw new TypeError('C2 interruption sender required')
    const results = []
    const unconfirmed = this.unconfirmed()
    if (unconfirmed.some(step => step.receiptIds)) {
      throw new Error('C2 batch effects require shared startup recovery')
    }
    const pending = unconfirmed.map((step) => ({ ...step, receipt: this._receipt(step.taskId) }))
    for (const step of pending) {
      try {
        const at = this.now()
        if (!Number.isSafeInteger(at) || at <= 0) throw new Error('C2 notification time required')
        if (await send({ id: step.id, taskId: step.taskId, effects: [...step.effects],
          target: { chatId: step.receipt.chatId, source: step.receipt.source,
            sourceId: step.receipt.sourceId } }) !== true) {
          throw new Error('C2 interruption notice was not confirmed')
        }
        const cursor = this._read()
        this._save({ version: cursor.version, steps: cursor.steps.map((item) => item.id === step.id
          ? { ...item, notifiedAt: at } : item) })
        this.live.delete(step.id)
        results.push({ id: step.id, status: 'notified' })
      } catch {
        this.blocked.add(step.id)
        results.push({ id: step.id, status: 'retry' })
      }
    }
    if (results.some((item) => item.status === 'retry')) {
      const error = new Error('C2 effect interruption notices remain pending')
      error.results = results
      throw error
    }
    return results
  }
}

module.exports = { EngineEffectCursor, stepId, effectId, batchId, batchStepId, batchEffectId, MAX_BATCH_MEMBERS }
