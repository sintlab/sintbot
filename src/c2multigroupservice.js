'use strict'

const { isC2InputRejection, answerC2InputRejection, rejectC2Input } = require('./core/c2inputrejection')
const { coordinateC2GlobalFault } = require('./core/c2globalfault')

const RECOVERING_NOTICE = '上一个任务出错，正在收尾，这条消息没有处理，请稍后重发。'
const HELD_NOTICE = '本群上一个任务结果不明，已暂停处理，等待人工确认；其他群不受影响。'
const UPGRADING_NOTICE = 'SintBot 正在升级，这条消息没有处理，请一分钟后重发。'
const reasonOf = error => String(error?.message || error || 'unknown').slice(0, 300)

// Turns a group binding still holds: a running turn, a non-idle handoff or a
// busy lifecycle. Scoped to one group's own journal.
function activeTurns(snapshot) {
  const lanes = snapshot.state.lanes
  const turns = []
  for (const chatId of new Set([...Object.keys(lanes.turn || {}),
    ...Object.keys(lanes.handoff || {}), ...Object.keys(lanes.lifecycle || {})])) {
    const turn = lanes.turn?.[chatId]
    const handoff = lanes.handoff?.[chatId]
    const lifecycle = lanes.lifecycle?.[chatId]
    if (turn?.active != null || handoff?.phase && handoff.phase !== 'idle' ||
        lifecycle?.busy === true || lifecycle?.controller === true) {
      turns.push({ chatId, turnToken: turn?.active ?? handoff?.turnToken ?? null })
    }
  }
  return turns.sort((a, b) => a.chatId.localeCompare(b.chatId))
}

const runtimesOf = binding => binding?.engine?.rts instanceof Map ? [...binding.engine.rts.values()] : []

