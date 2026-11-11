// Codex 群默认走 App Server；显式关闭 codexSteer 时走 exec，Claude 群不受影响。
// 每轮独立起进程并等它干净退出，确保会话 rollout 落盘后才允许下一轮续接。

const { spawn } = require('node:child_process')
const closedRunnerResults = new WeakSet()
const isClosedRunnerResult = result => !!result && typeof result === 'object' && closedRunnerResults.has(result)
// A rejection raised from the child's own 'close' event: the process has
// exited even though the turn has no result. It never proves the turn's outcome.
const closedRunnerErrors = new WeakSet()
const isClosedRunnerError = error => !!error && typeof error === 'object' && closedRunnerErrors.has(error)
const closedError = error => { closedRunnerErrors.add(error); return error }
const { IS_WIN, resolveSpawn } = require('./winexec')
const { normalizeEvent, isEffortRejection } = require('./codexcode')
const { coreFailedResult, isCoreFailure } = require('./errtag')
const { HUMAN_BY_KIND, appErrorOverride, appNormalizeItem, appStreamTail, appNoticeAction, appDeltaNext, appLandedAction, appCompletionAction, appCompletionNoticeAction, appUsageFromTotal, appBuildRequest } = require('./privatecore')
const { version } = require('../../package.json')
const { StringDecoder } = require('node:string_decoder')

// 按 codex app-server 的协议定义(0.166 generate-json-schema)给出的拒绝回复;其余方法回 JSON-RPC 错误。
const SERVER_REQUEST_REPLIES = {
  'item/commandExecution/requestApproval': { decision: 'decline' },
  'item/fileChange/requestApproval': { decision: 'decline' },
  'mcpServer/elicitation/request': { action: 'decline' },
  'item/tool/requestUserInput': { answers: {} },
}

// App Server 报的是整条 thread 的累计量；交给引擎按已有基线扣成本轮用量。
function usageFromTotal(total) {
  return appUsageFromTotal(total)
}

function failedTurnEvent(error = {}) {
  const result = normalizeEvent({ type: 'turn.failed', error })
  const info = error.codexErrorInfo
  if (!result || !info || typeof info !== 'object') return result
  result.codexErrorInfo = info
  const kind = ['httpConnectionFailed', 'responseStreamConnectionFailed', 'responseStreamDisconnected', 'responseTooManyFailedAttempts']
    .find((key) => Object.hasOwn(info, key))
  const status = kind && Number(info[kind] && info[kind].httpStatusCode)
  const override = appErrorOverride(status, !!kind, !!result.quota, !!result.sessionMissing, !!result.transient)
  // 结构化的 401 是账号证据:与共享错误判定同一优先级(账号 > 瞬时错)。
  if (override === 'account') {
    result.quota = { kind: 'account', window: null }; delete result.transient; delete result.transientKind
  } else if (override) {
    // 原话没有命中时使用结构化兜底；群面人话仍由 JS 映射。
    result.transientKind = override
    result.transient = HUMAN_BY_KIND[result.transientKind]
  }
  return result
}

// 保持现有引擎的事件形状，卡片、步数和压缩提醒才可沿用同一套逻辑。
function itemEvent(method, item) {
  const result = appNormalizeItem(method, item)
  if (result === null) return null
  // Preserve missing JS properties and the original item identity at the
  // public event boundary; JSON cannot encode undefined or object references.
  if (method !== 'item/completed' && item.type === 'commandExecution') result.tools[0].input.command = item.command
  else if (method !== 'item/completed' && item.type === 'fileChange') (item.changes || []).forEach((change, i) => { result.tools[i].input.path = change.path })
  else if (method !== 'item/completed' && (item.type === 'mcpToolCall' || item.type === 'webSearch')) result.tools[0].input = item
  return result
}

