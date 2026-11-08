// Dedicated durable v2 host. The binary and journal own turn decisions;
// this class owns process-local payloads, runner handles and platform I/O.
// No legacy Engine, retry/failover scheduler or v1 reducer is loaded here.
'use strict'
const { randomBytes } = require('node:crypto')
const { isDeepStrictEqual } = require('node:util')
const { redact } = require('./redact')
const { fmtStamp, normalizeTz } = require('./time')
const { settleUsage, manifestPolicy, manifestHeader, manifestContext,
  systemAppendix, turnPrompt, engineTerminalStep, engineQueueStep } = require('../agent/privatecore')
const { taskId } = require('./enginecheckpoint')
const { prepareCardTerminalPath } = require('./c2cardterminalpath')
const { terminalReplyText } = require('./c2terminaleffectbridge')
const { createC2TurnProjection } = require('./c2turnprojection')
const { prepareC2RunnerInput } = require('./c2runnerinput')
const { continueC2Successor } = require('./c2successorbridge')
const NO_REPLY = 'NO_REPLY'
const SYSTEM_APPENDIX = systemAppendix(NO_REPLY)
const V2_NORMAL_ROUTE_MISSING = Object.freeze(['complete durable v2 authority'])
const T = {
  queued: n => n > 1 ? `⏳ 已排队 — 当前任务结束后与前面 ${n - 1} 条一并处理` : '⏳ 已排队 — 当前任务结束后处理',
  stopped: '已停止',
  noActiveTask: '没有正在运行的任务',
  stoppedWithQueue: n => `已停止 — 连同排队的 ${n} 条一并取消`,
  cardFooter: ({ ms, tokens }) => {
    const parts = [`耗时 ${Math.max(0, Math.round(ms / 1000))} 秒`]
    const tokenLabel = n => n >= 1000 ? (n / 1000).toFixed(1) + 'k' : String(n)
    if (tokens) parts.push(`tokens ↑${tokenLabel((tokens.in || 0) + (tokens.cr || 0) + (tokens.cw || 0))} ↓${tokenLabel(tokens.out || 0)}`)
    return parts.join(' · ')
  },
}
function ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId) {
  if (!Array.isArray(jobs) || !jobs.length ||
      jobs.some(job => !job || job.msg?.batch || job.msg?.synthetic ||
        job.msg?.cron || job.msg?.polled || job.msg?.quiet ||
        job.msg?.chatId !== chatId ||
        job.msg?.replyCtx?.chatId !== chatId ||
        job.msg?.replyCtx?.messageId !== job.msg?.msgId ||
        typeof job.msg?._c2ReceiptId !== 'string' ||
        !/^[0-9a-f]{32}$/.test(job.msg._c2ReceiptId)) ||
      !isDeepStrictEqual(binding?.receiptIds,
        jobs.map(job => job.msg._c2ReceiptId)) ||
      new Set(binding.receiptIds).size !== binding.receiptIds.length ||
      !isDeepStrictEqual(binding?.batchReceiptIds, binding.receiptIds) ||
      !binding.receiptIds.includes(receiptId) ||
      !isDeepStrictEqual(snapshot.state?.lanes?.handoff?.[chatId]?.acceptedReceiptIds,
        jobs.length > 1 ? binding.receiptIds : []) ||
      jobs.some(job => {
        const receipt = snapshot.receipts?.pending?.find(item =>
          item.id === job.msg._c2ReceiptId)
        return receipt?.chatId !== chatId || receipt.source !== 'message' ||
          receipt.sourceId !== job.msg.msgId || receipt.quiet !== false
      })) return null
  return { jobs, anchor: jobs.find(job => job.msg._c2ReceiptId === receiptId),
    receiptIds: [...binding.receiptIds] }
}
function v2QueueSelection(queue) {
  if (!Array.isArray(queue)) throw new TypeError('durable queue must be an array')
  const result = engineQueueStep({ queue }, { type: 'dequeue' })
  const effect = result.effects[0]
  if (!queue.length && result.effects.length === 0) return { jobs: [], anchor: null }
  if (result.effects.length !== 1 || effect.type !== 'dispatch' ||
      !Array.isArray(effect.batch) || !effect.batch.length ||
      !effect.batch.includes(effect.anchor)) throw new Error('binary queue selection invalid')
  const jobs = effect.batch.map(id => queue.find(job => job.id === id))
  if (jobs.some(job => !job)) throw new Error('binary selected unknown queue handle')
  return { jobs, anchor: effect.anchor.slice('receipt:job:'.length) }
}
class Engine {
  constructor(cfg, options = {}) {
    const { store, log = () => {}, durableV2Runtime, durableV2Payloads,
      durableV2StartTurn, durableV2ApplyLocalEffect, durableV2VerifyRunnerClosed,
      durableV2AssertWriterLock, durableV2Journal,
      durableV2NormalRoute = true, durableV2StreamFrames = false } = options
    const sync = f => typeof f === 'function' && f.constructor?.name !== 'AsyncFunction'
    if (!cfg || !cfg.agent || !cfg.groups || !cfg.providers ||
        options.receiptJournal || options.unifiedStepHost ||
        !durableV2Runtime || !durableV2Payloads ||
        typeof durableV2Runtime.enqueueMessage !== 'function' ||
        typeof durableV2Runtime.snapshot !== 'function' ||
        typeof durableV2Runtime.close !== 'function' ||
        typeof durableV2Runtime.beginRunnerStart !== 'function' ||
        typeof durableV2Runtime.confirmRunnerClosed !== 'function' ||
        typeof durableV2Runtime.commitClosedRunnerSession !== 'function' ||
        typeof durableV2Payloads.preflight !== 'function' ||
        typeof durableV2Payloads.attach !== 'function' ||
        typeof durableV2StartTurn !== 'function' ||
        !sync(durableV2ApplyLocalEffect) || !sync(durableV2VerifyRunnerClosed) ||
        !sync(durableV2AssertWriterLock) ||
        typeof durableV2Journal?.snapshot !== 'function' ||
        typeof store?.getSession !== 'function' ||
        typeof store?.getSessionStats !== 'function' ||
        typeof store?.setSessionAtomic !== 'function' ||
        durableV2NormalRoute !== true || typeof durableV2StreamFrames !== 'boolean') {
      throw new TypeError('dedicated Engine requires complete durable v2 authority')
    }
    Object.assign(this, { cfg, store, log, durableV2Runtime, durableV2Payloads,
      durableV2StartTurn, durableV2ApplyLocalEffect, durableV2VerifyRunnerClosed,
      durableV2AssertWriterLock, durableV2Journal, durableV2NormalRoute,
      durableV2StreamFrames })
    this.projectMemory = options.projectMemory || null
    this.repoInfo = options.repoInfo || null
    this.tz = normalizeTz(cfg.timezone)
    this.rts = new Map()
  }

