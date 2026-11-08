'use strict'

const fs = require('node:fs')
const path = require('node:path')
const { isDeepStrictEqual } = require('node:util')
const { StateStore } = require('./store')
const verify = require('./verify')

const LOCAL_TYPES = new Set(['clearTainted', 'clearExhausted', 'verifyTurn'])

function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) }
  catch (error) {
    if (error?.code === 'ENOENT') return null
    throw error
  }
}

// Service-dev resolves a local terminal effect against the accepted flat
// cohort. The effect belongs to the reply anchor, which is the final ordinary
// job; using jobs[0] would reject a valid multi-message successor after the
// effect had already been attempted.
function resolveC2LocalEffectTurn(engine, { chatId, receiptId, turnToken } = {}) {
  if (!engine || typeof chatId !== 'string' || !chatId ||
      !/^[0-9a-f]{32}$/.test(receiptId || '') ||
      !Number.isSafeInteger(turnToken) || turnToken <= 0) return null
  const rt = engine.rts?.get(chatId)
  const jobs = rt?.v2RunningJobs
  const binding = rt?.v2DispatchEffect
  const snapshot = engine.durableV2Runtime?.snapshot?.()
  if (!Array.isArray(jobs) || jobs.length < 1 || jobs.length > 2 ||
      jobs.some(job => !job?.msg || job.msg.batch || job.msg.synthetic ||
        job.msg.quiet || job.msg.chatId !== chatId ||
        !/^[0-9a-f]{32}$/.test(job.msg._c2ReceiptId || '')) ||
      !isDeepStrictEqual(binding?.receiptIds,
        jobs.map(job => job.msg._c2ReceiptId)) ||
      !isDeepStrictEqual(binding?.batchReceiptIds, binding.receiptIds) ||
      binding?.receiptIds?.at(-1) !== receiptId ||
      binding.turnToken !== turnToken || rt.v2TurnToken !== turnToken ||
      snapshot?.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
      snapshot.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
      !isDeepStrictEqual(snapshot.state.lanes.handoff[chatId].acceptedReceiptIds,
        jobs.length > 1 ? binding.receiptIds : []) ||
      jobs.some(job => {
        const receipt = snapshot.receipts?.pending?.find(item =>
          item.id === job.msg._c2ReceiptId)
        return receipt?.chatId !== chatId || receipt.source !== 'message' ||
          receipt.sourceId !== job.msg.msgId
      })) return null
  const job = jobs.at(-1)
  const { name, provider } = engine._resolveProvider(chatId, job.group)
  return name && provider
    ? { chatId, receiptId, turnToken, providerName: name, provider } : null
}