// Process-local organization only. Each binding owns a distinct durable
// authority; the transport and writer lease belong to this single process.
// A fault that only one group's journal can explain holds that group: its
// sealed binding stays as evidence, nothing is replayed or retried, and every
// other group keeps serving. Only a shared resource (writer lease, transport,
// model capacity) stops the process. `holds` lists groups whose journal could
// not be opened before the service was created.
function createC2MultiGroupService({ routes, assertWriterLock,
  createTransport, createBinding, onFatal = () => {}, closeCapacity = () => {},
  quarantine = null, stopTimeoutMs = 2_000, drainTimeoutMs = 12_000,
  createRecoveryAuthority = null, holds = new Map(), sharedFault = () => null,
  ingressWaitMs = 60_000, onModelCard = null, now = Date.now, log = () => {} } = {}) {
  if (!Array.isArray(routes) || !routes.length ||
      new Set(routes.map(route => route.chatId)).size !== routes.length ||
      routes.some(route => !route || typeof route.chatId !== 'string' ||
        typeof route.file !== 'string') ||
      typeof assertWriterLock !== 'function' ||
      typeof createTransport !== 'function' || typeof createBinding !== 'function' ||
      typeof onFatal !== 'function' || typeof closeCapacity !== 'function' ||
      typeof log !== 'function' || typeof sharedFault !== 'function' ||
      typeof now !== 'function' || !(holds instanceof Map) ||
      [...holds.keys()].some(chatId => !routes.some(route => route.chatId === chatId)) ||
      createRecoveryAuthority !== null && typeof createRecoveryAuthority !== 'function' ||
      !Number.isSafeInteger(stopTimeoutMs) || stopTimeoutMs < 1 ||
      !Number.isSafeInteger(drainTimeoutMs) || drainTimeoutMs < 1 ||
      !Number.isSafeInteger(ingressWaitMs) || ingressWaitMs < 1) {
    throw new TypeError('C2 multi-group service needs explicit routes and controls')
  }
  const configured = new Map(routes.map(route => [route.chatId, route]))
  const bindings = new Map()
  // chatId -> { reason, source: 'startup' | 'runtime', since, binding }
  const suspended = new Map()
  // Set while a console upgrade switches the service: no message is admitted.
  let maintenance = false
  let transport = null
  let started = false
  let starting = false
  let transportStarted = false
  let stopPromise = null
  let failed = false
  let startupDone = null
  let startupComplete = false

  function held() {
    if (assertWriterLock() !== true) throw new Error('C2 service writer lock lost')
  }
  function writerHeld() {
    try { return assertWriterLock() === true } catch { return false }
  }
  async function bounded(operation, ms) {
    let timer
    try {
      return await Promise.race([Promise.resolve().then(operation),
        new Promise(resolve => { timer = setTimeout(() => resolve(false), ms) })])
    } catch { return false } finally { clearTimeout(timer) }
  }
  function stop(reason = 'operator-stop', code = 0) {
    if (stopPromise) return stopPromise
    started = false
    // Seal every authority synchronously before awaiting transport shutdown.
    closeCapacity()
    for (const binding of bindings.values()) {
      binding.gate.stop()
      binding.engine.shutdown()
    }
    const startupInProgress = !!startupDone && !startupComplete
    stopPromise = (async () => {
      // A signal can arrive while a recovery binding or socket start awaits.
      // Keep the lease until startup observes the closed state, then seal any
      // binding that finished after the initial synchronous sweep.
      const startupStopped = !startupInProgress || await bounded(
        () => startupDone.then(() => true), drainTimeoutMs) === true
      if (startupInProgress) {
        for (const binding of bindings.values()) {
          binding.gate.stop()
          binding.engine.shutdown()
        }
      }
      const platformStopped = !transportStarted || await bounded(
        () => transport.stopPlatform(), stopTimeoutMs) === true
      const drained = (await Promise.all([...bindings.values()].map(binding =>
        bounded(() => binding.engine.drainDurableV2(drainTimeoutMs), drainTimeoutMs + 100))))
        .every(value => value === true) && [...suspended.values()].every(entry =>
        runtimesOf(entry.binding).every(rt => !rt.v2Controller))
      return Object.freeze({ reason, code: code === 0 && startupStopped && platformStopped && drained ? 0 : 1,
        startupStopped, platformStopped, drained })
    })()
    return stopPromise
  }
  async function fatal(error) {
    if (failed) return stopPromise
    failed = true
    const result = await stop('C2 multi-group ingress failed', 1)
    await onFatal(error, result)
    return result
  }
  // Seal one group in place. Its binding and journal are kept unchanged as
  // evidence; a later restart reopens it only through the normal recovery
  // gate, or after its incident has been sealed by the operator.
  function suspend(chatId, error, { source, binding = null }) {
    if (suspended.has(chatId)) return suspended.get(chatId)
    const entry = Object.freeze({ reason: reasonOf(error), source, since: now(), binding })
    suspended.set(chatId, entry)
    for (const sealed of new Set([binding, bindings.get(chatId)])) {
      if (!sealed) continue
      try { sealed.gate.stop() } catch {}
      try { sealed.engine.shutdown() } catch {}
    }
    bindings.delete(chatId)
    log(`group ${chatId}: held (${entry.reason}); other groups keep serving`)
    return entry
  }
  function allowed(chatId) {
    const route = configured.get(chatId)
    if (!route || route.paused === true) return false
    // Once serving, every open route has a binding. A route still being
    // opened online is not served yet and its messages get no receipt.
    return !started || bindings.has(chatId)
  }
  const activating = new Map()
  const recovering = new Map()
  const failedBindings = new WeakSet()
  // Same bounded transition as the single-group entry: seal this binding,
  // wait for its runner to close, abandon the proved active turn with one
  // notice per receipt (never a retry), then open a fresh binding.
  function recoverGroup(chatId, binding, error) {
    if (recovering.has(chatId)) return recovering.get(chatId)
    if (failedBindings.has(binding) && bindings.get(chatId) !== binding) return Promise.resolve()
    failedBindings.add(binding)
    const route = configured.get(chatId)
    const work = (async () => {
      log(`group ${chatId}: closing failed turn (${error?.message || String(error)})`)
      binding.gate.stop()
      binding.engine.shutdown()
      await bounded(() => binding.engine.drainDurableV2(drainTimeoutMs), drainTimeoutMs + 100)
      const quiescent = [...binding.engine.rts.values()].every(rt =>
        !rt.v2Controller && !rt.v2NormalRouteActive && !rt.v2Compacting)
      if (!quiescent || !writerHeld() || !route) throw new Error('C2 group fault is not quiescent')
      const turns = activeTurns(binding.journal.snapshot())
      const proofs = turns.length ? binding.engine.durableV2ActiveFaultProofs?.(turns) || null : null
      const result = await coordinateC2GlobalFault({ runtime: binding.runtime,
        journal: binding.journal, assertWriterLock,
        abortTurn: turn => binding.engine.abortDurableV2FaultTurn?.(turn) === true,
        activeTurnProofs: proofs,
        createAuthority: lock => createRecoveryAuthority({ route, transport, assertWriterLock: lock }) })
      if (result.status !== 'recovered' || !writerHeld()) {
        throw new Error(`C2 group recovery sealed: ${result.reason || 'writer lock lost'}`)
      }
      result.runtime.close()
      if (!started || stopPromise) throw new Error('C2 service stopped during group recovery')
      const next = await createBinding({ route, transport, journal: result.journal })
      if (!next || !next.gate || !next.engine || next.gate.blocked || !writerHeld()) {
        next?.gate?.stop?.(); next?.engine?.shutdown?.()
        throw new Error('C2 group binding did not reopen after recovery')
      }
      bindings.set(chatId, next)
      log(`group ${chatId}: failed turn closed; group reopened`)
    })()
    recovering.set(chatId, work)
    work.then(() => recovering.delete(chatId), () => recovering.delete(chatId))
    return work
  }
  // One group's route, recall or ingress failed. Close the failed turn when
  // its journal proves every effect; otherwise hold the group alone. Returns
  // 'recovered', 'held', 'fatal' (process stop begun) or 'stopping'.
  async function groupFault(chatId, binding, error) {
    const shared = () => !writerHeld() ? 'writer lock lost' : sharedFault()
    if (shared()) { await fatal(error); return 'fatal' }
    if (!started || stopPromise) return 'stopping'
    if (suspended.has(chatId)) return 'held'
    const current = bindings.get(chatId)
    if (!binding || current !== binding && !failedBindings.has(binding)) {
      // An error from a binding this service never published is not attributable.
      await fatal(error); return 'fatal'
    }
    if (!createRecoveryAuthority) { await fatal(error); return 'fatal' }
    try {
      await recoverGroup(chatId, binding, error)
    } catch (failure) {
      log(`group ${chatId}: failed turn could not be closed: ${reasonOf(failure)}`)
      if (shared()) { await fatal(failure); return 'fatal' }
      if (!started || stopPromise) return 'stopping'
      suspend(chatId, failure, { source: 'runtime', binding })
    }
    return suspended.has(chatId) ? 'held' : 'recovered'
  }
  function heldReply(msg, sourceAdapter) {
    return answerC2InputRejection({ error: rejectC2Input('C2 group held',
      { reason: 'group-held', notice: HELD_NOTICE }), msg, platform: sourceAdapter, log })
  }
  // Open one more group on the live transport: a newly added route or one
  // paused since startup. It runs the same recovery gate as startup; only a
  // fully opened binding is published. Failure leaves the group unserved.
  function addRoute(route) {
    if (!route || typeof route.chatId !== 'string' || typeof route.file !== 'string') {
      return Promise.reject(new TypeError('C2 online route needs an explicit group and journal'))
    }
    if (suspended.has(route.chatId)) {
      return Promise.reject(new Error('This group is held after an unresolved fault; seal its incident and restart'))
    }
    if (bindings.has(route.chatId)) return Promise.resolve(bindings.get(route.chatId))
    if (activating.has(route.chatId)) return activating.get(route.chatId)
    const opening = (async () => {
      if (!started || starting || stopPromise || maintenance) throw new Error('C2 service is not serving')
      held()
      const binding = await createBinding({ route, transport })
      if (!started || stopPromise || !writerHeld() || suspended.has(route.chatId) ||
          !binding || !binding.gate || !binding.engine || binding.gate.blocked) {
        binding?.gate?.stop?.()
        binding?.engine?.shutdown?.()
        throw new Error('C2 group binding did not open its durable authority')
      }
      configured.set(route.chatId, route)
      bindings.set(route.chatId, binding)
      log(`group ${route.chatId}: opened online`)
      return binding
    })()
    activating.set(route.chatId, opening)
    opening.then(() => activating.delete(route.chatId), () => activating.delete(route.chatId))
    return opening
  }
  // A reply or card operation awaiting its platform response blocks the
  // durable authority only for that moment: blocked, but not closed.
  const closedForGood = runtime => (runtime?.closed ?? runtime?.blocked) === true
  const effectInFlight = runtime => runtime?.blocked === true && runtime?.closed === false
  // Per-group ingress order. The platform runs every inbound event on its own
  // listener and does not await this route, so messages of one group can reach
  // it concurrently. A message that finds its group blocked only by an
  // in-flight effect waits for that effect (polling, bounded) instead of being
  // refused, and every later message of that group queues behind it in arrival
  // order until it has been handed to admission or answered. Other groups
  // never wait, and a group with nothing waiting takes the direct path.
  // chatId -> { tail, waiting: msgId -> count, recalled: Set of msgId }
  const INGRESS_POLL_MS = 25
  const AWAIT_EFFECT = Symbol('await in-flight effect')
  const ingress = new Map()
  const pause = () => new Promise(resolve => setTimeout(resolve, INGRESS_POLL_MS))
  function routeMessage(msg, sourceAdapter) {
    if (!ingress.has(msg?.chatId)) {
      const outcome = admitMessage(msg, sourceAdapter, false)
      if (outcome !== AWAIT_EFFECT) return outcome
      return queueMessage(msg, sourceAdapter, true)
    }
    return queueMessage(msg, sourceAdapter, false)
  }
  function queueMessage(msg, sourceAdapter, evaluated) {
    const { chatId, msgId } = msg
    // The bound counts from arrival, including time spent behind earlier messages.
    const deadline = performance.now() + ingressWaitMs
    let lane = ingress.get(chatId)
    if (!lane) {
      lane = { tail: Promise.resolve(), waiting: new Map(), recalled: new Set() }
      ingress.set(chatId, lane)
    }
    lane.waiting.set(msgId, (lane.waiting.get(msgId) || 0) + 1)
    let release
    const turn = new Promise(resolve => { release = resolve })
    const prior = lane.tail
    lane.tail = turn
    const admitted = (async () => {
      try {
        await prior
        // A box, so the next message does not wait for this one's turn to end.
        return await awaitAdmission(msg, sourceAdapter, lane, evaluated, deadline)
      } finally {
        const left = lane.waiting.get(msgId) - 1
        if (left > 0) lane.waiting.set(msgId, left)
        else lane.waiting.delete(msgId)
        if (lane.tail === turn && ingress.get(chatId) === lane) ingress.delete(chatId)
        release()
      }
    })()
    return admitted.then(box => box.outcome)
  }
  async function awaitAdmission(msg, sourceAdapter, lane, evaluated, deadline) {
    if (evaluated) await pause()
    for (;;) {
      // Never admitted, so no receipt exists: a stop or a recall meanwhile
      // only drops this message and is no fault.
      if (!started || stopPromise) return { outcome: { ignored: true, reason: 'ingress-closed' } }
      if (lane.recalled.has(msg.msgId)) {
        log(`group ${msg.chatId}: message recalled before admission`)
        return { outcome: { ignored: true, reason: 'recalled-before-admission' } }
      }
      const outcome = admitMessage(msg, sourceAdapter, performance.now() >= deadline)
      if (outcome !== AWAIT_EFFECT) return { outcome }
      await pause()
    }
  }
  function admitMessage(msg, sourceAdapter, expired) {
    const route = configured.get(msg?.chatId)
    if (route && route.paused !== true && suspended.has(msg.chatId)) {
      // A held group admits nothing; a replay of a sealed source stays silent.
      if (quarantine?.rejects(msg)) return { quarantined: true }
      if (started && !stopPromise) return heldReply(msg, sourceAdapter)
    }
    // Foreign/paused group events are not faults and never get a receipt.
    if (!allowed(msg?.chatId)) return { ignored: true, reason: 'unconfigured-or-paused' }
    if (quarantine?.rejects(msg)) return { quarantined: true }
    if (maintenance && started && !stopPromise) {
      return answerC2InputRejection({ error: rejectC2Input('C2 service upgrading',
        { reason: 'upgrading', notice: UPGRADING_NOTICE }), msg, platform: sourceAdapter, log })
    }
    if (recovering.has(msg.chatId) && started && !stopPromise) {
      // The group's failed turn is being closed; nothing is admitted meanwhile.
      return answerC2InputRejection({ error: rejectC2Input('C2 group recovering',
        { reason: 'group-recovering', notice: RECOVERING_NOTICE }), msg, platform: sourceAdapter, log })
    }
    let binding
    try {
      held()
      binding = bindings.get(msg.chatId)
      if (!started || starting || stopPromise || !binding) {
        throw new Error('C2 group ingress authority closed')
      }
      if (binding.gate.blocked) {
        if (effectInFlight(binding.runtime)) {
          if (!expired) return AWAIT_EFFECT
          // Still not settled after the bound: refuse as before, no fault.
          log(`group ${msg.chatId}: message refused; an outbound effect stayed in flight`)
          return answerC2InputRejection({ error: rejectC2Input('C2 group effect in flight',
            { reason: 'effect-in-flight', notice: RECOVERING_NOTICE }), msg, platform: sourceAdapter, log })
        }
        // A turn still running under a closed authority delivers its own
        // rejection; until then this message, which has no receipt, is
        // refused. An idle closed group is closed as its own fault here.
        if (runtimesOf(binding).some(rt => rt.v2NormalRouteActive)) {
          return answerC2InputRejection({ error: rejectC2Input('C2 group closing',
            { reason: 'group-recovering', notice: RECOVERING_NOTICE }), msg, platform: sourceAdapter, log })
        }
        return groupFault(msg.chatId, binding, new Error('C2 group ingress authority closed'))
          .then(async outcome => {
            if (outcome === 'held') return heldReply(msg, sourceAdapter)
            if (outcome === 'recovered') {
              return answerC2InputRejection({ error: rejectC2Input('C2 group recovered',
                { reason: 'group-recovering', notice: RECOVERING_NOTICE }), msg, platform: sourceAdapter, log })
            }
            throw new Error('C2 group ingress authority closed')
          })
      }
      const running = binding.engine.runDurableV2Message(msg, sourceAdapter)
      return Promise.resolve(running).catch(async error => {
        // A refused command or premature /stop wrote nothing durable. Answer it
        // once and keep every group serving.
        if (isC2InputRejection(error) && started && !stopPromise &&
            !binding.gate.blocked && writerHeld()) {
          log(`group ${msg.chatId}: refused input before receipt (${error.reason})`)
          return answerC2InputRejection({ error, msg, platform: sourceAdapter, log })
        }
        // Any other route error belongs to this group alone unless a shared
        // resource failed. Errors from a superseded binding join its fault.
        if (started && !stopPromise) {
          const outcome = await groupFault(msg.chatId, binding, error)
          if (outcome === 'recovered') return { recovered: true, reason: 'group-fault-closed' }
          if (outcome === 'held') return { held: true, reason: 'group-held' }
        }
        await fatal(error)
        throw error
      })
    } catch (error) {
      void fatal(error)
      throw error
    }
  }
  // Taps on the /model card only. They write the configuration through the
  // same validated writer as the console and never touch a journal, receipt
  // or session; every other card callback stays unsupported. The return
  // value is the platform's synchronous answer (toast and replacement card).
  function cardAction(event) {
    let value = event?.action?.value
    if (typeof value === 'string') { try { value = JSON.parse(value) } catch { value = null } }
    if (typeof onModelCard !== 'function' || !value || value.a !== 'mc' || !allowed(event?.chatId)) {
      return unsupported('card action')(event)
    }
    if (maintenance) return { toast: { type: 'info', content: '正在升级，稍后再点' } }
    if (suspended.has(event.chatId)) return { toast: { type: 'warning', content: '本群暂停处理中，请管理员处理后再改' } }
    const binding = bindings.get(event.chatId)
    if (!binding) return { ignored: true }
    return Promise.resolve().then(() => onModelCard({ ...event, action: { ...event.action, value } }, binding))
      .catch(error => {
        log(`model card ${event.chatId}: ${error?.message || String(error)}`)
        return { toast: { type: 'error', content: '没改成 —— 请稍后再试' } }
      })
  }
  function unsupported(source) {
    return event => {
      // An event without group identity cannot safely be attributed. It has
      // no accepted receipt and is ignored instead of stopping unrelated work.
      if (!allowed(event?.chatId)) return { ignored: true }
      return { ignored: true, reason: `unsupported-${source}` }
    }
  }
  // A reply or card update awaiting its platform response blocks the durable
  // authority only for that moment. The bot's own card deleted by /stop or
  // /skip comes back as a recall exactly then, and a person may recall a
  // queued message while its queue notice is still on its way. The recall
  // waits for that effect to settle; only an authority closed for good after
  // the recall is a fault. The platform does not await this result, so the
  // wait never rejects.
  const RECALL_WAIT_MS = 60_000
  const RECALL_POLL_MS = 25
  function recall(event, waitedMs = 0) {
    if (suspended.has(event?.chatId)) return { ignored: true, reason: 'group-held' }
    if (maintenance) return { ignored: true, reason: 'upgrading' }
    if (!allowed(event?.chatId)) return { ignored: true }
    // A message still waiting for admission has no receipt yet; it is
    // dropped there instead of being admitted after its own recall.
    const lane = ingress.get(event.chatId)
    if (lane?.waiting.has(event.msgId)) {
      lane.recalled.add(event.msgId)
      return { handled: true }
    }
    let binding
    try {
      held()
      binding = bindings.get(event.chatId)
      if (!started || stopPromise || !binding) return { ignored: true, reason: 'ingress-closed' }
      if (effectInFlight(binding.runtime)) {
        if (waitedMs >= RECALL_WAIT_MS) {
          log(`group ${event.chatId}: recall not applied; an outbound effect stayed in flight`)
          return { ignored: true, reason: 'recall-effect-in-flight' }
        }
        return new Promise(resolve => setTimeout(resolve, RECALL_POLL_MS))
          .then(() => recall(event, waitedMs + RECALL_POLL_MS))
          .catch(error => {
            log(`group ${event.chatId}: deferred recall failed: ${reasonOf(error)}`)
            return { ignored: true, reason: 'recall-failed' }
          })
      }
      const handled = binding.engine.handleRecall?.(event) === true
      if (closedForGood(binding.runtime)) throw new Error('Recall closed its durable authority')
      return handled ? { handled: true } : { ignored: true, reason: 'unsupported-or-inactive-recall' }
    } catch (error) {
      if (!binding || !writerHeld() || !started || stopPromise) return fatal(error)
      return groupFault(event.chatId, binding, error).then(outcome =>
        outcome === 'recovered' || outcome === 'held'
          ? { ignored: true, reason: `group-${outcome}` } : fatal(error))
    }
  }
  async function start({ preflightOnly = false } = {}) {
    if (started || starting || stopPromise) throw new Error('C2 service already started or stopped')
    starting = true
    let finishStartup
    startupDone = new Promise(resolve => {
      finishStartup = () => { startupComplete = true; resolve() }
    })
    try {
      held()
      transport = createTransport()
      if (!transport || typeof transport.platform?.start !== 'function' ||
          typeof transport.stopPlatform !== 'function') {
        throw new TypeError('C2 transport lacks a single start/stop boundary')
      }
      for (const [chatId, reason] of holds) suspend(chatId, reason, { source: 'startup' })
      for (const route of routes) {
        if (route.paused || suspended.has(route.chatId)) continue // Paused journals are audited before start.
        let binding
        try {
          binding = await createBinding({ route, transport })
        } catch (error) {
          held()
          if (stopPromise) throw new Error('C2 service stopped during group recovery')
          // This group's journal could not be recovered; it alone stays closed.
          suspend(route.chatId, error, { source: 'startup' })
          continue
        }
        held()
        if (stopPromise) {
          binding?.gate?.stop?.()
          binding?.engine?.shutdown?.()
          if (binding?.engine) bindings.set(route.chatId, binding)
          throw new Error('C2 service stopped during group recovery')
        }
        if (!binding || !binding.gate || !binding.engine || binding.gate.blocked) {
          binding?.gate?.stop?.()
          binding?.engine?.shutdown?.()
          suspend(route.chatId, 'C2 group binding did not open its durable authority', { source: 'startup' })
          continue
        }
        bindings.set(route.chatId, binding)
      }
      held()
      const heldList = [...suspended].map(([chatId, entry]) => `${chatId}: ${entry.reason}`)
      if (preflightOnly && heldList.length) {
        throw new Error(`Startup preflight would hold ${heldList.length} group(s): ${heldList.join('; ')}`)
      }
      if (heldList.length && !bindings.size) {
        throw new Error(`Every active group is held: ${heldList.join('; ')}`)
      }
      if (preflightOnly) {
        finishStartup()
        await stop('preflight', 0)
        return { groups: bindings.size, connected: false }
      }
      starting = false
      started = true
      transportStarted = true
      await transport.platform.start(routeMessage, { onFatal: fatal,
        onRecall: recall, onReaction: unsupported('reaction'),
        onCardAction: cardAction, onBoardUpdated: unsupported('board update') })
      held()
      if (stopPromise) throw new Error('C2 service stopped during connection')
      return { groups: bindings.size, connected: true, ...(suspended.size ? { held: heldGroups() } : {}) }
    } catch (error) {
      finishStartup()
      await stop('startup-failed', 1)
      throw error
    } finally { starting = false; finishStartup() }
  }
  function heldGroups() {
    return [...suspended].map(([chatId, entry]) => Object.freeze({ chatId,
      reason: entry.reason, source: entry.source, since: entry.since }))
  }
  function beginMaintenance() {
    if (!maintenance) log('upgrade: admission closed for the service switch')
    maintenance = true
  }
  function endMaintenance() {
    if (maintenance) log('upgrade: admission reopened')
    maintenance = false
  }
  return { start, stop, routeMessage, addRoute, heldGroups, beginMaintenance, endMaintenance,
    get inMaintenance() { return maintenance },
    // True only while the transport serves: the console may inject then and
    // never during startup or a stop, when routing would close the service.
    get serving() { return started && !starting && !stopPromise && !failed },
    get bindings() { return new Map(bindings) },
    get held() { return new Map([...suspended].map(([chatId, entry]) =>
      [chatId, { reason: entry.reason, source: entry.source, since: entry.since }])) } }
}

module.exports = { createC2MultiGroupService }
