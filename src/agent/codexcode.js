// codexcode AgentRunner — drives OpenAI Codex CLI as sbot's GPT backend (Route B).
//
// Unlike claudecode (env-swap the model brain under ONE Claude Code harness), GPT
// runs on Codex's OWN agent harness: sbot spawns headless `codex exec --json` over
// stdio and parses the JSONL event stream. Auth is AMBIENT — the machine's
// `codex login` (ChatGPT coding-plan subscription); sbot holds no key. Selected per
// provider via `runner: "codex"`. See DESIGN.md §1 + docs/CODEX-RUNNER.md.
//
// Verified on Windows 2026-07-07 (codex-cli 0.142.5, ChatGPT subscription): the
// spawn shape, event types, resume, and sandbox tiers below are all real-machine
// confirmed. The event mapping mirrors the samples captured there.

const { spawn } = require('node:child_process')
const closedRunnerResults = new WeakSet()
const isClosedRunnerResult = result => !!result && typeof result === 'object' && closedRunnerResults.has(result)
// A rejection raised from the child's own 'close' event: the process has
// exited even though the turn has no result. It never proves the turn's outcome.
const closedRunnerErrors = new WeakSet()
const isClosedRunnerError = error => !!error && typeof error === 'object' && closedRunnerErrors.has(error)
const closedError = error => { closedRunnerErrors.add(error); return error }
const { StringDecoder } = require('node:string_decoder')
const { IS_WIN, resolveSpawn } = require('./winexec')
const { tagError } = require('./errtag') // 出错原话 → quota / sessionMissing / transient 之一(优先级只在那一处定),与 claude runner 共用
const { sandboxTier, codexBuildPrompt, codexBuildArgs, codexNormalizeEvent, codexParseError, codexEffortRejection } = require('./privatecore')
const { coreFailedResult } = require('./errtag')

// Warn only when the answer→close (rollout-flush) lag is abnormally high. Real-machine
// data (Windows, codex 0.142.5) clustered at ~2.0–3.2s, so healthy turns stay silent and
// only a ~2.5x+ regression surfaces — early notice long before the engine's 20s
// hardReleaseMs backstop would force-release (and forfeit the rollout).
const CLOSE_LAG_WARN_MS = 8000

// sbot's per-group permissionMode → Codex sandbox tier. Codex exec has NO per-tool
// allow/deny (that's Claude-only), only a coarse sandbox; and on Windows there is no
// workspace-write sandbox helper (verified: only read-only / full-access work). So
// map the two never-hang modes sbot already exposes per group:
//   bypassPermissions (= sbot "no directory fence, full trust") → danger-full-access
//   anything else (dontAsk default, fail-closed)                → read-only
// approval_policy is ALWAYS "never": `codex exec` has no approval IPC, so any other
// value would block on a TTY prompt that never comes.
function sandboxMode(permissionMode) {
  return sandboxTier(permissionMode)
}

// A codex error message is often a raw JSON blob, e.g.
//   {"error":{"message":"Unsupported value: 'minimal' is not supported with the
//    'gpt-5.6-terra' model. Supported values are: …","param":"reasoning.effort",…}}
// Extract the human message (so a group never sees raw JSON) and the offending param
// (so the runner can recover from a rejected reasoning effort — see isEffortRejection).
function parseCodexError(rawMsg) {
  return codexParseError(rawMsg)
}

// Map one raw `codex exec --json` event to a normalized AgentEvent (interfaces.js),
// or null for bookkeeping events to ignore. `turn.completed` carries usage but NOT
// the final text — Codex streams the answer as `agent_message` items, so the caller
// fills result.text from the last one.
function normalizeEvent(ev) {
  const result = codexNormalizeEvent(ev)
  if (result === null) return null
  // JSON cannot carry undefined. Preserve the frozen runner's public shape.
  if (ev.type === 'thread.started') result.sessionId = ev.thread_id
  else if (ev.type === 'turn.completed') result.usage = ev.usage
  else if (ev.type === 'error') result.raw = ev
  else if (ev.type === 'item.started' && result.type === 'assistant' && result.tools) {
    const item = ev.item || {}
    if (item.type === 'command_execution') result.tools[0].input.command = item.command
    else if (item.type === 'file_change') (item.changes || []).forEach((change, i) => { result.tools[i].input.path = change.path })
    else if (!item.type) result.tools[0].name = item.type
  }
  if (result.type === 'result' && result.isError) tagError(result, parseCodexError(ev.type === 'error' ? ev.message : ev.error && ev.error.message).text)
  return result
}