  shutdown() {
    this.durableV2Runtime.close()
    let aborted = 0
    for (const rt of this.rts.values()) {
      if (rt.v2Controller) {
        try { rt.v2Controller.abort() } catch {}
        aborted++
      }
    }
    return aborted
  }

drain(timeoutMs = 12_000) { return this.drainDurableV2(timeoutMs) }

async drainDurableV2(timeoutMs = 12_000) {
    if (!this.durableV2Runtime || !Number.isSafeInteger(timeoutMs) || timeoutMs < 0) {
      throw new TypeError('C2 v2 runner drain needs an exact timeout')
    }
    const active = [...this.rts.values()]
    if (active.some(rt => rt.v2NormalRouteFailure)) return false
    const runs = active.filter(rt => rt.v2RunnerStopPromise || rt.v2Controller)
    const routes = active.filter(rt => rt.v2NormalRouteActive)
    if (!runs.length && !routes.length) return true
    if (runs.some(rt => !rt.v2RunnerStopPromise) ||
        routes.some(rt => !rt.v2NormalRoutePromise)) return false
    let timer
    try {
      const results = await Promise.race([
        Promise.all([...runs.map(rt => rt.v2RunnerStopPromise),
          ...routes.map(rt => rt.v2NormalRoutePromise)]),
        new Promise(resolve => { timer = setTimeout(() => resolve(null), timeoutMs) }),
      ])
      return Array.isArray(results) && results.every(value => value === true)
    } finally { if (timer) clearTimeout(timer) }
  }

durableV2ActiveFaultProofs(activeTurns) {
    const journal = this.durableV2Journal
    const runtime = this.durableV2Runtime
    if (!runtime || !journal || !Array.isArray(activeTurns) ||
        activeTurns.length === 0 || activeTurns.length > 32 ||
        !isDeepStrictEqual(runtime.snapshot(), journal.snapshot())) return null
    const snapshot = journal.snapshot()
    const lanes = snapshot.state.lanes
    const expected = []
    for (const chatId of new Set([
      ...Object.keys(lanes.turn || {}), ...Object.keys(lanes.handoff || {}),
      ...Object.keys(lanes.lifecycle || {}),
    ])) {
      const turn = lanes.turn?.[chatId]
      const handoff = lanes.handoff?.[chatId]
      const lifecycle = lanes.lifecycle?.[chatId]
      if (turn?.active != null || handoff?.phase && handoff.phase !== 'idle' ||
          lifecycle?.busy === true || lifecycle?.controller === true) {
        expected.push({ chatId, turnToken: turn?.active ?? handoff?.turnToken ?? null })
      }
    }
    expected.sort((a, b) => a.chatId.localeCompare(b.chatId))
    if (!isDeepStrictEqual(activeTurns, expected)) return null
    const suppliedChats = new Set()
    const proofs = []
    for (const turn of activeTurns) {
      const chatId = turn?.chatId
      const turnToken = turn?.turnToken
      if (typeof chatId !== 'string' || !chatId || suppliedChats.has(chatId) ||
          !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
          snapshot.state.lanes.turn?.[chatId]?.active !== turnToken ||
          snapshot.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
          snapshot.state.lanes.handoff[chatId].turnToken !== turnToken) return null
      suppliedChats.add(chatId)
      const rt = this.rts.get(chatId)
      const binding = rt?.v2DispatchEffect
      const jobs = rt?.v2RunningJobs
      const receiptId = binding?.receiptIds?.[0]
      const generation = rt?.v2RunnerGeneration
      const closeEvidenceId = rt?.v2RunnerCloseEvidenceId
      const durable = closeEvidenceId && journal.lookupRunnerClosed(closeEvidenceId)
      const receipt = snapshot.receipts.pending.find(item => item.id === receiptId)
      const descriptor = binding?.effectId && journal.effectDescriptor(binding.effectId)
      if (!rt || rt.v2TurnToken !== turnToken ||
          rt.v2RunnerStopVerified !== true || rt.v2Controller ||
          binding?.type !== 'dispatch' || binding.turnToken !== turnToken ||
          !Array.isArray(binding.receiptIds) || binding.receiptIds.length !== 1 ||
          !/^[0-9a-f]{32}$/.test(receiptId || '') ||
          !/^[0-9a-f]{32}$/.test(generation || '') ||
          closeEvidenceId !==
            `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
          !Array.isArray(jobs) || jobs.length !== 1 ||
          jobs[0]?.msg?._c2ReceiptId !== receiptId ||
          receipt?.chatId !== chatId || receipt.source !== 'message' ||
          jobs[0].msg.msgId !== receipt.sourceId ||
          durable?.receiptId !== receiptId || durable.chatId !== chatId ||
          durable.turnToken !== turnToken || durable.generation !== generation ||
          durable.dispatchEffectId !== binding.effectId ||
          descriptor?.domain !== 'atomicHandoff' || descriptor.type !== 'dispatch' ||
          descriptor.scope !== chatId || descriptor.receiptId !== receiptId ||
          descriptor.turnToken !== turnToken ||
          journal.effectStatus(binding.effectId) !== 'acked') return null
      proofs.push(Object.freeze({ chatId, receiptId, turnToken,
        runnerGeneration: generation, runnerClosed: true, closeEvidenceId }))
    }
    return Object.freeze(proofs)
  }

abortDurableV2FaultTurn(turn) {
    const chatId = turn?.chatId
    const turnToken = turn?.turnToken
    const rt = typeof chatId === 'string' ? this.rts.get(chatId) : null
    if (!this.durableV2Runtime || !rt ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        rt.v2TurnToken !== turnToken ||
        this.durableV2Journal?.snapshot().state.lanes.turn?.[chatId]?.active !== turnToken) {
      return false
    }
    if (rt.v2Controller) {
      try { rt.v2Controller.abort(); return true } catch { return false }
    }
    return this.durableV2ActiveFaultProofs([turn]) !== null
  }

_rt(chatId) {
    if (!this.rts.has(chatId)) this.rts.set(chatId, { chatId })
    return this.rts.get(chatId)
  }

baseSkillEnv(chatId) {
    const g = (this.cfg.groups || {})[chatId]
    return { SBOT_CHAT_ID: chatId, ...(g && g.platform ? { SBOT_PLATFORM: g.platform } : {}), TZ: this.tz, ...(this.cfg._path ? { SBOT_CONFIG: this.cfg._path } : {}), ...(this.uiLocalUrl ? { SBOT_UI_URL: this.uiLocalUrl } : {}) }
  }

_resolveGroup(chatId) {
    return (this.cfg.groups && this.cfg.groups[chatId]) || this.defaultGroup || null
  }

_resolveProvider(chatId, group) {
    const name = this.store.getProvider(chatId) || group.provider || this.cfg.defaultProvider
    return { name, provider: this.cfg.providers[name] }
  }

async runDurableV2Message(msg, platform) {
    if (msg?.text?.trim() === '/stop') {
      return this.runDurableV2Stop(msg, platform)
    }
    if (!this.durableV2NormalRoute) {
      const error = new Error('C2 v2 normal route is closed: runner transcript, tool/stream effects, and terminal projection lack durable evidence')
      error.code = 'C2_V2_NORMAL_ROUTE_CLOSED'
      error.missingEvidence = [...V2_NORMAL_ROUTE_MISSING]
      throw error
    }
    const authority = this.durableV2Runtime
    if (!authority || authority.blocked ||
        !msg || typeof msg !== 'object' || msg.synthetic || msg.cron ||
        msg.polled || msg.wantsAck || msg.resetSessionAfter || msg.quiet ||
        msg.batch ||
        msg.receiptSource && msg.receiptSource !== 'message' ||
        typeof msg.text !== 'string' || !msg.text.trim() ||
        msg.text.trim().startsWith('/') ||
        typeof msg.chatId !== 'string' || !msg.chatId ||
        typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        !platform || platform.features?.cardQuota !== true ||
        typeof platform.reply !== 'function' ||
        typeof platform.replyOnce !== 'function' ||
        typeof platform.createStreamingCard !== 'function') {
      throw new Error('C2 v2 ordinary Feishu message is unsupported or closed')
    }
    const group = this._resolveGroup(msg.chatId)
    const { provider } = group ? this._resolveProvider(msg.chatId, group) : {}
    if (!group || group.paused || group.platform && group.platform !== 'feishu' ||
        !provider || !['claude', 'codex'].includes(provider.runner) ||
        provider.runner === 'codex' && group.codexSteer !== false) {
      throw new Error('C2 v2 ordinary group control is not migrated')
    }
    let locked = false
    try { locked = this.durableV2AssertWriterLock() === true } catch {}
    if (!locked) {
      authority.close()
      throw new Error('C2 v2 ordinary route lost single-writer lock')
    }
    const rt = this._rt(msg.chatId)
    if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
    const before = authority.snapshot()
    const receiptId = taskId({ source: 'message', chatId: msg.chatId,
      sourceId: msg.msgId })
    if (before.receipts.pending.some(item => item.id === receiptId) ||
        before.receipts.completed.some(item => item.id === receiptId)) {
      const duplicate = this.stageDurableV2Message(msg, platform)
      return { receiptId, duplicate: true, staged: false,
        ingressClosed: duplicate.ingressClosed }
    }
    if (rt.v2StopControl || before.state.lanes.stopIntent?.[msg.chatId]) {
      throw new Error('C2 v2 ordinary route is waiting for stop acknowledgement')
    }
    const lane = before.state?.lanes
    const queue = lane?.queue?.[msg.chatId]?.queue
    const busy = lane?.turn?.[msg.chatId]?.active != null ||
      lane?.handoff?.[msg.chatId]?.phase === 'running' ||
      Array.isArray(queue) && queue.length > 0 ||
      rt.v2RunningJobs || rt.v2QueueReceiptIds?.length
    if (busy && rt.v2NormalRouteActive &&
        lane?.turn?.[msg.chatId]?.active === rt.v2TurnToken &&
        lane?.handoff?.[msg.chatId]?.phase === 'running' &&
        rt.v2DispatchEffect?.type === 'dispatch' &&
        rt.v2RunningJobs?.length === 1 &&
        rt.v2RunnerStopVerified !== true &&
        Array.isArray(queue) && queue.length < 2 &&
        queue.every(item => !item.batch &&
          /^receipt:job:[0-9a-f]{32}$/.test(item.id)) &&
        queue.every(item => [...before.effects].some(([effectId, status]) => {
          const descriptor = this.durableV2Journal.effectDescriptor(effectId)
          return status === 'acked' && descriptor?.type === 'queueNotice' &&
            descriptor.receiptId === item.id.slice('receipt:job:'.length)
        })) &&
        isDeepStrictEqual(queue.map(item => item.id.slice('receipt:job:'.length)),
          rt.v2QueueReceiptIds || []) &&
        isDeepStrictEqual(this.durableV2Journal.snapshot(), before)) {
      try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
        rt.v2QueueReceiptIds || []) }
      catch (error) { authority.close(); throw error }
      const queued = this.stageDurableV2Message(msg, platform)
      let attached
      try { attached = this.durableV2Payloads.requireQueued(queued.receiptId) }
      catch (error) { authority.close(); throw error }
      if (!queued.staged || queued.duplicate ||
          attached?.msg?._c2ReceiptId !== queued.receiptId) {
        authority.close()
        throw new Error('C2 v2 queued follow-up lacks exact payload handle')
      }
      try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
        rt.v2QueueReceiptIds) }
      catch (error) { authority.close(); throw error }
      const notice = authority.prepareQueueNotice({ receiptId: queued.receiptId,
        chatId: msg.chatId, payloadHandles: this.durableV2Payloads })
      const noticePromise = authority.executeQueueNotice({
        effectId: notice.effectId, receiptId: queued.receiptId, chatId: msg.chatId,
        payloadHandles: this.durableV2Payloads,
        assertWriterLock: this.durableV2AssertWriterLock,
        perform: ({ target }) => platform.replyOnce(target, T.queued(notice.visibleQueue)),
        confirm: response => response?.code === 0 &&
          /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || ''),
      })
      rt.v2QueueNoticePromise = noticePromise
      try { await noticePromise } finally {
        if (rt.v2QueueNoticePromise === noticePromise) rt.v2QueueNoticePromise = null
      }
      return { receiptId: queued.receiptId, queued: true, staged: true,
        ingressClosed: !!authority.blocked }
    }
    if (busy) {
      if (rt.v2NormalRouteActive && Array.isArray(queue) && queue.length > 0) {
        try { this.durableV2Payloads.auditOrdinaryQueue(msg.chatId,
          rt.v2QueueReceiptIds || []) }
        catch (error) { authority.close(); throw error }
      }
      if (!rt.v2NormalRouteActive || !Array.isArray(queue) || queue.length === 0) {
        authority.close()
      }
      const error = new Error('C2 v2 busy follow-up route is not migrated')
      error.code = 'C2_V2_BUSY_ROUTE_CLOSED'
      throw error
    }
    const accepted = this.stageDurableV2Message(msg, platform)
    if (!accepted.staged || accepted.duplicate) {
      authority.close()
      throw new Error('C2 v2 ordinary receipt admission changed')
    }
    const dispatched = this.commitDurableV2InitialDispatch({ chatId: msg.chatId,
      receiptId: accepted.receiptId })
    const effectId = dispatched.effectsPending?.[0]
    const identity = { chatId: msg.chatId, receiptId: accepted.receiptId,
      turnToken: dispatched.turnToken, effectId }
    rt.v2NormalRouteActive = true
    const execution = this._drainDurableV2NormalChain(identity)
    rt.v2NormalRoutePromise = execution.then(() => true, () => {
      rt.v2NormalRouteFailure = true
      return false
    })
    try {
      return await execution
    } finally {
      rt.v2NormalRouteActive = false
      rt.v2NormalRoutePromise = null
    }
  }

async runDurableV2Stop(msg, platform) {
    const authority = this.durableV2Runtime
    const chatId = msg?.chatId
    const rt = this.rts.get(chatId)
    if (!this.durableV2NormalRoute || !authority ||
        !msg || msg.synthetic || msg.cron || msg.polled || msg.quiet ||
        msg.wantsAck || msg.batch || msg.text?.trim() !== '/stop' ||
        typeof chatId !== 'string' || !chatId ||
        typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        msg.replyCtx?.chatId !== chatId ||
        msg.replyCtx?.messageId !== msg.msgId ||
        typeof platform?.replyOnce !== 'function' ||
        !rt?.v2NormalRouteActive || !rt.v2RunningJobs?.length ||
        !rt.v2Controller || rt.v2TerminalStarted ||
        rt.v2CancelControl || rt.v2StopControl || rt.v2StreamQuiescing ||
        rt.v2TimeoutProof) {
      throw new Error('C2 v2 /stop is unsupported or closed')
    }
    const group = this._resolveGroup(chatId)
    if (!group || group.paused || group.platform && group.platform !== 'feishu') {
      throw new Error('C2 v2 /stop group control is not migrated')
    }
    const requestedGeneration = rt.v2RunnerGeneration
    const requestedTurnToken = rt.v2TurnToken
    // A busy receipt may already be sending its durable queue notice. Keep
    // that external effect and the stop intent ordered: otherwise the notice
    // can become unknown while the stop transition clears its target queue.
    if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
    if (!rt.v2NormalRouteActive ||
        !rt.v2RunningJobs?.length || !rt.v2Controller ||
        rt.v2TerminalStarted || rt.v2CancelControl || rt.v2StopControl ||
        rt.v2StreamQuiescing || rt.v2TimeoutProof ||
        rt.v2RunnerGeneration !== requestedGeneration ||
        rt.v2TurnToken !== requestedTurnToken) {
      throw new Error('C2 v2 /stop is unsupported or closed')
    }
    const before = authority.snapshot()
    const controlReceipt = { source: 'message', chatId, sourceId: msg.msgId,
      acceptedAt: Date.now(), quiet: false }
    controlReceipt.id = taskId(controlReceipt)
    const runningReceiptId = rt.v2DispatchEffect?.receiptIds?.at(-1)
    const cohort = ordinaryV2Cohort(before, rt.v2RunningJobs,
      rt.v2DispatchEffect, chatId, runningReceiptId)
    const generation = rt.v2RunnerGeneration
    const turnToken = rt.v2TurnToken
    const queue = before.state.lanes.queue?.[chatId]?.queue
    const queuedReceiptIds = queue?.map(item => item.id.slice('receipt:job:'.length))
    if (!cohort || !/^[0-9a-f]{32}$/.test(runningReceiptId || '') ||
        !/^[0-9a-f]{32}$/.test(generation || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        !Array.isArray(queue) || queue.some(item => item.batch || item.synthetic ||
          item.quiet || item.polled ||
          !/^receipt:job:[0-9a-f]{32}$/.test(item.id) ||
          before.receipts.pending.find(receipt =>
            receipt.id === item.id.slice('receipt:job:'.length))?.source !== 'message' ||
          ![...before.effects].some(([effectId, status]) => {
            const descriptor = this.durableV2Journal.effectDescriptor(effectId)
            return status === 'acked' && descriptor?.type === 'queueNotice' &&
              descriptor.receiptId === item.id.slice('receipt:job:'.length)
          })) ||
        !isDeepStrictEqual(queuedReceiptIds, rt.v2QueueReceiptIds || []) ||
        before.state.lanes.turn?.[chatId]?.active !== turnToken ||
        before.state.lanes.handoff?.[chatId]?.phase !== 'running' ||
        before.receipts.pending.find(item => item.id === runningReceiptId)?.sourceId !==
          cohort.anchor.msg.msgId ||
        before.receipts.pending.some(item => item.id === controlReceipt.id) ||
        before.receipts.completed.some(item => item.id === controlReceipt.id)) {
      authority.close()
      throw new Error('C2 v2 /stop differs from durable running turn')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(chatId,
      queuedReceiptIds) }
    catch (error) { authority.close(); throw error }
    let releaseIntentGate = null
    try {
      // Stop admitting process frames, then drain any already prepared card
      // calls before persisting the stop count and aborting the child.
      rt.v2StreamQuiescing = true
      rt.v2StopIntentGate = new Promise(resolve => { releaseIntentGate = resolve })
      try {
        await rt.v2StreamChain
        if (rt.v2CardBinding?.opened) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (authority.blocked || rt.v2CancelControl || rt.v2TerminalStarted ||
            rt.v2RunnerGeneration !== generation || rt.v2TurnToken !== turnToken) {
          throw new Error('C2 v2 /stop card drain lost running turn')
        }
      } catch (error) {
        releaseIntentGate()
        throw error
      }
      if (this.durableV2AssertWriterLock() !== true) throw new Error('writer lock lost')
      const cardTarget = rt.v2CardBinding?.opened
        ? rt.v2CardBinding.path.cancellationTarget() : null
      authority.commitStopIntent({ controlReceipt, runningReceiptId, chatId,
        turnToken, generation, cardTarget,
        assertWriterLock: this.durableV2AssertWriterLock })
      rt.v2StopControl = { controlReceiptId: controlReceipt.id, runningReceiptId,
        turnToken, generation, runningReceiptIds: cohort.receiptIds,
        queuedReceiptIds,
        target: { receiptId: controlReceipt.id, chatId,
          sourceId: msg.msgId, replyCtx: msg.replyCtx },
        platform }
      rt.v2CancelControl = 'stop'
      rt.v2Controller.abort()
      releaseIntentGate()
      const completed = await rt.v2NormalRoutePromise
      if (completed !== true || authority.blocked ||
          !authority.snapshot().receipts.completed.some(item =>
            item.id === controlReceipt.id)) {
        throw new Error('C2 v2 /stop acknowledgement was not durably settled')
      }
      return { status: 'stopped', controlReceiptId: controlReceipt.id,
        cancelledReceiptIds: [...cohort.receiptIds, ...queuedReceiptIds] }
    } catch (error) {
      releaseIntentGate?.()
      rt.v2StopIntentGate = null
      try { rt.v2Controller?.abort() } catch {}
      authority.close(); throw error
    }
  }

async _cleanupDurableV2CancelledCard(rt, identity, generation,
    verifyGeneration) {
    if (!rt.v2CardBinding?.opened) return null
    const authority = this.durableV2Runtime
    const binding = rt.v2CardBinding
    if (binding.receiptId !== identity.receiptId ||
        binding.turnToken !== identity.turnToken ||
        binding.generation !== generation) {
      authority.close()
      throw new Error('C2 v2 cancellation card differs from running turn')
    }
    const cleanupBase = { receiptId: identity.receiptId,
      chatId: identity.chatId, turnToken: identity.turnToken, generation,
      verifyGeneration, assertWriterLock: this.durableV2AssertWriterLock }
    const intent = authority.commitCardCleanupIntent({ ...cleanupBase,
      target: binding.path.cancellationTarget() })
    if (await binding.path.recallForCancellation() !== true) {
      authority.close()
      throw new Error('C2 v2 cancellation card delete unconfirmed')
    }
    return authority.commitCardCleanupConfirmed({ ...cleanupBase,
      target: binding.path.cancellationTarget(), proof: intent })
  }

async _drainDurableV2NormalChain(initial) {
    const authority = this.durableV2Runtime
    const firstReceiptId = initial.receiptId
    const settled = []
    let identity = initial
    while (identity) {
      let locked = false
      try { locked = this.durableV2AssertWriterLock() === true } catch {}
      if (!locked) {
        authority.close()
        throw new Error('C2 v2 ordinary route lost single-writer lock before runner')
      }
      const started = await this.startDurableV2Runner(identity)
      if (started.startFailureRecovered === true) {
        settled.push({ receiptId: identity.receiptId, status: 'startupNotified' })
        return { receiptId: firstReceiptId, status: settled[0].status,
          settledReceiptIds: settled.map(item => item.receiptId),
          ingressClosed: authority.blocked }
      }
      const rt = this._rt(identity.chatId)
      if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
      if (rt.v2CancelControl === 'recall' || rt.v2CancelControl === 'stop') {
        const control = rt.v2CancelControl
        const generation = rt.v2RunnerGeneration
        if (rt.v2RunnerStopVerified !== true ||
            rt.v2RunnerCloseEvidenceId !==
              `sbot-c2-runner-closed-v1:${identity.receiptId}:${generation}` ||
            rt.v2SessionCloseEventId !==
              `sbot-c2-session-close-v1:${identity.receiptId}:${generation}` ||
            typeof authority.commitRunningCancellation !== 'function') {
          authority.close()
          throw new Error('C2 v2 cancelled runner lacks durable close proof')
        }
        const verifyGeneration = value => value.chatId === identity.chatId &&
          value.receiptId === identity.receiptId &&
          value.turnToken === identity.turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation
        const cardCleanup = await this._cleanupDurableV2CancelledCard(
          rt, identity, generation, verifyGeneration)
        const stop = control === 'stop' ? rt.v2StopControl : null
        const cancelled = stop
          ? authority.commitStopAll({ chatId: identity.chatId,
            controlReceiptId: stop.controlReceiptId,
            runningReceiptId: identity.receiptId,
            turnToken: identity.turnToken, generation,
            queuedReceiptIds: stop.queuedReceiptIds,
            cardCleanup,
            payloadHandles: this.durableV2Payloads,
            verifyGeneration, assertWriterLock: this.durableV2AssertWriterLock })
          : authority.commitRunningCancellation({ ...identity, generation,
            control, cardCleanup, verifyGeneration,
            assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2RunnerResult = null
        rt.v2TerminalProjection = null
        rt.v2UsageDecision = null
        rt.v2StartedAt = null
        rt.v2CardBinding = null
        rt.v2StreamRequested = false
        rt.v2StreamQuiescing = false
        rt.v2StreamChain = null
        rt.v2StopIntentGate = null
        rt.v2TimeoutProof = null
        rt.v2RunningJobs = null
        rt.v2RunnerGeneration = null
        rt.v2RunnerCloseEvidenceId = null
        rt.v2SessionCloseEventId = null
        rt.v2DispatchEffect = null
        rt.v2TurnToken = null
        rt.v2CancelControl = null
        if (stop) {
          rt.v2QueueReceiptIds = []
          const text = stop.queuedReceiptIds.length
            ? T.stoppedWithQueue(stop.queuedReceiptIds.length) : T.stopped
          await authority.executeStopAck({ effectId: cancelled.effectId,
            controlReceiptId: stop.controlReceiptId, chatId: identity.chatId,
            target: stop.target,
            perform: target => stop.platform.replyOnce(target.replyCtx, text),
            confirm: response => response?.code === 0 &&
              /^om_[A-Za-z0-9_-]{1,124}$/.test(response?.data?.message_id || ''),
            assertWriterLock: this.durableV2AssertWriterLock })
          rt.v2StopControl = null
        }
        for (const settledReceiptId of cancelled.cancelledReceiptIds ||
          [identity.receiptId]) {
          settled.push({ receiptId: settledReceiptId,
            status: control === 'recall' ? 'recalled' : 'stopped',
            terminalEffectId: null, cancellationEventId: cancelled.eventId })
        }
        if (authority.blocked) throw new Error('C2 v2 cancellation closed ingress')
        const nextReceiptId = this._nextDurableV2NormalAnchor(identity.chatId)
        if (nextReceiptId) {
          const next = this.commitDurableV2InitialDispatch({
            chatId: identity.chatId, receiptId: nextReceiptId })
          identity = { chatId: identity.chatId, receiptId: nextReceiptId,
            turnToken: next.turnToken, effectId: next.effectsPending[0] }
        } else identity = null
        continue
      }
      if (rt.v2TimeoutProof) {
        const generation = rt.v2RunnerGeneration
        const timeoutProof = rt.v2TimeoutProof
        if (rt.v2RunnerStopVerified !== true ||
            rt.v2RunnerCloseEvidenceId !==
              `sbot-c2-runner-closed-v1:${identity.receiptId}:${generation}` ||
            rt.v2SessionCloseEventId !==
              `sbot-c2-session-close-v1:${identity.receiptId}:${generation}` ||
            typeof authority.commitHardTimeoutRelease !== 'function') {
          authority.close()
          throw new Error('C2 v2 hard timeout lacks durable child close proof')
        }
        const verifyGeneration = value => value.chatId === identity.chatId &&
          value.receiptId === identity.receiptId &&
          value.turnToken === identity.turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation
        const cardCleanup = await this._cleanupDurableV2CancelledCard(
          rt, identity, generation, verifyGeneration)
        const released = authority.commitHardTimeoutRelease({ ...identity,
          generation, timeoutProof, cardCleanup, verifyGeneration,
          assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2RunnerResult = null
        rt.v2TerminalProjection = null
        rt.v2UsageDecision = null
        rt.v2StartedAt = null
        rt.v2CardBinding = null
        rt.v2StreamRequested = false
        rt.v2StreamQuiescing = false
        rt.v2StreamChain = null
        rt.v2StopIntentGate = null
        rt.v2TimeoutProof = null
        rt.v2RunningJobs = null
        rt.v2RunnerGeneration = null
        rt.v2RunnerCloseEvidenceId = null
        rt.v2SessionCloseEventId = null
        rt.v2DispatchEffect = null
        rt.v2TurnToken = null
        for (const settledReceiptId of released.settledReceiptIds ||
          [identity.receiptId]) {
          settled.push({ receiptId: settledReceiptId,
            status: 'timeout', terminalEffectId: null,
            cancellationEventId: released.eventId })
        }
        if (authority.blocked) throw new Error('C2 v2 hard timeout closed ingress')
        const nextReceiptId = this._nextDurableV2NormalAnchor(identity.chatId)
        if (nextReceiptId) {
          const next = this.commitDurableV2InitialDispatch({
            chatId: identity.chatId, receiptId: nextReceiptId })
          identity = { chatId: identity.chatId, receiptId: nextReceiptId,
            turnToken: next.turnToken, effectId: next.effectsPending[0] }
        } else identity = null
        continue
      }
      const payload = rt.v2TerminalProjection?.payload
      if (!payload) {
        authority.close()
        const error = new Error('C2 v2 ordinary result needs an unresolved-turn policy')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        throw error
      }
      const terminal = { ...payload, type: 'finalize' }
      delete terminal.receiptId
      delete terminal.turnToken
      delete terminal.quiet
      const outcome = engineTerminalStep({ finalized: false, outcome: null },
        terminal).state.outcome
      if (['error', 'empty', 'stopped'].includes(outcome.status)) {
        const classified = this.classifyDurableV2UnresolvedTurn({ ...identity,
          payload })
        const error = new Error('C2 v2 ordinary result requires fault recovery')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        error.classificationEventId = classified.eventId
        throw error
      }
      if (payload.source !== 'result' || payload.sessionMissing ||
          payload.hasQuota || payload.transientNetwork || payload.freshRetried ||
          payload.resumedSessionCurrent ||
          !['ok', 'no-reply'].includes(outcome.status)) {
        authority.close()
        const error = new Error('C2 v2 ordinary result needs a retry or notice decision')
        error.code = 'C2_V2_UNRESOLVED_TURN'
        throw error
      }
      let stillLocked = false
      try { stillLocked = this.durableV2AssertWriterLock() === true } catch {}
      if (!stillLocked) {
        authority.close()
        throw new Error('C2 v2 ordinary route lost single-writer lock before delivery')
      }
      const silent = payload.quiet || outcome.silent
      const completed = await this.completeDurableV2CardTurn({ ...identity, payload,
        ...(silent ? {} : { replyText: terminalReplyText(payload) }) })
      for (const settledReceiptId of completed.settledReceiptIds ||
        [identity.receiptId]) {
        settled.push({ receiptId: settledReceiptId,
          status: silent ? 'silent' : 'answered',
          terminalEffectId: completed.terminalEffectId })
      }
      if (authority.blocked) {
        throw new Error('C2 v2 ordinary route closed during terminal settlement')
      }
      identity = completed.successor
        ? { chatId: initial.chatId, receiptId: completed.successor.receiptId,
          turnToken: completed.successor.turnToken,
          effectId: completed.successor.effectId }
        : null
    }
    return { receiptId: firstReceiptId, status: settled[0].status,
      terminalEffectId: settled[0].terminalEffectId,
      ...(settled[0].cancellationEventId
        ? { cancellationEventId: settled[0].cancellationEventId } : {}),
      settledReceiptIds: settled.map(item => item.receiptId),
      ingressClosed: false }
  }

stageDurableV2Message(msg, platform) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    if (!authority || !handles) throw new Error('C2 v2 staging is unavailable')
    if (authority.blocked) throw new Error('C2 v2 ingress is closed')
    if (!msg || typeof msg !== 'object' || msg.synthetic || msg.cron ||
        msg.receiptSource && msg.receiptSource !== 'message' ||
        typeof msg.text !== 'string' || !msg.text.trim() ||
        typeof msg.chatId !== 'string' || typeof msg.msgId !== 'string' ||
        !/^om_[A-Za-z0-9_-]{1,124}$/.test(msg.msgId) ||
        !msg.replyCtx || typeof msg.replyCtx !== 'object' ||
        msg.replyCtx.chatId !== msg.chatId ||
        msg.replyCtx.messageId !== msg.msgId ||
        !platform || typeof platform.reply !== 'function') {
      throw new TypeError('C2 v2 staging needs a platform message and reply target')
    }
    const group = this._resolveGroup(msg.chatId)
    if (!group || group.paused) throw new Error('C2 v2 staging needs an active bound group')
    const acceptedAt = Date.now()
    const receipt = { source: 'message', chatId: msg.chatId, sourceId: msg.msgId,
      acceptedAt, quiet: !!msg.quiet }
    receipt.id = taskId(receipt)
    const prior = authority.snapshot()
    const pendingDuplicate = prior.receipts?.pending?.find(item => item.id === receipt.id)
    const completedDuplicate = prior.receipts?.completed?.some(item => item.id === receipt.id)
    if (pendingDuplicate || completedDuplicate) {
      if (pendingDuplicate && (pendingDuplicate.chatId !== msg.chatId ||
          pendingDuplicate.source !== 'message' || pendingDuplicate.sourceId !== msg.msgId)) {
        authority.close()
        throw new Error('C2 v2 duplicate identity differs from durable receipt')
      }
      return { receiptId: receipt.id, cursor: prior.cursor, staged: false,
        duplicate: true, ingressClosed: false }
    }
    const job = { msg: { ...msg, _c2ReceiptId: receipt.id }, platform, group }
    handles.preflight(receipt, job)
    const flags = { quiet: receipt.quiet, polled: !!msg.polled, synthetic: false,
      wantsAck: !!msg.wantsAck, resetSessionAfter: !!msg.resetSessionAfter,
      emptyRetried: false, freshRetried: false, firstResumed: false, failedOver: false }
    let result
    try { result = authority.enqueueMessage({ receipt, flags }) }
    catch (error) {
      authority.close()
      throw error
    }
    try { handles.attach(receipt.id, job) }
    catch (error) {
      authority.close()
      throw error
    }
    const rt = this._rt(msg.chatId)
    if (!rt.v2QueueReceiptIds) rt.v2QueueReceiptIds = []
    rt.v2QueueReceiptIds.push(receipt.id)
    return { receiptId: receipt.id, cursor: result.cursor, staged: true,
      ingressClosed: !!authority.blocked }
  }

_nextDurableV2NormalAnchor(chatId) {
    const authority = this.durableV2Runtime
    const snapshot = authority?.snapshot?.()
    const queue = snapshot?.state?.lanes?.queue?.[chatId]?.queue
    const rt = this._rt(chatId)
    const ids = queue?.map(item => typeof item?.id === 'string'
      ? item.id.slice('receipt:job:'.length) : null)
    if (!authority || authority.blocked || !Array.isArray(queue) ||
        !isDeepStrictEqual(ids, rt.v2QueueReceiptIds || []) ||
        !isDeepStrictEqual(this.durableV2Journal?.snapshot(), snapshot)) {
      authority?.close()
      throw new Error('C2 v2 successor differs from durable queue')
    }
    if (!queue.length) return null
    const taken = v2QueueSelection(queue).jobs
    if (!taken.length || taken.some(item => item.synthetic || item.batch ||
        item.quiet || item.polled ||
        !/^receipt:job:[0-9a-f]{32}$/.test(item.id) ||
        snapshot.receipts.pending.find(receipt =>
          receipt.id === item.id.slice('receipt:job:'.length))?.chatId !== chatId ||
        ![...snapshot.effects].some(([effectId, status]) => {
          const descriptor = this.durableV2Journal.effectDescriptor(effectId)
          return status === 'acked' && descriptor?.type === 'queueNotice' &&
            descriptor.receiptId === item.id.slice('receipt:job:'.length)
        }))) {
      authority.close()
      throw new Error('C2 v2 successor lacks flat acknowledged queue cohort')
    }
    try { this.durableV2Payloads.auditOrdinaryQueue(chatId, ids) }
    catch (error) { authority.close(); throw error }
    return v2QueueSelection(queue).anchor
  }

commitDurableV2InitialDispatch({ chatId, receiptId } = {}) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    if (!authority || !handles || authority.blocked ||
        typeof authority.snapshot !== 'function' ||
        typeof authority.commitInitialDispatch !== 'function' ||
        typeof handles.consumeCommittedDispatch !== 'function') {
      throw new Error('C2 v2 initial dispatch is unavailable')
    }
    const before = authority.snapshot()
    const queue = before.state?.lanes?.queue?.[chatId]?.queue
    const rt = this._rt(chatId)
    const takenIds = Array.isArray(queue)
      ? v2QueueSelection(queue).jobs.map(item =>
        typeof item?.id === 'string' ? item.id.slice('receipt:job:'.length) : null) : []
    if (typeof chatId !== 'string' || !chatId ||
        typeof receiptId !== 'string' || !/^[0-9a-f]{32}$/.test(receiptId) ||
        !Array.isArray(queue) || v2QueueSelection(queue).anchor !== receiptId ||
        !isDeepStrictEqual(queue.map(item => item.id.slice('receipt:job:'.length)),
          rt.v2QueueReceiptIds)) {
      authority.close()
      throw new Error('C2 v2 initial dispatch differs from durable queue')
    }
    try {
      handles.auditQueued()
      const result = authority.commitInitialDispatch({ receiptId, payloadHandles: handles })
      const token = result.decision?.turnToken
      const jobs = handles.consumeCommittedDispatch({ eventId: result.eventId,
        turnToken: token, receiptIds: result.jobReceiptIds })
      const after = authority.snapshot()
      const remaining = after.state?.lanes?.queue?.[chatId]?.queue
      if (!Array.isArray(remaining) || !Array.isArray(jobs) ||
          !isDeepStrictEqual(result.jobReceiptIds, takenIds) ||
          jobs.length !== result.jobReceiptIds.length ||
          !isDeepStrictEqual(remaining.map(item => item.id.slice('receipt:job:'.length)),
            queue.slice(result.jobReceiptIds.length).map(item => item.id.slice('receipt:job:'.length)))) {
        throw new Error('C2 v2 initial dispatch host result invalid')
      }
      rt.v2QueueReceiptIds = remaining.map(item => item.id.slice('receipt:job:'.length))
      rt.v2RunningJobs = jobs
      rt.v2TurnToken = token
      // This is only a process-local binding for the next migration step.
      // The durable journal stores IDs/status, not an executable reply target.
      rt.v2DispatchEffect = { effectId: result.effects[0].effectId,
        type: result.effects[0].type, turnToken: token,
        receiptIds: [...result.jobReceiptIds],
        batchReceiptIds: [...result.batchReceiptIds] }
      if (!this.durableV2StartTurn ||
          !ordinaryV2Cohort(after, jobs, rt.v2DispatchEffect, chatId, receiptId)) {
        authority.close()
      }
      return { cursor: result.cursor, turnToken: token,
        dispatchedReceiptIds: [...result.jobReceiptIds],
        effectsPending: result.effects.map(effect => effect.effectId),
        ingressClosed: !!authority.blocked }
    } catch (error) { authority.close(); throw error }
  }

async startDurableV2Runner({ chatId, receiptId, turnToken, effectId } = {}) {
    const authority = this.durableV2Runtime
    if (!this.durableV2StartTurn || !authority || authority.blocked) {
      throw new Error('C2 v2 runner start is unavailable')
    }
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    const snapshot = authority.snapshot()
    const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
    const binding = rt?.v2DispatchEffect
    const jobs = rt?.v2RunningJobs
    const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
    if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof effectId !== 'string' || !effectId ||
        receipt?.chatId !== chatId ||
        snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
        snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
        snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
        binding?.type !== 'dispatch' || binding.effectId !== effectId ||
        binding.turnToken !== turnToken ||
        !cohort ||
        snapshot.effects?.get(effectId) !== 'pending' ||
        rt.v2RunnerGeneration) {
      authority.close()
      throw new Error('C2 v2 runner start differs from durable dispatch')
    }
    const generation = randomBytes(16).toString('hex')
    rt.v2RunnerGeneration = generation
    rt.v2StartedAt = Date.now()
    rt.v2CardBinding = null
    rt.v2StreamRequested = false
    rt.v2StreamQuiescing = false
    rt.v2StreamChain = Promise.resolve()
    rt.v2StopIntentGate = null
    rt.v2TimeoutProof = null
    const verifyGeneration = value => value.chatId === chatId &&
      value.receiptId === receiptId && value.turnToken === turnToken &&
      value.generation === generation && rt.v2RunnerGeneration === generation
    let capability
    let accepted = false
    let controller = null
    let capTimer = null
    try {
      capability = authority.beginRunnerStart({ receiptId, chatId, turnToken,
        generation, verifyGeneration })
      if (capability.effectId !== effectId) {
        throw new Error('C2 v2 runner effect changed before start')
      }
      const projection = createC2TurnProjection({ receiptId, turnToken,
        quiet: receipt.quiet,
        resumed: !!this.store.getSession(chatId), freshRetried: false,
        ...(cohort.receiptIds.length > 1
          ? { batchReceiptIds: cohort.receiptIds } : {}) })
      const job = cohort.anchor
      const { name, provider } = this._resolveProvider(chatId, job.group)
      if (!provider || (provider.baseUrl && !provider.apiKey)) {
        throw new Error('C2 v2 runner provider unavailable')
      }
      if (provider.runner === 'codex' && job.group.codexSteer !== false) {
        throw new Error('C2 v2 follow-up control has no durable authority')
      }
      const prompt = this._prepareRunnerPrompt({ msg: job.msg, group: job.group,
        platform: job.platform, providerName: name, provider, rt,
        batch: cohort.receiptIds.length > 1 ? cohort.jobs.map(item => item.msg) : null,
        consumeLifecycle: false })
      controller = new AbortController()
      rt.v2Controller = controller
      rt.v2RunnerStopPromise = null
      rt.v2RunnerStopVerified = false
      let streamChain = Promise.resolve()
      let streamFailure = null
      const enqueueFrame = event => {
        if (!this.durableV2StreamFrames || event.type !== 'assistant') return
        if (!event.text || controller.signal.aborted || rt.v2CancelControl ||
            rt.v2StreamQuiescing ||
            authority.scopeState('stopIntent', chatId)) return
        const buffer = projection.streamSnapshot().bufferText
        const trimmed = buffer.trim()
        if (!trimmed || NO_REPLY.startsWith(trimmed)) return
        const text = buffer
        rt.v2StreamRequested = true
        streamChain = streamChain.then(async () => {
          if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
          if (authority.blocked) throw new Error('C2 v2 stream authority closed')
          if (controller.signal.aborted || rt.v2CancelControl ||
              authority.scopeState('stopIntent', chatId)) return
          if (!rt.v2CardBinding) {
            const path = prepareCardTerminalPath({ runtime: authority,
              payloadHandles: this.durableV2Payloads, platform: job.platform,
              replyCtx: job.msg.replyCtx, receiptId, chatId, turnToken,
              generation, verifyGeneration,
              applyLocalEffect: this.durableV2ApplyLocalEffect,
              assertWriterLock: this.durableV2AssertWriterLock,
              redactText: value => redact(value,
                { pii: job.group?.redactPii !== false }),
              sendPlainReply: typeof job.platform.replyOnce === 'function'
                ? (target, value) => job.platform.replyOnce(target.replyCtx, value)
                : null })
            const opened = await path.open()
            rt.v2CardBinding = { path, receiptId, turnToken,
              generation, opened }
          }
          if (rt.v2CardBinding.opened) rt.v2CardBinding.path.update(text)
        })
        rt.v2StreamChain = streamChain
        streamChain.catch(error => {
          streamFailure = error
          try { controller.abort() } catch {}
        })
      }
      const maxMins = Number(this.cfg.agent.maxTurnTimeMins) || 0
      const timeoutMs = maxMins > 0 ? maxMins * 60_000 : 0
      const timeoutDeadlineAt = timeoutMs > 0 ? Date.now() + timeoutMs : null
      if (timeoutDeadlineAt !== null &&
          (!Number.isSafeInteger(timeoutDeadlineAt) || timeoutDeadlineAt <= 0)) {
        throw new Error('C2 v2 hard timeout deadline invalid')
      }
      capTimer = timeoutDeadlineAt !== null
        ? setTimeout(() => {
          const elapsedAt = Date.now()
          if (rt.v2RunnerGeneration !== generation ||
              rt.v2Controller !== controller || rt.v2CancelControl ||
              rt.v2StreamQuiescing) return
          if (elapsedAt >= timeoutDeadlineAt) {
            rt.v2TimeoutProof = { receiptId, turnToken, generation,
              deadlineAt: timeoutDeadlineAt, elapsedAt }
          }
          controller.abort()
        }, timeoutMs) : null
      const input = prepareC2RunnerInput({ prompt,
        appendSystemPrompt: SYSTEM_APPENDIX, msg: job.msg, group: job.group,
        provider, config: this.cfg,
        sessionId: this.store.getSession(chatId) || null,
        signal: controller.signal, extraEnv: this.baseSkillEnv(chatId),
        onDurableEvent: event => {
          projection.accept(event)
          enqueueFrame(event)
        },
        onTurnAccepted: value => {
          const ack = capability.onTurnAccepted(value)
          accepted = true
          return ack
        },
        onSpawnFailed: value => capability.onSpawnFailed(value),
        log: this.log })
      let started
      try { started = this.durableV2StartTurn(input) }
      catch (error) { started = Promise.reject(error) }
      const running = Promise.resolve(started)
      const stopWitness = (result, error) => {
        let verified = false
        try {
          verified = this.durableV2VerifyRunnerClosed?.({ chatId, receiptId,
            turnToken, generation, result, error }) === true
        } catch { /* missing or failed close witness stays unverified */ }
        rt.v2RunnerStopVerified = verified
        return verified
      }
      rt.v2RunnerStopPromise = running.then(
        result => stopWitness(result, null),
        error => stopWitness(null, error))
      let result
      try {
        result = await running
        if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
        await rt.v2RunnerStopPromise
        await streamChain
        if (streamFailure) throw streamFailure
        if (rt.v2CardBinding?.opened && !rt.v2StreamQuiescing) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (rt.v2StreamQuiescing && rt.v2StopIntentGate) {
          await rt.v2StopIntentGate
        }
      }
      finally {
        if (capTimer) clearTimeout(capTimer)
        if (rt.v2Controller === controller) rt.v2Controller = null
      }
      if (authority.blocked && rt.v2RunnerStopVerified !== true) {
        throw new Error('C2 v2 runner closure is unverified after shutdown')
      }
      if (!accepted) throw new Error('C2 v2 runner exited before trusted acceptance')
      // A wall-clock cap or shutdown may abort after the last result event but
      // before the child closes. The original result object remains the close
      // witness; the host projection must still classify the turn as stopped.
      const settledResult = controller.signal.aborted && result?.aborted === false
        ? { ...result, aborted: true } : result
      // Codex reports cumulative session usage. Use the same private-core
      // arithmetic as the legacy path, without writing session state before
      // terminal effects have been confirmed.
      const usage = settledResult?.result?.usage
      const usageDecision = usage ? settleUsage(
        this.store.getSessionStats?.(chatId) || null,
        settledResult?.sessionId || this.store.getSession(chatId) || null,
        settledResult.result) : null
      const outputTokens = Number(usageDecision?.tokens?.out) || 0
      const projected = projection.complete({ runnerResult: settledResult,
        outputTokens, resumedSessionCurrent: false })
      if (this.durableV2VerifyRunnerClosed) {
        const closed = authority.confirmRunnerClosed({ receiptId, chatId,
          turnToken, generation, verifyGeneration,
          assertRunnerClosed: () => rt.v2RunnerStopVerified === true })
        rt.v2RunnerCloseEvidenceId = closed.evidenceId
        if (usageDecision?.write &&
            (!projected.display.sessionId ||
              usageDecision.stats?.sessionId !== projected.display.sessionId)) {
          throw new Error('C2 v2 usage session identity unresolved after runner close')
        }
        const session = authority.commitClosedRunnerSession({ receiptId, chatId,
          turnToken, generation, verifyGeneration,
          sessionId: projected.display.sessionId || null,
          ...(usageDecision?.write ? { usageDecision } : {}),
          aborted: settledResult.aborted, assertWriterLock: this.durableV2AssertWriterLock,
          store: this.store })
        rt.v2SessionCloseEventId = session.eventId
      }
      rt.v2RunnerResult = settledResult // process-local only; no reply until terminal effect
      rt.v2TerminalProjection = projected
      rt.v2UsageDecision = usageDecision
      return { effectId, accepted: true, outputHeld: true }
    } catch (error) {
      if (capTimer) clearTimeout(capTimer)
      if (controller && rt.v2Controller === controller) rt.v2Controller = null
      const proofId = `sbot-c2-runner-not-started-v1:${receiptId}:${generation}`
      const eventId = `sbot-c2-runner-not-started-commit-v1:${receiptId}:${turnToken}:${generation}`
      const provenNotStarted = !accepted && error?.code === 'AGENT_BIN_MISSING' &&
        this.durableV2Journal?.lookupRunnerNotStarted(proofId)?.dispatchEffectId === effectId &&
        this.durableV2Journal?.hasEvent(eventId) === true
      if (provenNotStarted) {
        authority.close()
        await authority.open()
        if (authority.snapshot().receipts.pending.some(item => item.id === receiptId) ||
            !authority.snapshot().receipts.completed.some(item => item.id === receiptId)) {
          authority.close()
          throw new Error('C2 v2 unstarted runner receipt remains unsettled')
        }
        rt.v2RunnerGeneration = null
        rt.v2RunningJobs = null
        rt.v2DispatchEffect = null
        return { effectId, accepted: false, startFailureRecovered: true }
      }
      if (capability && !accepted) {
        try { capability.markUnknown() } catch { /* journal itself seals on failed write */ }
      }
      authority.close()
      throw error
    }
  }

async completeDurableV2CardTurn({ chatId, receiptId, turnToken, effectId,
    payload, replyText, paused = false, updates = [] } = {}) {
    const authority = this.durableV2Runtime
    const handles = this.durableV2Payloads
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    if (!authority || !handles || !this.durableV2StartTurn ||
        !this.durableV2ApplyLocalEffect || authority.blocked ||
        typeof paused !== 'boolean' || !Array.isArray(updates) ||
        !updates.every(text => typeof text === 'string')) {
      throw new Error('C2 v2 card terminal path is unavailable')
    }
    const snapshot = authority.snapshot()
    const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
    const binding = rt?.v2DispatchEffect
    const jobs = rt?.v2RunningJobs
    const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
    const job = cohort?.anchor
    const generation = rt?.v2RunnerGeneration
    const projected = rt?.v2TerminalProjection
    const resultText = projected?.payload?.resultText
    if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
        !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
        typeof effectId !== 'string' || !effectId ||
        typeof generation !== 'string' || !/^[0-9a-f]{32}$/.test(generation) ||
        typeof resultText !== 'string' ||
        rt.v2RunnerCloseEvidenceId !==
          `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
        rt.v2SessionCloseEventId !==
          `sbot-c2-session-close-v1:${receiptId}:${generation}` ||
        receipt?.source !== 'message' || receipt.chatId !== chatId ||
        snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
        snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
        snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
        binding?.type !== 'dispatch' || binding.effectId !== effectId ||
        binding.turnToken !== turnToken ||
        !cohort ||
        snapshot.effects?.get(effectId) !== 'acked' ||
        !Number.isSafeInteger(rt.v2StartedAt) || rt.v2StartedAt <= 0 ||
        job.msg.msgId !== receipt.sourceId ||
        job.msg.replyCtx?.chatId !== chatId ||
        job.msg.replyCtx.messageId !== receipt.sourceId ||
        (typeof job.platform?.createStreamingCard !== 'function' &&
          typeof job.platform?.replyOnce !== 'function') ||
        !payload || typeof payload !== 'object' || Array.isArray(payload) ||
        payload.type !== 'finalizeEffectCommit' ||
        payload.receiptId !== receiptId || payload.turnToken !== turnToken ||
        payload.quiet !== receipt.quiet || payload.resultText !== resultText ||
        (cohort.receiptIds.length > 1 &&
          (!isDeepStrictEqual(payload.batchReceiptIds, cohort.receiptIds) ||
            payload.replyTargetReceiptId !== receiptId)) ||
        !isDeepStrictEqual(payload, projected.payload) ||
        // The isolated bridge currently implements only a successful final
        // answer. An abort, provider error, quota or lost-session result needs
        // its own durable retry/failover/notice decision before any card call.
        payload.source !== 'result' || payload.aborted || payload.isError ||
        payload.sessionMissing || payload.hasQuota || payload.transientNetwork ||
        payload.freshRetried || payload.resumedSessionCurrent ||
        (replyText !== undefined && replyText !== terminalReplyText(projected.payload)) ||
        rt.v2TerminalStarted) {
      authority.close()
      throw new Error('C2 v2 card terminal differs from accepted turn')
    }
    rt.v2TerminalStarted = true
    const verifyGeneration = value => value.chatId === chatId &&
      value.receiptId === receiptId && value.turnToken === turnToken &&
      value.generation === generation && rt.v2RunnerGeneration === generation
    try {
      const preopened = rt.v2CardBinding
      if (preopened && (preopened.receiptId !== receiptId ||
          preopened.turnToken !== turnToken ||
          preopened.generation !== generation)) {
        throw new Error('C2 v2 streamed card differs from terminal turn')
      }
      const path = preopened?.path || prepareCardTerminalPath({ runtime: authority,
        payloadHandles: handles, platform: job.platform,
        replyCtx: job.msg.replyCtx, receiptId, chatId, turnToken, generation,
        verifyGeneration, applyLocalEffect: this.durableV2ApplyLocalEffect,
        assertWriterLock: this.durableV2AssertWriterLock,
        redactText: text => redact(text, { pii: job.group?.redactPii !== false }),
        sendPlainReply: typeof job.platform.replyOnce === 'function'
          ? (target, text) => job.platform.replyOnce(target.replyCtx, text)
          : null })
      const suppressCard = (payload.quiet || projected.display.silent) &&
        projected.display.assistantEvents === 0 && updates.length === 0
      if (!preopened) await path.open({ suppressCard })
      for (const text of updates) path.update(text)
      const footer = T.cardFooter({ ms: Math.max(0, Date.now() - rt.v2StartedAt),
        tokens: rt.v2UsageDecision?.tokens || null })
      const completed = await path.complete({ payload, replyText, paused, footer })
      const after = authority.snapshot()
      const queue = after.state?.lanes?.queue?.[chatId]?.queue
      let successor = null
      if (completed?.nextReceiptId === null) {
        if (!Array.isArray(completed.pendingEffects) ||
            completed.pendingEffects.length !== 0 ||
            !Array.isArray(queue) || queue.length !== 0 ||
            after.state?.lanes?.turn?.[chatId]?.active !== null ||
            after.state?.lanes?.handoff?.[chatId]?.phase !== 'idle' ||
            after.receipts.pending.some(item => item.chatId === chatId) ||
            !Array.isArray(rt.v2QueueReceiptIds) ||
            rt.v2QueueReceiptIds.length !== 0) {
          throw new Error('C2 v2 terminal successor lacks durable dispatch wiring')
        }
      } else {
        if (!this.durableV2Journal || !this.durableV2AssertWriterLock) {
          throw new Error('C2 v2 terminal successor lacks durable dispatch wiring')
        }
        const next = continueC2Successor({ runtime: authority,
          journal: this.durableV2Journal, payloadHandles: handles,
          chatId, priorReceiptId: receiptId, priorTurnToken: turnToken,
          terminalResult: completed, generation: randomBytes(16).toString('hex'),
          assertWriterLock: this.durableV2AssertWriterLock })
        if (!ordinaryV2Cohort(authority.snapshot(), next.jobs,
          { receiptIds: next.jobReceiptIds,
            batchReceiptIds: next.batchReceiptIds }, chatId, next.receiptId) ||
            !isDeepStrictEqual(rt.v2QueueReceiptIds,
              [...next.jobReceiptIds, ...next.queuedReceiptIds])) {
          throw new Error('C2 v2 successor jobs differ from queued host state')
        }
        successor = next
      }
      rt.v2RunnerResult = null
      rt.v2TerminalProjection = null
      rt.v2UsageDecision = null
      rt.v2StartedAt = null
      rt.v2CardBinding = null
      rt.v2StreamRequested = false
      rt.v2TimeoutProof = null
      rt.v2RunningJobs = null
      rt.v2RunnerGeneration = null
      rt.v2RunnerCloseEvidenceId = null
      rt.v2SessionCloseEventId = null
      rt.v2DispatchEffect = null
      rt.v2TurnToken = null
      rt.v2TerminalStarted = false
      if (successor) {
        rt.v2QueueReceiptIds = [...successor.queuedReceiptIds]
        rt.v2RunningJobs = [...successor.jobs]
        rt.v2TurnToken = successor.turnToken
        rt.v2DispatchEffect = { effectId: successor.effectId,
          type: 'dispatch', turnToken: successor.turnToken,
          receiptIds: [...successor.jobReceiptIds],
          batchReceiptIds: [...successor.batchReceiptIds] }
        return { ...completed, settledReceiptIds: cohort.receiptIds,
          successor: { receiptId: successor.receiptId,
          turnToken: successor.turnToken, effectId: successor.effectId,
          cursor: successor.cursor } }
      }
      return { ...completed, settledReceiptIds: cohort.receiptIds }
    } catch (error) { authority.close(); throw error }
  }

classifyDurableV2UnresolvedTurn({ chatId, receiptId, turnToken, effectId,
    payload } = {}) {
    const authority = this.durableV2Runtime
    const rt = typeof chatId === 'string' && chatId ? this._rt(chatId) : null
    if (!authority || authority.blocked || !rt ||
        typeof authority.commitUnresolvedClassification !== 'function') {
      throw new Error('C2 v2 unresolved classification is unavailable')
    }
    try {
      const snapshot = authority.snapshot()
      const receipt = snapshot.receipts?.pending?.find(item => item.id === receiptId)
      const binding = rt.v2DispatchEffect
      const jobs = rt.v2RunningJobs
      const cohort = ordinaryV2Cohort(snapshot, jobs, binding, chatId, receiptId)
      const generation = rt.v2RunnerGeneration
      if (!/^[0-9a-f]{32}$/.test(receiptId || '') ||
          !Number.isSafeInteger(turnToken) || turnToken <= 0 ||
          typeof effectId !== 'string' || !effectId ||
          typeof generation !== 'string' || !/^[0-9a-f]{32}$/.test(generation) ||
          rt.v2RunnerCloseEvidenceId !==
            `sbot-c2-runner-closed-v1:${receiptId}:${generation}` ||
          rt.v2SessionCloseEventId !==
            `sbot-c2-session-close-v1:${receiptId}:${generation}` ||
          receipt?.source !== 'message' || receipt.chatId !== chatId ||
          snapshot.state?.lanes?.turn?.[chatId]?.active !== turnToken ||
          snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running' ||
          snapshot.state.lanes.handoff[chatId].turnToken !== turnToken ||
          binding?.type !== 'dispatch' || binding.effectId !== effectId ||
          binding.turnToken !== turnToken ||
          !cohort ||
          snapshot.effects?.get(effectId) !== 'acked' ||
          cohort.anchor.msg.msgId !== receipt.sourceId ||
          !payload || typeof payload !== 'object' || Array.isArray(payload) ||
          !isDeepStrictEqual(payload, rt.v2TerminalProjection?.payload) ||
          rt.v2TerminalStarted) {
        throw new Error('C2 v2 unresolved classification differs from accepted turn')
      }
      const terminal = { ...payload, type: 'finalize' }
      delete terminal.receiptId
      delete terminal.turnToken
      delete terminal.quiet
      const status = engineTerminalStep({ finalized: false, outcome: null },
        terminal).state.outcome.status
      if (!['error', 'empty', 'stopped'].includes(status)) {
        throw new Error('C2 v2 unresolved classification needs error, empty or stopped outcome')
      }
      rt.v2TerminalStarted = true
      authority.registerTerminalCallback({ receiptId, generation,
        registeredAt: Date.now() })
      return authority.commitUnresolvedClassification({ receiptId, generation,
        turnToken, status, payload,
        verifyGeneration: value => value.chatId === chatId &&
          value.receiptId === receiptId && value.turnToken === turnToken &&
          value.generation === generation && rt.v2RunnerGeneration === generation,
        assertWriterLock: this.durableV2AssertWriterLock })
    } catch (error) { authority.close(); throw error }
  }

  _prepareRunnerPrompt({ msg, group, platform, providerName, provider, batch, rt }) {
    if (rt.cancelled) throw new Error('C2 v2 cancelled prompt lacks durable control event')
    const line = m => `[${fmtStamp(m.createTimeMs || Date.now(), this.tz)} ${m.senderName || m.userId || 'user'}] ${(m.text || '').trim()}`
    const policy = manifestPolicy(group.permissionMode, provider.runner === 'codex',
      group.allowedTools, group.disallowedTools)
    const brand = this.cfg.brand || 'SintBot'
    const info = group.repo && this.repoInfo ? this.repoInfo(group.workdir, group.repo) : null
    const manifest = [
      ...manifestHeader({ restrictedV2: true, brand, chatLabel: platform.chatLabel || '项目群',
        chatId: msg.chatId, groupName: group.name || msg.chatId,
        workdir: group.workdir, repo: group.repo || '', repoState: info?.state || '',
        repoOrigin: info?.origin || '未知', pushDenied: policy.pushDenied,
        providerName, model: group.model || provider.model || '',
        noVision: provider.vision === false, platformName: platform.chatLabel || '项目群',
        permissionTier: policy.tier, tz: this.tz, publicUrl: '', uiUrl: '', lanUrl: '' }),
      ...manifestContext({ restrictedV2: true, brand, isCodex: provider.runner === 'codex',
        pmem: this.projectMemory ? this.projectMemory(group.workdir,
          { full: policy.full, isCodex: provider.runner === 'codex' }) : null,
        unredactedPii: group.redactPii === false,
        cardPinned: platform.features?.cardPinned === true, plainSend: false }),
    ].join('\n')
    // Reinject current supported context each turn. No legacy feature menu,
    // external-message commands or v1 manifest refresh scheduler is included.
    return turnPrompt({ lines: batch?.length > 1 ? batch.map(line) : [line(msg)],
      cancelled: null, compacted: false, manifest, updated: false })
  }

  handleMessage() { throw new Error('legacy Engine execution path is not enabled') }

  stop(chatId) {
    const rt = this.rts.get(chatId)
    return rt?.v2NormalRouteActive ? this.requestDurableV2Stop(chatId) : false
  }

requestDurableV2Stop(chatId) {
    const rt = this.rts.get(chatId)
    if (!this.durableV2NormalRoute || !rt?.v2NormalRouteActive ||
        !rt.v2RunningJobs?.length || rt.v2TerminalStarted ||
        rt.v2CancelControl || rt.v2StopControl || rt.v2StreamQuiescing ||
        rt.v2TimeoutProof || !rt.v2Controller ||
        !this.durableV2Runtime || this.durableV2Runtime.blocked) return false
    try {
      if (this.durableV2AssertWriterLock() !== true) throw new Error('writer lock lost')
      const snapshot = this.durableV2Runtime.snapshot()
      const receiptId = rt.v2DispatchEffect?.receiptIds?.at(-1)
      if (!ordinaryV2Cohort(snapshot, rt.v2RunningJobs,
        rt.v2DispatchEffect, chatId, receiptId) ||
          snapshot.state?.lanes?.turn?.[chatId]?.active !== rt.v2TurnToken ||
          snapshot.state?.lanes?.handoff?.[chatId]?.phase !== 'running') {
        throw new Error('console stop differs from durable running cohort')
      }
      const controller = rt.v2Controller
      const generation = rt.v2RunnerGeneration
      let releaseGate
      rt.v2StopIntentGate = new Promise(resolve => { releaseGate = resolve })
      rt.v2StreamQuiescing = true
      rt.v2CancelControl = 'stop'
      Promise.resolve().then(async () => {
        if (rt.v2QueueNoticePromise) await rt.v2QueueNoticePromise
        await rt.v2StreamChain
        if (rt.v2CardBinding?.opened) {
          await rt.v2CardBinding.path.flushForTerminal()
        }
        if (rt.v2RunnerGeneration !== generation ||
            rt.v2TimeoutProof || this.durableV2AssertWriterLock() !== true) {
          throw new Error('console stop lost exact running turn')
        }
      }).catch(error => {
        this.durableV2Runtime.close()
        this.log(`group ${chatId}: durable console stop closed: ${error.message}`)
      }).finally(() => {
        try { controller.abort() } catch { this.durableV2Runtime.close() }
        releaseGate()
      })
      return true
    } catch (error) {
      this.durableV2Runtime.close()
      this.log(`group ${chatId}: durable stop closed: ${error.message}`)
      return false
    }
  }

  handleRecall({ chatId, msgId } = {}) {
    if (!chatId || !msgId) return false
    const rt = this.rts.get(chatId)
    if (!rt || !this.durableV2NormalRoute || !rt.v2NormalRouteActive) return false
    const authority = this.durableV2Runtime
    const receiptId = taskId({ source: 'message', chatId, sourceId: msgId })
    if (rt.v2QueueReceiptIds?.includes(receiptId)) {
      try {
        authority.commitQueuedCancellation({ receiptId, chatId, control: 'recall',
          payloadHandles: this.durableV2Payloads,
          assertWriterLock: this.durableV2AssertWriterLock })
        rt.v2QueueReceiptIds = rt.v2QueueReceiptIds.filter(id => id !== receiptId)
        return true
      } catch (error) { authority?.close(); this.log(error.message); return false }
    }
    if (rt.v2RunningJobs?.length === 1 &&
        rt.v2RunningJobs[0]?.msg?.msgId === msgId && !rt.v2TerminalStarted) {
      rt.v2CancelControl = 'recall'
      if (rt.v2Controller) { try { rt.v2Controller.abort() } catch { authority?.close() } }
      return true
    }
    return false
  }

}

module.exports = { Engine }