// The caller fsyncs beginEffectAttempt before claim(), then fsyncs ACK only
// after apply() returns true. A claimed attempt is one-use and process-local:
// an "attempting" effect found after restart cannot be claimed by this object.
// The journal never receives credentials, the reply body or Store data.
function createC2LocalEffectExecutor({ journal, store, resolveTurn,
  assertWriterLock, verifyFile, now = Date.now } = {}) {
  if (!journal || typeof journal.snapshot !== 'function' ||
      typeof journal.effectDescriptor !== 'function' ||
      typeof journal.effectStatus !== 'function' ||
      !(store instanceof StateStore) || typeof store.file !== 'string' ||
      typeof resolveTurn !== 'function' ||
      resolveTurn.constructor?.name === 'AsyncFunction' ||
      typeof assertWriterLock !== 'function' ||
      assertWriterLock.constructor?.name === 'AsyncFunction' ||
      typeof verifyFile !== 'string' || !path.isAbsolute(verifyFile) ||
      typeof now !== 'function') {
    throw new TypeError('C2 local effects need journal, Store, turn and writer authority')
  }
  const claims = new Set()
  const preexistingAttempts = new Set([...journal.snapshot().effects]
    .filter(([, status]) => status === 'attempting')
    .map(([effectId]) => effectId))

  function assertHeld() {
    if (assertWriterLock() !== true) throw new Error('C2 local effect writer lock lost')
  }

  function identity(effectId) {
    assertHeld()
    const descriptor = journal.effectDescriptor(effectId)
    if (!descriptor || descriptor.domain !== 'terminal' ||
        !LOCAL_TYPES.has(descriptor.type) ||
        typeof descriptor.scope !== 'string' || !descriptor.scope ||
        typeof descriptor.receiptId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(descriptor.receiptId) ||
        !Number.isSafeInteger(descriptor.turnToken) ||
        descriptor.turnToken <= 0 ||
        journal.effectStatus(effectId) !== 'attempting') {
      throw new Error('C2 local effect lacks a fresh terminal attempt')
    }
    const snapshot = journal.snapshot()
    const chatId = descriptor.scope
    const receipt = snapshot.receipts?.pending?.find(item =>
      item.id === descriptor.receiptId)
    const terminal = snapshot.state?.lanes?.terminal?.[chatId]
    const handoff = snapshot.state?.lanes?.handoff?.[chatId]
    if (receipt?.chatId !== chatId ||
        snapshot.state?.lanes?.turn?.[chatId]?.active !== descriptor.turnToken ||
        handoff?.phase !== 'running' ||
        handoff.turnToken !== descriptor.turnToken ||
        terminal?.finalized !== true ||
        !Array.isArray(terminal.pendingEffectIds) ||
        !terminal.pendingEffectIds.includes(effectId) ||
        snapshot.effects?.get(effectId) !== 'attempting') {
      throw new Error('C2 local effect differs from the active receipt')
    }
    return descriptor
  }

  function claim(effectId) {
    if (typeof effectId !== 'string' || claims.has(effectId) ||
        preexistingAttempts.has(effectId)) {
      throw new Error('C2 local effect attempt already claimed')
    }
    identity(effectId)
    claims.add(effectId)
  }

  function apply(effect) {
    if (!effect || typeof effect !== 'object' || Array.isArray(effect) ||
        typeof effect.effectId !== 'string' ||
        !claims.delete(effect.effectId)) {
      throw new Error('C2 local effect has no same-process claim')
    }
    const descriptor = identity(effect.effectId)
    const required = descriptor.type === 'verifyTurn'
      ? ['effectId', 'success', 'type'] : ['effectId', 'type']
    if (Object.keys(effect).sort().join(',') !== required.join(',') ||
        effect.type !== descriptor.type ||
        descriptor.type === 'verifyTurn' && effect.success !== true) {
      throw new Error('C2 local effect payload differs from durable descriptor')
    }
    const turn = resolveTurn({ chatId: descriptor.scope,
      receiptId: descriptor.receiptId, turnToken: descriptor.turnToken })
    if (!turn || turn.chatId !== descriptor.scope ||
        turn.receiptId !== descriptor.receiptId ||
        turn.turnToken !== descriptor.turnToken ||
        typeof turn.providerName !== 'string' || !turn.providerName ||
        !turn.provider || typeof turn.provider !== 'object') {
      throw new Error('C2 local effect turn identity unavailable')
    }
    const chatId = descriptor.scope
    if (effect.type === 'clearTainted') {
      store.clearTainted(chatId)
      const disk = readJson(store.file)
      if (store.isTainted(chatId) || disk?.groups?.[chatId]?.tainted) {
        throw new Error('C2 tainted state was not durably cleared')
      }
    } else if (effect.type === 'clearExhausted') {
      store.clearExhausted(turn.providerName)
      const disk = readJson(store.file)
      if (store.data.exhausted?.[turn.providerName] !== undefined ||
          disk?.exhausted?.[turn.providerName] !== undefined) {
        throw new Error('C2 exhausted state was not durably cleared')
      }
    } else {
      const fp = verify.providerFp(turn.provider)
      if (!fp) {
        if (turn.provider.baseUrl || turn.provider.apiKey) {
          throw new Error('C2 verification credential identity incomplete')
        }
      } else {
        const stamp = now()
        if (!Number.isSafeInteger(stamp) || stamp <= 0) {
          throw new Error('C2 verification time invalid')
        }
        verify.recordTurn(turn.provider, true, '', { file: verifyFile, now: stamp })
        const record = readJson(verifyFile)?.[fp]
        const recordedAt = Date.parse(record?.at || '')
        if (record?.ok !== true || record.reason ||
            !Number.isFinite(recordedAt) ||
            recordedAt < stamp - verify.REFRESH_MS || recordedAt > stamp + 1000) {
          throw new Error('C2 credential verification was not durably confirmed')
        }
      }
    }
    assertHeld()
    if (journal.effectStatus(effect.effectId) !== 'attempting') {
      throw new Error('C2 local effect attempt changed before ACK')
    }
    return true
  }

  apply.claim = claim
  return apply
}

module.exports = { createC2LocalEffectExecutor, resolveC2LocalEffectTurn }