// App Server 的请求和通知共用一条 stdout 流；单轮独立进程使关闭成为续接边界。
function runTurn(opts = {}) {
  const {
    bin = 'codex', prompt, provider = {}, model, effort: wantEffort, workdir, sessionId,
    permissionMode, autocompactTokens, appendSystemPrompt, codexApp, codexProjectDocFallback, extraEnv,
    onEvent, onDurableEvent, onSteerReady, onSteerLanded, onTurnAccepted, onSpawnFailed, signal, log = () => {},
    softStopGraceMs = 10000, spawnFn = spawn,
  } = opts
  if (!prompt) return Promise.reject(new Error('runTurn: prompt required'))
  if (onDurableEvent !== undefined && typeof onDurableEvent !== 'function') return Promise.reject(new TypeError('onDurableEvent must be a function'))
  if (onSpawnFailed !== undefined && typeof onSpawnFailed !== 'function') return Promise.reject(new TypeError('onSpawnFailed must be a function'))

  return new Promise((resolve, reject) => {
    const env = { ...process.env, ...(extraEnv || {}) }
    delete env.CLAUDECODE
    delete env.OPENAI_API_KEY // 只使用机器现有的 ChatGPT 订阅登录态，与 codex exec 一致。
    const args = ['app-server', '-c', 'approval_policy=never']
    if (Number.isSafeInteger(provider.contextWindowTokens) && provider.contextWindowTokens > 0) args.push('-c', `model_context_window=${provider.contextWindowTokens}`)
    if (autocompactTokens > 0) args.push('-c', `model_auto_compact_token_limit=${autocompactTokens}`)
    const { file, spawnArgs, fallback } = resolveSpawn(bin, args)
    if (fallback) log(`配置的 agent 路径 '${bin}' 不存在,本轮改用 ${fallback}`)
    let child
    try {
      child = spawnFn(file, spawnArgs, { env, cwd: workdir || process.cwd(), stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (e) { reject(e); return }

    let capturedSessionId = sessionId || null
    let activeTurnId = null
    let lastAgentText = ''
    let lastResult = null
    let totalUsage = null
    let contextTokens = 0
    let contextWindowTokens = 0
    let contextCompacted = false
    let stderr = ''
    let buf = ''
    let nextId = 1
    let aborted = false
    let childCloseObserved = false
    let settled = false
    let completed = false
    const configuredEffort = wantEffort || provider.reasoningEffort || ''
    let effort = configuredEffort
    let retriedEffort = false
    let pendingTurnStart = false
    let acceptedTurnId = null
    // Pre-turn rejection witness: the server answered initialize or the
    // thread request with an RPC error before any turn/start was written and
    // before any durable event. Only the child's own close completes it.
    let turnStartWritten = false
    let durableEmitted = false
    let preTurnRejection = null
    const deferredTurnNotices = []
    let deferredInit = null
    const earlyCompleted = new Map()
    let graceTimer = null
    let durableWork = Promise.resolve()
    let streamWork = Promise.resolve()
    let durableFailed = false
    const requests = new Map()
    const landed = new Set() // 重复通知只确认一次，避免一个补充被重复记进账本。
    const messageDeltas = new Map()
    const pendingUsage = new Map()
    const legacyEmit = (ev) => { if (ev && onEvent) { try { onEvent(ev) } catch {} } }
    const emit = (ev) => {
      if (!ev) return
      if (!onDurableEvent) { legacyEmit(ev); return }
      durableEmitted = true
      durableWork = durableWork.then(async () => {
        let timer
        try {
          await Promise.race([
            Promise.resolve().then(() => onDurableEvent(ev)),
            new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Codex app-server durable event hook timed out')), 10000) }),
          ])
        } finally { clearTimeout(timer) }
        if (!durableFailed && !settled) legacyEmit(ev)
      })
      durableWork.catch(failDurableEvent)
    }
    const recordUsage = (usage = {}) => {
      totalUsage = usageFromTotal(usage.total)
      if (Number.isFinite(usage.last && usage.last.inputTokens) && usage.last.inputTokens > 0) contextTokens = usage.last.inputTokens
      if (Number.isFinite(usage.modelContextWindow) && usage.modelContextWindow > 0) contextWindowTokens = usage.modelContextWindow
      // Observational only: do not add telemetry to the durable transcript.
      if (!completed && contextTokens > 0) legacyEmit({ type: 'system', subtype: 'context',
        sessionId: capturedSessionId, contextTokens, contextWindowTokens })
    }
    const write = (obj) => {
      if (child.stdin.destroyed) throw new Error('codex app-server stdin closed')
      child.stdin.write(JSON.stringify(obj) + '\n')
    }
    const request = (method, params) => new Promise((ok, fail) => {
      const id = nextId++
      requests.set(id, { ok, fail })
      try { write({ id, method, params }) } catch (e) { requests.delete(id); fail(e) }
    })
    const deactivate = () => { activeTurnId = null } // 完成/中止后立即拒绝晚到的补充。
    const control = {
      async steerDurable({ msgId, text }) {
        const turnId = activeTurnId
        if (!turnId || completed || aborted) return false
        try {
          await request('turn/steer', { threadId: capturedSessionId, expectedTurnId: turnId,
            clientUserMessageId: msgId, input: [{ type: 'text', text }] })
          return true
        } catch (error) {
          if (error?.codexRpcRejected === true) return false
          throw error
        }
      },
      async steer({ msgId, text }) {
        const turnId = activeTurnId
        if (!turnId || completed || aborted) return false
        try {
          await request('turn/steer', {
            threadId: capturedSessionId, expectedTurnId: turnId,
            clientUserMessageId: msgId || undefined,
            input: [{ type: 'text', text }],
          })
          return true
        } catch (e) {
          log(`codex steer rejected: ${String(e && e.message || e).slice(0, 250)}`)
          return false
        }
      },
      get turnId() { return activeTurnId },
    }
    const failPending = (error) => {
      for (const p of requests.values()) p.fail(error)
      requests.clear()
    }
    const settle = (fn) => {
      if (settled) return
      settled = true
      deactivate()
      if (graceTimer) clearTimeout(graceTimer)
      if (signal) signal.removeEventListener('abort', onAbort)
      failPending(new Error('codex app-server closed'))
      fn()
    }
    const resolveRun = result => {
      if (childCloseObserved) closedRunnerResults.add(result)
      resolve(result)
    }
    const killChild = () => {
      if (IS_WIN && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
      }
      try { child.kill('SIGTERM') } catch {}
      // 和 exec runner 一样有硬杀兜底，避免子进程忽略 TERM 后拖住关闭。
      const hardKill = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, softStopGraceMs)
      hardKill.unref?.()
    }
    const failDurableEvent = (error) => {
      if (durableFailed || settled) return
      durableFailed = true
      completed = true
      deactivate()
      killChild()
      settle(() => reject(error))
    }
    // A durable turn whose initialize or thread request the server itself
    // rejected never wrote turn/start and emitted nothing, so no model turn
    // and no tool ran. Stop reading, let the child exit, and report the
    // narrow witness only from the child's close event.
    const canWitnessPreTurnRejection = (error) => !!onDurableEvent && !!onTurnAccepted &&
      !!onSpawnFailed && error?.codexRpcError === true && !turnStartWritten &&
      !pendingTurnStart && !acceptedTurnId && !activeTurnId && !durableEmitted &&
      !aborted && !completed && !durableFailed && !settled && !childCloseObserved
    const rejectBeforeTurn = (error) => {
      preTurnRejection = error
      durableFailed = true
      completed = true
      deactivate()
      try { child.stdin.end() } catch {}
      child.stdout.resume?.()
      killChild()
    }
    const witnessPreTurnRejection = () => settle(() => {
      const message = String(preTurnRejection?.message || 'Codex RPC error')
      let acknowledged
      try {
        acknowledged = onSpawnFailed({ backend: 'codex-app-server', code: 'THREAD_REJECTED',
          turnStarted: false, closed: true })
      } catch (witnessError) { reject(closedError(witnessError)); return }
      if (acknowledged !== true) {
        reject(closedError(new Error('Codex pre-turn rejection witness was not confirmed synchronously')))
        return
      }
      log(`codex app-server rejected the thread before any turn started: ${message.slice(0, 300)}`)
      reject(closedError(Object.assign(new Error(message), { code: 'AGENT_THREAD_REJECTED' })))
    })
    const onAbort = () => {
      aborted = true
      deactivate()
      killChild()
      graceTimer = setTimeout(() => {
        const complete = () => settle(() => resolveRun({ sessionId: capturedSessionId, result: lastResult, code: null, aborted: true }))
        if (onDurableEvent) streamWork.then(() => durableWork).then(complete, failDurableEvent)
        else complete()
      }, softStopGraceMs)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }
    child.stdin.on('error', () => {})

    const start = async () => {
      await request('initialize', { clientInfo: { name: 'sintbot', title: 'SintBot', version } })
      write({ method: 'initialized', params: {} })
      const threadRequest = appBuildRequest({ phase: 'thread', workdir: workdir || process.cwd(),
        model, providerModel: provider.model, permissionMode, autocompactTokens,
        codexProjectDocFallback, codexApp, appendSystemPrompt, sessionId })
      const thread = await request(threadRequest.method, threadRequest.params)
      capturedSessionId = thread && thread.thread && thread.thread.id || capturedSessionId
      if (!capturedSessionId) throw new Error('codex app-server returned no thread id')
      if (Array.isArray(thread.instructionSources)) {
        const sources = thread.instructionSources
        if (sources.length) log(`codex project instructions (${capturedSessionId}): ${sources.join(', ')}`)
        else if (!sessionId) log(`codex project instructions (${capturedSessionId}): none loaded`)
      }
      const initEvent = { type: 'system', subtype: 'init', sessionId: capturedSessionId }
      if (onTurnAccepted) deferredInit = initEvent
      else { emit(initEvent); if (onDurableEvent) await durableWork }
      await startModelTurn()
    }
    const startModelTurn = async () => {
      const turnRequest = appBuildRequest({ phase: 'turn', sessionId: capturedSessionId,
        isResume: !!sessionId, prompt, appendSystemPrompt, codexApp,
        model, providerModel: provider.model, effort, workdir: workdir || process.cwd(), permissionMode })
      pendingTurnStart = true
      turnStartWritten = true
      let turn
      try { turn = await request(turnRequest.method, turnRequest.params) }
      finally { pendingTurnStart = false }
      activeTurnId = turn && turn.turn && turn.turn.id
      if (!activeTurnId) throw new Error('codex app-server returned no turn id')
      if (onTurnAccepted) {
        try {
          const accepted = onTurnAccepted({ channel: 'codex-app-server', sessionId: capturedSessionId, turnId: activeTurnId })
          if (accepted && typeof accepted.then === 'function') throw new Error('onTurnAccepted must persist synchronously')
          acceptedTurnId = activeTurnId
        } catch (error) {
          aborted = true
          completed = true
          deactivate()
          killChild()
          settle(() => reject(error))
          return
        }
        if (deferredInit) { emit(deferredInit); deferredInit = null; if (onDurableEvent) await durableWork }
        for (const notice of deferredTurnNotices.splice(0)) {
          handleLine(notice)
          if (onDurableEvent) await durableWork
        }
      }
      if (pendingUsage.has(activeTurnId)) recordUsage(pendingUsage.get(activeTurnId))
      pendingUsage.clear()
      const done = earlyCompleted.get(activeTurnId)
      earlyCompleted.clear()
      if (done) {
        completedTurn(done)
        if (onDurableEvent) await durableWork
        return
      }
      if (onSteerReady) { try { onSteerReady(control) } catch {} }
    }
    const completedTurn = (turn) => {
      const matchesTurn = !!turn && turn.id === activeTurnId
      if (!matchesTurn || completed) return
      const failed = turn.status === 'failed' && effort && !retriedEffort ? failedTurnEvent(turn.error || {}) : null
      const action = appCompletionAction(turn.status, matchesTurn, completed, !!effort, retriedEffort || !!onTurnAccepted,
        !!failed && isEffortRejection(failed))
      if (action === 0) return
      deactivate()
      if (action === 1) {
        retriedEffort = true
        const rejectedEffort = effort
        effort = ''
        log(`codex 推理强度 '${rejectedEffort}' 不被当前模型/套餐接受 — 已回退模型默认重试一轮`)
        startModelTurn().catch((e) => fatal(e))
        return
      }
      completed = true
      if (action === 2) lastResult = failed || failedTurnEvent(turn.error || {})
      else if (action === 3) { aborted = true; lastResult = null }
      else lastResult = { type: 'result', subtype: 'success', text: lastAgentText, usage: totalUsage, usageCumulative: !!totalUsage,
        contextTokens, contextWindowTokens, contextCompacted }
      if (lastResult && retriedEffort) lastResult.effortFellBack = configuredEffort
      if (lastResult) emit(lastResult)
      // 让服务端自行落盘退出；收到完成通知就强杀会破坏下一轮 resume。
      try { child.stdin.end() } catch {}
    }
    const fatal = (e) => {
      if (completed || aborted || settled) return
      completed = true
      deactivate()
      const message = String(e && e.message || e)
      if (isCoreFailure(e)) log(`binary core failed in codex app-server stream: ${message}`)
      try { lastResult = isCoreFailure(e) ? coreFailedResult(sessionId || null) : normalizeEvent({ type: 'error', message }) }
      catch (error) { log(`binary core failed on codex app-server error: ${error && error.message}`); lastResult = coreFailedResult(sessionId || null) }
      // 新会话传输失败时不能保存 thread id，否则下一轮可能续接不存在的 rollout。
      if (!sessionId) capturedSessionId = null
      emit(lastResult)
      try { child.stdin.end() } catch {}
    }
    const stdoutDecoder = new StringDecoder('utf8') // 一个汉字可能被拆在两个分块里,逐块 toString 会变成乱码
    // 这段回调不在任何 Promise 链里,抛错会直接带走整个进程 ⇒ 核心失败只结束当前轮。
    // 已完成的轮 fatal 会直接返回,结果不受影响。
    const handleLine = (raw) => {
      if (preTurnRejection) return // the turn never started; later output is discarded
      // 对方主动发来的请求同时带 id 和 method:id 是对方的号段,可能与我们的请求相撞,绝不能当响应处理;
      // 不回应它就会一直等,这一轮挂到超时。无人值守,按协议一律拒绝。
      if (raw.id != null && raw.method) {
        const reply = SERVER_REQUEST_REPLIES[raw.method]
        log(`codex server request declined: ${raw.method}`)
        try { write(reply ? { id: raw.id, result: reply } : { id: raw.id, error: { code: -32601, message: `unsupported in headless mode: ${raw.method}` } }) } catch {}
        return
      }
      if (raw.id != null) {
        const p = requests.get(raw.id)
        if (p) { requests.delete(raw.id); raw.error ? p.fail(Object.assign(new Error(raw.error.message || 'Codex RPC error'), { codexRpcError: true, codexRpcRejected: [-32600, -32601, -32602].includes(raw.error.code) })) : p.ok(raw.result) }
        return
      }
      if (onTurnAccepted && pendingTurnStart && !acceptedTurnId) {
        deferredTurnNotices.push(raw)
        return
      }
      const params = raw.params || {}
      const action = appNoticeAction(raw.method, {
        threadMatches: params.threadId === capturedSessionId,
        turnMatches: params.turnId === activeTurnId,
        activeTurn: !!activeTurnId,
        completed, codexApp,
        hasTurnId: !!params.turnId,
        hasItemId: !!params.itemId,
      })
      if (action === 1) recordUsage(params.tokenUsage)
      else if (action === 2) pendingUsage.set(params.turnId, params.tokenUsage)
      else if (action === 3) {
        const delta = String(params.delta || '')
        const next = appDeltaNext(messageDeltas.get(params.itemId) || '', delta)
        if (next !== null) {
          messageDeltas.set(params.itemId, next)
          emit({ type: 'assistant', text: delta,
            ...(contextTokens > 0 ? { contextTokens, contextWindowTokens, contextSampled: false } : {}) })
        }
      } else if (action === 4) {
        const item = params.item
        if (params.turnId === activeTurnId && params.threadId === capturedSessionId && appLandedAction(item && item.type, raw.method === 'item/completed', !!(item && item.clientId), !!(item && landed.has(item.clientId)))) {
          landed.add(item.clientId)
          if (onSteerLanded) { try { onSteerLanded(item.clientId) } catch {} }
        }
        let ev = itemEvent(raw.method, item)
        if (ev && ev.type === 'system' && ev.subtype === 'compact') {
          if (contextTokens > 0) ev.preTokens = contextTokens
          contextCompacted = true
          contextTokens = 0 // 压缩后未收到新用量前，旧数不能冒充当前上下文。
        }
        if (ev && ev.type === 'assistant' && ev.text && item.type === 'agentMessage') {
          lastAgentText = ev.text
          const streamed = messageDeltas.get(item.id) || ''
          if (streamed) {
            const tail = appStreamTail(ev.text, streamed)
            if (tail !== null) ev = { ...ev, text: tail }
            else {
            // An authoritative completion can differ from streamed fragments; avoid duplicating the answer.
              log(`codex message delta mismatch (${capturedSessionId}, ${item.id})`)
              ev = null
            }
          }
          messageDeltas.delete(item.id)
        }
        emit(ev)
      } else if (action === 5) {
        const turnId = params.turn && params.turn.id
        const decision = appCompletionNoticeAction({
          threadMatches: params.threadId === capturedSessionId,
          hasTurnId: !!turnId,
          activeTurn: !!activeTurnId,
          activeTurnMatches: turnId === activeTurnId,
          pendingStart: pendingTurnStart,
          completed,
        })
        if (decision === 1) completedTurn(params.turn)
        else if (decision === 2) earlyCompleted.set(turnId, params.turn)
      }
    }
    let coreFailed = false
    const processChunk = async (chunk) => {
      if (coreFailed || durableFailed || (onDurableEvent && settled)) return
      buf += stdoutDecoder.write(chunk)
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        let raw; try { raw = JSON.parse(line) } catch { continue }
        try {
          handleLine(raw)
          if (onDurableEvent) {
            // An RPC response resumes startModelTurn in a microtask; let it
            // enqueue the deferred init event before reading another line.
            await Promise.resolve()
            await durableWork
          }
        } catch (error) {
          if (onDurableEvent) { failDurableEvent(error); return }
          coreFailed = true
          buf = ''
          fatal(error)
          return
        }
      }
    }
    child.stdout.on('data', (chunk) => {
      if (preTurnRejection) return // keep the pipe flowing so the child's close is observed
      if (!onDurableEvent) { processChunk(chunk).catch(fatal); return }
      child.stdout.pause?.()
      streamWork = streamWork.then(() => processChunk(chunk)).catch(failDurableEvent).finally(() => {
        if (!durableFailed && !settled) child.stdout.resume?.()
      })
    })
    child.stderr.on('data', (c) => { stderr = (stderr + c.toString('utf8')).slice(-2000) })
    child.on('error', (e) => {
      if (e.code === 'ENOENT') e = Object.assign(new Error('模型程序在这台机器上找不到了,需要管理员处理'), { code: 'AGENT_BIN_MISSING' })
      settle(() => reject(e))
    })
    const completeClose = (code) => settle(() => {
      if (onDurableEvent && !completed && !aborted) {
        if (acceptedTurnId) {
          // No synthetic result: retain the distinction between process
          // closure and model completion for the durable terminal reducer.
          resolveRun({ sessionId: capturedSessionId, result: null, code, aborted })
          return
        }
        reject(closedError(new Error(`codex app-server exited ${code} before a durable result`)))
        return
      }
      if (!completed && !aborted) {
        try { lastResult = normalizeEvent({ type: 'error', message: `codex app-server exited ${code}: ${stderr.trim().slice(-800) || '(no stderr)'}` }) }
        catch (error) { log(`binary core failed on codex app-server exit: ${error && error.message}`); lastResult = coreFailedResult(sessionId || null) }
        if (!sessionId) capturedSessionId = null
      }
      resolveRun({ sessionId: capturedSessionId, result: lastResult, code, aborted })
    })
    child.on('close', (code) => {
      childCloseObserved = true
      if (preTurnRejection) { witnessPreTurnRejection(); return }
      if (onDurableEvent) streamWork.then(() => durableWork).then(() => { if (!durableFailed) completeClose(code) }, failDurableEvent)
      else completeClose(code)
    })
    start().catch((error) => {
      if (onDurableEvent) {
        if (canWitnessPreTurnRejection(error)) { rejectBeforeTurn(error); return }
        failDurableEvent(error); return
      }
      if (onTurnAccepted && !acceptedTurnId && !settled) {
        aborted = true
        completed = true
        deactivate()
        killChild()
        settle(() => reject(error))
      } else fatal(error)
    })
  })
}

module.exports = { runTurn, isClosedRunnerResult, isClosedRunnerError, usageFromTotal, itemEvent, failedTurnEvent }