// Prepend sbot's system prompt / conventions into the user prompt — FIRST TURN ONLY.
// `codex exec` has no --append-system-prompt; the prompt text is the only channel.
// On resume the convention persists in-session, so it isn't re-sent.
function buildPrompt(prompt, appendSystemPrompt, isResume) {
  return codexBuildPrompt(prompt, appendSystemPrompt, isResume)
}

// Build the argv for `codex exec`. Fresh and resume differ in verified ways (Windows
// 2026-07-07): resume takes `resume <id>`, REJECTS `--sandbox` (use `-c sandbox_mode=`)
// and `--cd` (relies on process cwd); fresh accepts `--sandbox` + `--cd`. Prompt rides
// on stdin (trailing `-`), dodging Windows argv mangling of arbitrary chat text.
function buildArgs({ sessionId, model, workdir, permissionMode, reasoningEffort, autocompactTokens, contextWindowTokens }) {
  const args = codexBuildArgs({ sessionId, model, workdir, permissionMode, reasoningEffort, autocompactTokens })
  if (Number.isSafeInteger(contextWindowTokens) && contextWindowTokens > 0) args.unshift('-c', `model_context_window=${contextWindowTokens}`)
  return args
}

// A codex turn.failed / error result whose offending param is the reasoning effort —
// i.e. the configured `model_reasoning_effort` isn't accepted by the current model/plan.
// (model/list advertises a model's full effort catalog, but the runtime API narrows it by
// plan: e.g. a Plus account's gpt-5.6-terra rejects max/ultra though model/list lists them.)
function isEffortRejection(result) {
  return codexEffortRejection(result)
}

/**
 * Run a single Codex agent turn. Same contract as claudecode.runTurn (interfaces.js).
 * A thin wrapper over runOnce that adds ONE graceful recovery: if the turn fails solely
 * because the configured reasoning effort is rejected (plan/model gating), retry once
 * without the effort so the group still gets an answer on the model's default instead of
 * a dead turn. The effort error is a request-validation 400 that fires before any rollout
 * write, so the original session shape (fresh→fresh, resume→resume) is safe to reuse.
 * @param {import('../core/interfaces').RunTurnOptions} opts
 * @returns {Promise<import('../core/interfaces').RunTurnResult>}
 */
function runTurn(opts = {}) {
  const wantEffort = (opts.provider && opts.provider.reasoningEffort) || ''
  if (!wantEffort) return runOnce(opts, '')
  // Attempt 1 with the configured effort. Hold back only ERROR result events so a
  // recoverable effort-rejection can't finalize the turn early (the engine finalizes on
  // the first result event, idempotently — an early error would swallow the retry's
  // success). SUCCESS results pass through immediately, preserving prompt finalize.
  let heldErr = null
  let retrySafe = true
  // A rejected request is safe to resubmit only before Codex emits any item or
  // successful turn event. Inspect raw events because some completed items do not
  // produce a normalized event (for example, file_change).
  const observeFirstAttempt = (raw) => {
    // Once the durable runner-start receipt is acknowledged, even a later
    // request-validation error cannot launch a second process under that receipt.
    if ((opts.onTurnAccepted || opts.onDurableEvent) && raw.type === 'turn.started') retrySafe = false
    if (!['thread.started', 'turn.started', 'turn.failed', 'error'].includes(raw.type)) retrySafe = false
  }
  const proxy = opts.onEvent
    ? (ev) => { if (ev && ev.type === 'result' && ev.isError) { heldErr = ev; return } opts.onEvent(ev) }
    : undefined
  return runOnce({ ...opts, onEvent: proxy, onRawEvent: observeFirstAttempt }, wantEffort).then((res) => {
    if (retrySafe && heldErr && isEffortRejection(res.result) && !res.aborted) {
      if (opts.log) opts.log(`codex 推理强度 '${wantEffort}' 不被当前模型/套餐接受(model/list 报模型上限,运行时按套餐收窄)— 已回退模型默认重试一轮`)
      // 引擎在 result 事件到达时就定稿卡片(不等进程关闭);回退身份必须随事件走,
      // 只在 Promise 返回值上加 effortFellBack 会让页脚误报刚被拒绝的强度。
      const retryOpts = opts.onEvent
        ? { ...opts, onEvent: (ev) => opts.onEvent(ev && ev.type === 'result' ? { ...ev, effortFellBack: wantEffort } : ev) }
        : opts
      return runOnce(retryOpts, '').then((r2) => {
        const retried = { ...r2, result: r2.result ? { ...r2.result, effortFellBack: wantEffort } : r2.result, effortFellBack: wantEffort }
        if (isClosedRunnerResult(r2)) closedRunnerResults.add(retried)
        return retried
      })
    }
    // Not recoverable: the resolved result carries the (readable) error; the engine's
    // post-await finalizeTurn fallback reports it (attempt 1 never emitted it via onEvent).
    return res
  })
}

/**
 * One `codex exec` invocation. `effort` overrides provider.reasoningEffort in the argv
 * ('' ⇒ no override ⇒ codex uses the model default). Resolves on process CLOSE, never on
 * turn.completed (codex finalizes its resumable rollout on clean exit).
 */
function runOnce(opts, effort) {
  const {
    bin = 'codex',
    prompt,
    provider = {},
    model,
    workdir,
    sessionId,
    permissionMode,
    autocompactTokens,
    appendSystemPrompt,
    extraEnv,
    onEvent,
    onDurableEvent,
    onRawEvent,
    onTurnAccepted,
    onSpawnFailed,
    signal,
    softStopGraceMs = 10000,
    log = () => {}, // daemon logger — warns when the answer→close (rollout-flush) lag is high
    now = () => Date.now(), // injectable clock (deterministic lag tests)
    spawnFn = spawn, // injectable for tests
  } = opts || {}
  return new Promise((resolve, reject) => {
    if (!prompt) return reject(new Error('runTurn: prompt required'))
    if (onTurnAccepted !== undefined && typeof onTurnAccepted !== 'function') return reject(new TypeError('onTurnAccepted must be a function'))
    if (onDurableEvent !== undefined && typeof onDurableEvent !== 'function') return reject(new TypeError('onDurableEvent must be a function'))
    if (onSpawnFailed !== undefined && typeof onSpawnFailed !== 'function') return reject(new TypeError('onSpawnFailed must be a function'))

    const env = { ...process.env }
    delete env.CLAUDECODE // don't let a nested Claude Code session confuse the child
    // This runner IS the ChatGPT-subscription path (the codex provider carries no key).
    // Clear an inherited OPENAI_API_KEY so codex always uses the machine's `codex login`
    // and can never fall through to surprise per-token API billing — same principle as
    // claudecode clearing inherited ANTHROPIC_*.
    delete env.OPENAI_API_KEY
    // Engine-injected context (SBOT_CHAT_ID for the feishu base skill, etc.). SBOT_*-namespaced,
    // so no collision with codex's own env. read-only sandbox can't run the command anyway.
    if (extraEnv) Object.assign(env, extraEnv)

    const args = buildArgs({ sessionId, model: model || provider.model, workdir, permissionMode, reasoningEffort: effort, autocompactTokens, contextWindowTokens: provider.contextWindowTokens })
    const { file, spawnArgs, fallback } = resolveSpawn(bin, args)
    if (fallback) log(`配置的 agent 路径 '${bin}' 不存在,本轮改用 ${fallback} —— 请把配置改回正确路径`) // 与 claude runner 同一条兜底
    const child = spawnFn(file, spawnArgs, {
      env,
      cwd: workdir || process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    })

    // Prompt via stdin (see the trailing `-`). Close stdin so `codex exec` starts.
    child.stdin.on('error', () => { /* child may exit before the write drains */ })
    child.stdin.end(buildPrompt(prompt, appendSystemPrompt, !!sessionId))

    let capturedSessionId = sessionId || null
    let lastAgentText = ''
    let lastResult = null
    let buf = ''
    let stderr = ''
    // ③ codex 收尾时序(下一步): time from the answer (turn.completed) to process close,
    // i.e. how long codex takes to flush+commit its session rollout (+ Windows pipe-cling).
    // This is the number that decides whether the engine's 20s hardReleaseMs backstop is
    // safe: force-releasing before the rollout is durable breaks the next resume. Logged on
    // close so a real-machine run surfaces it; not fired on abort (rollout is forfeited then).
    let answerAtMs = 0
    const durableStart = typeof onTurnAccepted === 'function'
    let acceptedStart = false
    let acceptanceFailed = false
    const heldEvents = []
    let durableWork = Promise.resolve()
    let durableFailed = false

    // /stop and the wall-clock cap abort via this signal. On Windows the codex.exe under
    // the cmd.exe shim can SURVIVE a tree-kill and keep the inherited stdout pipe open, so
    // Node's 'close' lags far past the kill (observed: a turn ran to ~190s despite a 60s
    // abort). So: (1) kill hard — taskkill /T /F the tree AND TerminateProcess the shim;
    // (2) force-resolve as aborted after a grace window, so a turn is NEVER left hanging
    // (sbot's never-hang invariant) even if a grandchild clings to the pipe.
    let aborted = false
    let settled = false
    let childCloseObserved = false
    let childOutputObserved = false
    let graceTimer = null
    const done = (fn) => { if (settled) return; settled = true; if (graceTimer) clearTimeout(graceTimer); if (signal) signal.removeEventListener('abort', onAbort); fn() }
    const resolveRun = result => {
      if (childCloseObserved) closedRunnerResults.add(result)
      resolve(result)
    }
    const killChild = () => {
      if (IS_WIN && child.pid) {
        try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
        try { child.kill() } catch {} // also TerminateProcess the shim directly
        return
      }
      try { child.kill('SIGTERM') } catch { /* already gone */ }
      const reapTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, softStopGraceMs)
      reapTimer.unref?.()
    }
    // Resolve on the process 'close' — NOT on `turn.completed`. Codex finalizes its session
    // rollout on CLEAN EXIT (writes then commits the file), so hard-killing a still-running
    // codex leaves NO resumable rollout → the next `resume <id>` dies with "no rollout found for
    // thread id …". (An earlier attempt — settle at turn.completed then force-reap the clinging
    // process to fix the console lag — caused exactly that; reverted.) Waiting for close
    // keeps resume correct. Cost on Windows: the codex.exe under the cmd.exe shim can hold the
    // inherited stdout pipe a while, so 'close' — and thus the console/card finalize — can lag
    // the actual answer (the group already has the streamed answer via card.update; only the
    // operator console shows "in progress" until the process exits). Abort still hard-kills (the
    // never-hang invariant), intentionally forfeiting the rollout since that turn was cancelled.
    const onAbort = () => {
      aborted = true
      killChild()
      graceTimer = setTimeout(() => {
        const complete = () => done(() => resolveRun({ sessionId: capturedSessionId, result: lastResult, code: null, aborted: true }))
        if (onDurableEvent) durableWork.then(complete, failDurableEvent)
        else complete()
      }, softStopGraceMs)
    }
    if (signal) {
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    // 这段回调不在任何 Promise 链里,抛错会直接带走整个进程 ⇒ 核心失败只结束当前轮。
    // 已经拿到结果时不杀进程:codex 要干净退出才会提交可续接的会话文件。
    // 强杀后这个新 thread id 没有可续接的文件,所以交回传入的旧 id(语义同下面的崩溃退出)。
    let coreFailed = false
    const failCore = (error) => {
      if (onDurableEvent) { failDurableEvent(error); return }
      if (durableStart && !acceptedStart) { failTurnAcceptance(error); return }
      coreFailed = true
      buf = ''
      log(`binary core failed in codex stream: ${error && error.message}`)
      if (lastResult) return
      capturedSessionId = sessionId || null
      lastResult = coreFailedResult(capturedSessionId)
      if (onEvent) { try { onEvent(lastResult) } catch { /* renderer must not kill the turn */ } }
      killChild()
    }
    const failTurnAcceptance = (error) => {
      if (acceptanceFailed || settled) return
      acceptanceFailed = true
      buf = ''
      heldEvents.length = 0
      killChild()
      done(() => reject(error))
    }
    const failDurableEvent = (error) => {
      if (durableFailed || settled) return
      durableFailed = true
      buf = ''
      heldEvents.length = 0
      killChild()
      done(() => reject(error))
    }
    const emitEvent = (ev) => { if (onEvent) { try { onEvent(ev) } catch { /* renderer must not kill the turn */ } } }
    const deliverEvent = async (ev) => {
      if (onDurableEvent) {
        let timer
        try {
          await Promise.race([
            Promise.resolve().then(() => onDurableEvent(ev)),
            new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Codex durable event hook timed out')), 10000) }),
          ])
        } finally { clearTimeout(timer) }
      }
      if (!durableFailed && !settled) emitEvent(ev)
    }
    const stdoutDecoder = new StringDecoder('utf8') // 一个汉字可能被拆在两个分块里,逐块 toString 会变成乱码
    const processChunk = async (chunk) => {
      if (coreFailed || acceptanceFailed || durableFailed || ((durableStart || onDurableEvent) && (aborted || settled))) return
      buf += stdoutDecoder.write(chunk) // Node reads bytes → UTF-8, no PowerShell GBK pipe issue
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim()
        buf = buf.slice(nl + 1)
        if (!line) continue
        let raw
        try { raw = JSON.parse(line) } catch { continue } // skip non-JSON noise
        if (onRawEvent) { try { onRawEvent(raw) } catch { /* observer must not kill the turn */ } }
        if (raw.type === 'thread.started' && raw.thread_id) capturedSessionId = raw.thread_id
        if (durableStart && !acceptedStart) {
          if (raw.type === 'turn.started') {
            try {
              const answer = onTurnAccepted({
                channel: 'codex-exec',
                sessionId: capturedSessionId,
                turnId: typeof raw.turn_id === 'string' ? raw.turn_id : typeof raw.turn?.id === 'string' ? raw.turn.id : null,
              })
              if (answer && typeof answer.then === 'function') throw new TypeError('onTurnAccepted must complete synchronously')
              acceptedStart = true
              for (const held of heldEvents) {
                if (onDurableEvent) {
                  const event = normalizeEvent(held.raw)
                  if (event) await deliverEvent(event)
                } else emitEvent(held)
              }
              heldEvents.length = 0
            } catch (error) { failTurnAcceptance(error); return }
          } else if (!['thread.started', 'turn.failed', 'error'].includes(raw.type)) {
            failTurnAcceptance(new Error('Codex emitted turn effects before turn.started'))
            return
          }
        }
        // The pre-start thread identity is control data. Delay its event
        // normalization until the synchronous acceptance proof succeeds.
        if (onDurableEvent && durableStart && !acceptedStart) {
          heldEvents.push({ raw })
          continue
        }
        let ev
        try { ev = normalizeEvent(raw) } catch (error) { failCore(error); return }
        if (!ev) continue
        if (ev.type === 'assistant' && ev.text) lastAgentText = ev.text // last agent_message = final answer
        if (ev.type === 'result') { if (ev.subtype !== 'error' && !ev.text) ev.text = lastAgentText; lastResult = ev; if (!answerAtMs) answerAtMs = now() }
        if (durableStart && !acceptedStart) heldEvents.push(ev)
        else if (onDurableEvent) await deliverEvent(ev)
        else emitEvent(ev)
      }
    }
    child.stdout.on('data', (chunk) => {
      childOutputObserved = true
      if (!onDurableEvent) { processChunk(chunk).catch(failDurableEvent); return }
      child.stdout.pause?.()
      durableWork = durableWork.then(() => processChunk(chunk)).catch(failDurableEvent).finally(() => {
        if (!durableFailed && !settled) child.stdout.resume?.()
      })
    })

    child.stderr.on('data', (c) => { childOutputObserved = true; stderr += c.toString('utf8') })

    child.on('error', (err) => done(() => {
      // 人话进群、原话进日志、code 给引擎发告警 —— 与 claude runner 同口径
      if (err.code === 'ENOENT') {
        // Node emits this only when spawning the child failed. The callback
        // is a narrow host witness, not a model error classifier: a PID,
        // accepted turn, output, abort, or earlier settlement disqualifies it.
        if (onSpawnFailed && child.pid == null && !acceptedStart &&
            !childOutputObserved && !aborted && !acceptanceFailed && !durableFailed) {
          try {
            const acknowledged = onSpawnFailed({ backend: 'codex-exec',
              code: 'ENOENT', pid: null })
            if (acknowledged !== true) throw new Error('Codex spawn-failure witness was not confirmed synchronously')
          } catch (witnessError) { reject(witnessError); return }
        }
        log(`cannot find agent binary '${bin}' (and no fallback copy) — is Codex CLI installed? (npm i -g @openai/codex)`)
        return reject(Object.assign(new Error('模型程序在这台机器上找不到了,需要管理员处理'), { code: 'AGENT_BIN_MISSING' }))
      }
      reject(err)
    }))

    const completeClose = (code) => {
      if (onDurableEvent && acceptedStart && !lastResult && !aborted) {
        done(() => resolveRun({ sessionId: capturedSessionId, result: null, code, aborted }))
        return
      }
      if (onDurableEvent && code !== 0 && !lastResult && !aborted) {
        done(() => reject(closedError(new Error(`codex exited ${code} before a durable result`))))
        return
      }
      if (durableStart && !acceptedStart && !aborted && !acceptanceFailed) {
        done(() => reject(closedError(new Error('Codex exited before turn.started acceptance'))))
        return
      }
      // Watch the answer→close (rollout-flush) lag. Healthy = ~2–3s (real-machine verified),
      // so stay silent then and only warn on a regression — early notice before the engine's
      // 20s hardReleaseMs backstop would force-release and forfeit the rollout. Not on abort
      // (that path intentionally forfeits the rollout). See ③.
      if (answerAtMs && !aborted) {
        const lagMs = now() - answerAtMs
        if (lagMs > CLOSE_LAG_WARN_MS) log(`codex 收尾偏慢: 答案→close ${lagMs}ms(rollout 落盘, code=${code})— 正常约 2–3s;若持续接近 20s 兜底请调大 agent.hardReleaseMs`)
      }
      done(() => {
        // 只有 stderr、没有任何 result 事件就非零退出(真实案例:登录令牌被吊销 ⇒ 刷模型清单 401 后直接退出)。
        // 此前这里 reject ⇒ 引擎走「执行失败」裸抛路:英文原话 + 网址原样进群、不过额度 / 账号判据、零告警。
        // 现在合成一条 error result,与 turn.failed 同一条路:瞬时 / 账号判据 → 人话 / 切备用 / 告警;原话仍留给账本与日志。
        // 退出码放文案头,排障时一眼分得清是进程崩了还是服务端拒了。引擎零改动。
        if (code !== 0 && !lastResult && !aborted) {
          // 取尾不取头:致命的那行通常在最后,前面可能是一大段 WARN;截了头判据会漏、原话进群零告警(审查提醒)
          try { lastResult = normalizeEvent({ type: 'error', message: `codex exited ${code}: ${stderr.trim().slice(-800) || '(no stderr)'}` }) }
          catch (error) { log(`binary core failed on codex exit: ${error && error.message}`); lastResult = coreFailedResult(sessionId || null) }
          // 崩着退出时 codex 多半还没提交可续接的会话文件 ⇒ 不把本轮刚拿到的新 thread id 交回去:引擎会照常落盘,
          // 下一轮 resume 它就报「no rollout found」,而引擎对这种失败没有自愈路(只有空轮 / 被掐断的会话会换新会话)。
          // 续接的轮仍交回传入的旧 id(它的文件本来就在)。与此前 reject 路「不落盘」同一语义。
          capturedSessionId = sessionId || null
        }
        resolveRun({ sessionId: capturedSessionId, result: lastResult, code, aborted })
      })
    }
    child.on('close', (code) => {
      childCloseObserved = true
      if (onDurableEvent) durableWork.then(() => { if (!durableFailed) completeClose(code) })
      else completeClose(code)
    })
  })
}

// Probe `codex --version` for doctor / health (parallels claudecode.probeVersion).
function probeVersion(bin = 'codex') {
  return new Promise((resolve) => {
    let out = ''
    const { file, spawnArgs } = resolveSpawn(bin, ['--version'])
    const child = spawn(file, spawnArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOENT' ? `'${bin}' not found on PATH` : e.message }))
    child.on('close', (code) => resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: `'${bin} --version' exited ${code}` }))
  })
}

module.exports = { runTurn, runOnce, isClosedRunnerResult, isClosedRunnerError, probeVersion, normalizeEvent, parseCodexError, isEffortRejection, sandboxMode, buildArgs, buildPrompt }
