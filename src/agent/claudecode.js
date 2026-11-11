// claudecode AgentRunner — the heart of sbot.
//
// Drives the `claude` CLI in headless streaming-JSON mode over stdio pipes:
//
//   claude -p "<prompt>" --output-format stream-json --verbose
//          [--model M] [--resume SID] [--permission-mode MODE] [--add-dir DIR]
//
// The backing MODEL is swapped purely via env vars (ANTHROPIC_BASE_URL /
// ANTHROPIC_AUTH_TOKEN / ANTHROPIC_MODEL), so the same Claude Code agent
// harness can run on Claude, GLM, DeepSeek, or any Anthropic-compatible
// endpoint. This is M0's whole thesis: keep the agent, swap the brain.
//
// Spawn-per-turn (one subprocess per turn, session continuity via --resume).
// See DESIGN.md §1 (process model) / §4.1 (permissions).

const { spawn } = require('node:child_process')
const { StringDecoder } = require('node:string_decoder')
const { createClaudeFollowup } = require('./claudefollowup')
const { ensureProxy, proxyBaseFor } = require('./visionproxy')

// Always-on 群项目基础能力: auto-allowed regardless of preset (even read-only) so the
// self-knowledge manifest's advertised base skills actually run. Both CLIs fence to the
// group's own chat ($SBOT_CHAT_ID); feishu also fences paths to cwd. Additive; deny wins.
const { claudeBaseSkillAllows, claudeBuildArgs, claudePluginAllowRules, claudeNormalizeEvent } = require('./privatecore')
const { coreFailedResult } = require('./errtag')
const BASE_SKILL_ALLOWS = claudeBaseSkillAllows()
// Windows executable resolution (npm .cmd shim vs native .exe) is shared with the
// codex runner — see winexec.js for the why (ENOENT on .cmd, never the POSIX shim).
const { IS_WIN, resolveSpawn } = require('./winexec')
const { tagError } = require('./errtag') // 出错原话 → quota / sessionMissing / transient 之一(优先级只在那一处定),与 codex runner 共用
const closedRunnerResults = new WeakSet()
const isClosedRunnerResult = result => !!result && typeof result === 'object' && closedRunnerResults.has(result)
// A rejection raised from the child's own 'close' event: the process has
// exited even though the turn has no result. It never proves the turn's outcome.
const closedRunnerErrors = new WeakSet()
const isClosedRunnerError = error => !!error && typeof error === 'object' && closedRunnerErrors.has(error)
const closedError = error => { closedRunnerErrors.add(error); return error }
const PRE_INIT_HOOK_EVENTS = new Set(['hook_started', 'hook_response'])
const DURABLE_EVENT_TYPES = new Set(['system', 'assistant', 'user', 'result', 'tool_result', 'turn_continue'])
// Tool output is completion evidence only, never answer text.
function durableToolResults(ev) {
  const results = Array.isArray(ev.results) ? ev.results : []
  return results.filter(item => item && item.type === 'tool_result').map(item => {
    const content = typeof item.content === 'string' ? item.content
      : Array.isArray(item.content) ? item.content
        .filter(part => part && part.type === 'text' && typeof part.text === 'string')
        .map(part => part.text).join('\n')
        : ''
    return { type: 'tool_result', ...(ev.sessionId ? { sessionId: ev.sessionId } : {}),
      results: [{ type: 'tool_result', content, is_error: item.is_error === true }] }
  })
}

// Build the child env from a resolved provider. `baseUrlOverride` (when given)
// replaces provider.baseUrl for ANTHROPIC_BASE_URL — used to point `claude` at
// the local vision strip-proxy for text-only providers. The auth
// token is unchanged: the proxy forwards it verbatim to the real upstream.
function buildEnv(provider = {}, baseUrlOverride, extraEnv, effort = '') {
  const env = { ...process.env }

  // The spawn env is defined ENTIRELY by the provider:
  // clear inherited ANTHROPIC_* first, so a base/token/model exported in the
  // operator's shell can't silently reroute a provider that doesn't set them
  // (e.g. logged-in claude hitting a GLM base). ANTHROPIC_API_KEY passes
  // through — direct API-key auth for the keyless provider is legitimate.
  // provider.env (applied last) can still set any of these deliberately.
  delete env.ANTHROPIC_BASE_URL
  delete env.ANTHROPIC_AUTH_TOKEN
  delete env.ANTHROPIC_MODEL

  const base = baseUrlOverride || provider.baseUrl
  if (base) env.ANTHROPIC_BASE_URL = base
  if (provider.apiKey) {
    // Use the auth token (Bearer) against the custom base; blank the api key so
    // the CLI doesn't try to validate it against api.anthropic.com.
    env.ANTHROPIC_AUTH_TOKEN = provider.apiKey
    delete env.ANTHROPIC_API_KEY
  }
  if (provider.model) env.ANTHROPIC_MODEL = provider.model

  // If sbot itself is ever launched under a Claude Code session, this prevents
  // the child from thinking it's a nested session.
  delete env.CLAUDECODE

  if (provider.env) Object.assign(env, provider.env)
  // The group's own thinking depth wins over a card-level value.
  if (effort) env.CLAUDE_CODE_EFFORT_LEVEL = effort
  // Engine-injected non-provider context (e.g. SBOT_CHAT_ID for the feishu base skill).
  // Applied last but namespaced (SBOT_*), so it never collides with provider ANTHROPIC_* env.
  if (extraEnv) Object.assign(env, extraEnv)
  return env
}

// Map a raw `claude` stream-json line to a normalized AgentEvent (interfaces.js).
function normalizeEvent(ev) {
  const result = claudeNormalizeEvent(ev)
  // JSON cannot carry `undefined`; retain the frozen JS object's optional
  // property shape at the public runner boundary.
  if (ev.type === 'system') { result.subtype = ev.subtype; result.sessionId = ev.session_id }
  else if (ev.type === 'assistant' || ev.type === 'user') {
    result.sessionId = ev.session_id
    if (ev.type === 'assistant') for (const tool of result.tools) {
      if (!Object.hasOwn(tool, 'name')) tool.name = undefined
      if (!Object.hasOwn(tool, 'input')) tool.input = undefined
    }
  }
  else if (ev.type === 'result') {
    result.subtype = ev.subtype
    result.isError = ev.is_error
    result.usage = ev.usage
    result.sessionId = ev.session_id
    if (!Object.hasOwn(result, 'text')) result.text = undefined
    if (ev.is_error) tagError(result, result.text)
  }
  return result
}

// key 型模型认证失败时造的那条出错 result(形状同 normalizeEvent 的 result)。quota 直接标 account:
// 与重试耗尽后「authentication_error」原话被 quotaerr 判成的结果一致;text 带 HTTP 码,setupmodels 据此判成 key 不对。
function authFailedResult(status, error, sessionId) {
  return {
    type: 'result',
    subtype: 'auth_failed',
    text: `模型认证失败(HTTP ${status}${error ? ' ' + error : ''}):key 不对或已失效`,
    isError: true,
    authFailed: true,
    quota: { kind: 'account', window: null },
    sessionId,
  }
}

/**
 * Run a single agent turn.
 * @param {import('../core/interfaces').RunTurnOptions} opts
 * @returns {Promise<import('../core/interfaces').RunTurnResult>}
 */
function runTurn({
  bin = 'claude',
  prompt,
  provider = {},
  model,
  effort = '',
  workdir,
  sessionId,
  permissionMode,
  autocompactTokens,
  allowedTools,
  disallowedTools,
  plugins,
  extraEnv,
  appendSystemPrompt,
  onEvent,
  onDurableEvent,
  onTurnAccepted,
  signal,
  log = () => {}, // daemon logger — 与 codex runner 同一个口子(engine 两边都传 this.log)
  spawnFn = spawn, // 可注入,供单测驱动 spawn/解析环路(与 codexcode 同一形状)
  softStopGraceMs = 10000,
  steer = false, onSteerReady, onSteerLanded,
  steerReceiptTimeoutMs = 10000, steerHoldMs = 20000, interruptGraceMs = 2000,
  closeGraceMs = 3000, // short: the grace starts AFTER the answer, so we're only waiting for
  // the OS to close a possibly-clinging pipe (MCP browser children / cmd.exe shim). Claude
  // persists its session continuously, so killing ~3s post-answer is safe → the group frees
  // fast, no long "finalizing". (Codex needs a clean exit for its rollout, so it stays on the
  // engine's slower hard-release backstop.)
} = {}) {
  return new Promise((resolve, reject) => {
    if (!prompt) return reject(new Error('runTurn: prompt required'))
    if (onDurableEvent !== undefined && typeof onDurableEvent !== 'function') return reject(new TypeError('onDurableEvent must be a function'))

    // CLI 能力探测必须先于 spawn(见 supportsFlag)。结果按 bin 缓存 ⇒ 只有进程内第一轮真探一次
    // (`--help` 毫秒级);不需要压缩的群连探都不探。
    let autocompactSupported = null
    const ready = autocompactTokens > 0
      ? supportsFlag(bin, '--autocompact').then((v) => { autocompactSupported = v })
      : Promise.resolve()
    // ⚠ **必须 .catch(reject)**:launch 里有文件 IO(写 mcp 配置),同步抛出是可能的。
    // 改动前它在 Promise executor 里同步调用,抛了由构造器接住 → reject;挪进 .then 之后
    // 没有 catch 就变成 unhandled rejection,**返回的 Promise 永不 settle** ⇒ 群里那一轮
    // 挂到 20s 硬释放才收场,而且看不出原因。
    ready.then(() => {
      // Text-only provider (vision:false) + a real upstream ⇒ route claude through
      // the local strip-proxy so image inputs get downgraded instead of 400ing the
      // turn. The proxy holds no secrets; auth flows through untouched.
      if (provider.vision === false && provider.baseUrl) {
        ensureProxy(onEvent ? (m) => { try { onEvent({ type: 'log', message: m }) } catch {} } : undefined)
          .then((port) => launch(proxyBaseFor(port, provider.baseUrl)))
          .catch(reject)
      } else {
        launch()
      }
    // ⚠ 这个 catch **没有测试覆盖**:试过用坏 workdir 逼 launch 同步抛,但 writeMcpConfigFile
    // 写的是 ~/.sbot/mcp/ 不是 workdir,构造不出来。它是防御性兜底 —— 挪进 .then 之后,任何
    // 同步抛都会变成 unhandled rejection 让 Promise 永不 settle(改动前在 executor 里由构造器
    // 接住)。代价一行,收益是「这条路径不可能挂起」。别因为没测试就删掉。
    }).catch(reject)
    return

    // The actual spawn — deferred behind a thunk so the vision strip-proxy (async
    // to start) can resolve a base-URL override first. Closes over resolve/reject.
    function launch(baseUrlOverride) {
      // Prompt travels via stdin (see spawn below), so it's absent from argv here.
      // 长会话上下文上限:超过即让 CLI 原地压缩(--autocompact)。不传 ⇒ CLI 只在模型窗口边缘
      // 才压 —— 多天群会话实测涨到 96 万 token 都没压过一次。
      // ⚠ 旗子先经能力探测(见 supportsFlag):老 CLI 不认它,传了**每轮必崩**。探不出来也不传 ——
      // 降级(压缩不生效)好过整群跑不动。但**降级必须出声**:静默失效正是最难查的那类(教训 26),
      // 所以这里打日志、doctor 另有一行如实标。
      if (autocompactTokens > 0 && autocompactSupported !== true) {
        if (onEvent) {
          try {
            onEvent({ type: 'log', message: autocompactSupported === false
              ? 'claude CLI 不认 --autocompact(版本偏低)⇒ 长会话自动压缩已停用;升级 claude 即可恢复'
              : 'claude CLI 能力探测失败 ⇒ 长会话自动压缩本轮未启用' })
          } catch {}
        }
      }
      // Per-group plugins: a group with a plugins config gets strict MCP
      // takeover — only project-level servers + explicitly enabled global servers load
      // (--strict-mcp-config; fail-closed like the rest of the permission stack).
      // Enabled plugins auto-allow their tools (mcp__name__* / Skill(name)) at runtime,
      // merged here without touching the group's saved allow list; deny still wins.
      // Groups without a plugins config keep the traditional self-loading — zero regression.
      // Config travels as a file, not inline JSON argv (Windows cmd.exe shim mangles quotes).
      let mcpConfigPath, pluginAllows = []
      if (plugins && workdir) {
        const { buildMcpConfig, writeMcpConfigFile } = require('../plugins')
        // 传 log:跳过死 MCP 的那一行要走 daemon 带时间戳的 logger(v0.11.61 口径),不能退成裸 stderr
        const mcpCfg = buildMcpConfig(workdir, plugins.mcp || [], undefined, { log })
        mcpConfigPath = writeMcpConfigFile(workdir, mcpCfg)
        pluginAllows = claudePluginAllowRules(Object.keys(mcpCfg.mcpServers || {}), plugins.skills || [])
      }
      // The binary owns the permission, tool allow/deny and argument policy.
      // Node only resolves capability and writes the project-scoped MCP file.
      const args = claudeBuildArgs({ steer, model, providerModel: provider.model, sessionId,
        runtimeCommand: extraEnv?.SBOT_RUNTIME_ENTRY
          ? require('../runtimefacts').runtimeCommand(extraEnv.SBOT_RUNTIME_ENTRY) : '',
        permissionMode, autocompactTokens, autocompactSupported,
        mcpConfigPath, allowedTools, pluginAllows, disallowedTools,
        appendSystemPrompt, workdir })

      const { file, spawnArgs, fallback } = resolveSpawn(bin, args)
      if (fallback) log(`配置的 agent 路径 '${bin}' 不存在,本轮改用 ${fallback} —— 请把配置改回正确路径`) // 兜底只救急,配置仍是错的
      const child = spawnFn(file, spawnArgs, {
        env: buildEnv(provider, baseUrlOverride, extraEnv, effort),
        cwd: workdir || process.cwd(),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })

      // Feed the prompt over stdin instead of as an argv element: cross-platform,
      // and it removes ALL Windows argv/cmd.exe escaping risk for arbitrary chat
      // text (quotes, &, |, %, newlines). Close stdin so `claude -p` starts.
      let followup = null
      let stdinOpen = true
      const endStdin = () => { if (stdinOpen) { stdinOpen = false; child.stdin.end() } }
      const writeFrame = frame => {
        if (!stdinOpen || childCloseObserved) throw new Error('Claude input is closed')
        child.stdin.write(JSON.stringify(frame) + '\n')
      }
      child.stdin.on('error', error => { if (steer && !settled) followup?.fail(error) })

      let capturedSessionId = sessionId || null
      let lastResult = null
      let lastMsgUsage = null // 最后一条 assistant 消息的逐请求 usage —— 当前上下文规模的直接来源
      let buf = ''
      let stderr = ''

      // /stop and the wall-clock cap abort via this signal: SIGTERM, then SIGKILL
      // after a grace window if the child hasn't exited (two-stage).
      let aborted = false
      let killTimer = null
      let closeTimer = null
      let settled = false
      let childCloseObserved = false
      let acceptanceFailed = false
      let turnAccepted = false
      let durableWork = Promise.resolve()
      let durableFailed = false
      // Resolution is guarded (exactly once) because a close-grace timer can force the
      // turn to settle before the 'close' event fires — otherwise a lingering pipe would
      // wedge the per-group lock forever (never-hang invariant).
      const finish = (fn) => { if (settled) return; settled = true; followup?.dispose(); if (killTimer) clearTimeout(killTimer); if (closeTimer) clearTimeout(closeTimer); if (signal) signal.removeEventListener('abort', onAbort); fn() }
      const resolveRun = result => {
        if (childCloseObserved) closedRunnerResults.add(result)
        resolve(result)
      }
      const killTree = () => {
        if (IS_WIN && child.pid) { try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}; return }
        try { child.kill('SIGKILL') } catch { /* already gone */ }
      }
      // The durable v2 dispatch ACK is a separate, synchronous boundary. Renderer
      // callbacks intentionally swallow errors; this callback must never do so.
      // No normalized event is delivered before the child's init identifies the
      // accepted turn. CLI tools may already have executed before observation.
      const failTurnAcceptance = (error) => {
        acceptanceFailed = true
        buf = ''
        killTree()
        finish(() => reject(error))
      }
      const failDurableEvent = (error) => {
        if (durableFailed || settled) return
        durableFailed = true
        buf = ''
        killTree()
        finish(() => reject(error))
      }
      const persistEvent = async (event) => {
        if (!onDurableEvent || !event) return
        let timer
        try {
          await Promise.race([
            Promise.resolve().then(() => onDurableEvent(event)),
            new Promise((_, fail) => { timer = setTimeout(() => fail(new Error('Claude durable event hook timed out')), 10000) }),
          ])
        } finally { clearTimeout(timer) }
      }
      // Force-resolve if 'close' doesn't arrive within closeGraceMs of the trigger (the
      // final result, or an abort). On Windows the cmd.exe shim / spawned MCP servers can
      // hold the stdout pipe open long past claude's own exit, so 'close' may lag or never
      // fire. Safe: claude persists its session continuously, so a post-answer kill loses
      // no resumable state (unlike codex's clean-exit rollout).
      // ⚠ 这行日志是「下一轮空轮」的**紧前一枚指纹**(2026-09-05 真机三次全中,必须留)。
      // 答案已经到了、进程却在宽限期内不肯退,最常见的原因是本轮起过后台命令吊着它;这里强杀
      // ⇒ 那个后台任务没有留下收尾记录 ⇒ 下一次 `--resume` 时 CLI 会先把一条「上一轮的后台
      // 任务没有结果」的系统提示排进队列、**排在我们的 prompt 前面**,那一轮于是零 API 调用、
      // 零产出退出(engine 记 empty 并静默重试一次)。
      // ⭐ 判据的分辨力在**对照**上,不在这一行本身:当天走这条路的三轮后面全跟着一次 empty,
      //   而自然退出的轮次(如 09-05 03:19 那轮,答案后 202ms 就 close)后面一次都没有。
      //   只看 empty 那一行永远查不出来 —— 因为原因发生在上一轮。
      // ⚠ 中止(/stop、撤回、墙钟)走的也是这条路,但那是**预期内**的杀:不打日志,否则每次
      //   /stop 都留一行看起来像故障的话,真正的那条就被淹了。
      const armCloseGrace = () => {
        if (closeTimer || settled || closeGraceMs <= 0) return
        closeTimer = setTimeout(() => {
          if (!aborted && !(lastResult && lastResult.authFailed)) log(`claude 答案已到但 ${closeGraceMs}ms 内没退出 ⇒ 强制收尾;本轮若起过后台命令(run_in_background),它会被一起收掉,下一轮可能空转一次`)
          killTree()
          const complete = () => finish(() => resolveRun({ sessionId: capturedSessionId, result: lastResult, code: null, aborted }))
          if (onDurableEvent) durableWork.then(complete, failDurableEvent)
          else complete()
        }, closeGraceMs)
      }
      const onAbort = () => {
        aborted = true
        if (IS_WIN && child.pid) {
          // Windows has no POSIX signals, and killing the cmd.exe shim would orphan
          // the real claude process underneath. taskkill /T /F ends the whole tree.
          try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {}
        } else if (followup && stdinOpen) {
          try { followup.stop() } catch { /* close proof remains authoritative */ }
          killTimer = setTimeout(() => {
            try { child.kill('SIGTERM') } catch {}
            killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, softStopGraceMs)
          }, interruptGraceMs)
        } else {
          try { child.kill('SIGTERM') } catch { /* already gone */ }
          killTimer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, softStopGraceMs)
        }
        armCloseGrace() // even after a kill, 'close' can hang on a clinging pipe — bound it
      }
      if (steer) followup = createClaudeFollowup({ write: writeFrame, end: endStdin,
        onReady: onSteerReady, onLanded: onSteerLanded, onFailure: failDurableEvent,
        receiptTimeoutMs: steerReceiptTimeoutMs, holdMs: steerHoldMs })
      if (signal) {
        if (signal.aborted) onAbort()
        else signal.addEventListener('abort', onAbort, { once: true })
      }

      // 这段回调不在任何 Promise 链里,抛错会直接带走整个进程 ⇒ 核心失败只结束当前轮。
      // 已经拿到结果时保留结果(答案已交付,只差收尾)。原因只进日志,不带事件原文。
      let coreFailed = false
      const failCore = (error) => {
        if (onDurableEvent) { failDurableEvent(error); return }
        coreFailed = true
        buf = ''
        log(`binary core failed in claude stream: ${error && error.message}`)
        if (lastResult) return
        lastResult = coreFailedResult(capturedSessionId)
        if (onEvent) { try { onEvent(lastResult) } catch { /* renderer must not kill the turn */ } }
        killTree()
        armCloseGrace()
      }
      const stdoutDecoder = new StringDecoder('utf8') // 一个汉字可能被拆在两个分块里,逐块 toString 会变成乱码
      const processChunk = async (chunk) => {
        // Legacy callers may still receive a late buffered line after close;
        // only the v2 gate forbids post-settlement delivery.
        if (coreFailed || acceptanceFailed || durableFailed || ((onTurnAccepted || onDurableEvent) && settled)) return
        buf += stdoutDecoder.write(chunk)
        let nl
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl).trim()
          buf = buf.slice(nl + 1)
          if (!line) continue
          let raw
          try { raw = JSON.parse(line) } catch { continue } // skip non-JSON noise
          if (followup && followup.protocol(raw)) continue
          if (onTurnAccepted && !turnAccepted) {
            // Locally configured session hooks report their own lifecycle before
            // init. They are not model output; skip them and keep waiting.
            if (raw.type === 'system' && PRE_INIT_HOOK_EVENTS.has(raw.subtype)) continue
            if (raw.type !== 'system' || raw.subtype !== 'init' || typeof raw.session_id !== 'string' || !raw.session_id) {
              failTurnAcceptance(new Error('Claude turn emitted an event before start confirmation'))
              return
            }
            let accepted
            try { accepted = onTurnAccepted({ channel: 'claude-code', sessionId: raw.session_id }) } catch (error) {
              failTurnAcceptance(error)
              return
            }
            let asyncAccepted = false
            try { asyncAccepted = !!accepted && typeof accepted.then === 'function' } catch (error) {
              failTurnAcceptance(error)
              return
            }
            if (asyncAccepted) {
              // An async write cannot guard following lines in this same chunk.
              Promise.resolve(accepted).catch(() => {})
              failTurnAcceptance(new Error('Claude turn start confirmation must be synchronous'))
              return
            }
            turnAccepted = true
          }
          if (followup && raw.type === 'system' && raw.subtype === 'init') {
            if (followup.init(raw) === 'unavailable') log('当前模型程序未提供忙时跟进能力，本轮后续消息排队')
          }
          // key 错快速失败(1.0.3):claude 对 401 / 403 默认重试约 3 分钟才放弃,第一次重试时(实测 0.8 秒)就会先报一条
          // `system/api_retry` 带 error_status。只对 API key 型模型(有 baseUrl)当场收尾 —— 订阅登录的 401 可能是
          // Claude Code 自己在刷新登录,让它重试;5xx / 529 这类过载照旧重试。造一条出错 result 交给上层:账号类失败
          // 那套(备用模型 / 运维告警 / 群里人话)和重试耗尽时一样走,只是不用等。
          if (raw.type === 'system' && raw.subtype === 'api_retry' && provider.baseUrl && (raw.error_status === 401 || raw.error_status === 403) && !lastResult && !aborted) {
            lastResult = authFailedResult(raw.error_status, raw.error, capturedSessionId)
            if (onDurableEvent) await persistEvent(lastResult)
            if (onEvent) { try { onEvent(lastResult) } catch { /* renderer must not kill the turn */ } }
            killTree()
            armCloseGrace()
            continue
          }
          let ev
          try { ev = normalizeEvent(raw) } catch (error) { failCore(error); return }
          if (ev.sessionId) capturedSessionId = ev.sessionId
          if (ev.type === 'assistant' && raw.message && raw.message.usage) {
            lastMsgUsage = raw.message.usage
            // 逐请求上下文随事件上报:engine 拿它跟踪「此刻会话驮着多大」,压缩通知里报数用
            ev.contextTokens = (lastMsgUsage.input_tokens || 0) + (lastMsgUsage.cache_read_input_tokens || 0) + (lastMsgUsage.cache_creation_input_tokens || 0)
          }
          if (ev.type === 'result') {
            const windows = Object.values(raw.modelUsage || {}).map(value => value?.contextWindow)
            // No model-name guesses; a single reported capacity is unambiguous.
            if (windows.length && windows.every(value => Number.isFinite(value) && value > 0) &&
                new Set(windows).size === 1) ev.contextWindowTokens = windows[0]
            // 当前上下文规模 = 最后一次 API 请求的输入侧总量(未命中 + 缓存读 + 缓存写)。
            // result.usage 是整轮跨请求聚合、不能当上下文用;逐请求数在 assistant 事件的
            // message.usage 里(2.1.222 真机核对),兜底走 usage.iterations 末元素(同一形状)。
            const last = lastMsgUsage || (ev.usage && Array.isArray(ev.usage.iterations) ? ev.usage.iterations[ev.usage.iterations.length - 1] : null)
            if (last) ev.contextTokens = (last.input_tokens || 0) + (last.cache_read_input_tokens || 0) + (last.cache_creation_input_tokens || 0)
          }
          if (followup && !aborted && ev.type === 'result') {
            ev = followup.result(ev)
            if (ev.type === 'turn_continue') lastMsgUsage = null
          }
          // Only transcript events reach the durable projection. Informational
          // stream additions (for example rate_limit_event) carry no answer.
          // Claude reports several tool results per event, with array content
          // and an optional error flag; persist each in the shared shape.
          if (onDurableEvent && ev.type === 'tool_result') {
            for (const durable of durableToolResults(ev)) await persistEvent(durable)
          } else if (onDurableEvent && DURABLE_EVENT_TYPES.has(ev.type)) await persistEvent(ev)
          if (ev.type === 'result') { lastResult = ev; armCloseGrace() } // answer in → bound the wait for 'close'
          if (onEvent) { try { onEvent(ev) } catch { /* renderer must not kill the turn */ } }
        }
      }
      child.stdout.on('data', (chunk) => {
        if (!onDurableEvent) { processChunk(chunk).catch(failDurableEvent); return }
        child.stdout.pause?.()
        durableWork = durableWork.then(() => processChunk(chunk)).catch(failDurableEvent).finally(() => {
          if (!durableFailed && !settled) child.stdout.resume?.()
        })
      })

      child.stderr.on('data', (c) => { stderr += c.toString('utf8') })

      child.on('error', (err) => finish(() => {
        // 配置路径与各候选位置都没有:群里只说人话(这条 message 会原样进群卡与账本),路径与产品名只进日志。
        // 英文原话带安装路径,不能进群。code 给引擎认(发运维告警),不按文案判。
        if (err.code === 'ENOENT') {
          log(`cannot find agent binary '${bin}' (and no fallback copy on PATH / ~/.local/bin / nvm) — is Claude Code installed?`)
          return reject(Object.assign(new Error('模型程序在这台机器上找不到了,需要管理员处理'), { code: 'AGENT_BIN_MISSING' }))
        }
        reject(err)
      }))

      const completeClose = (code) => finish(() => {
        if (onDurableEvent && turnAccepted && !lastResult && !aborted) {
          resolveRun({ sessionId: capturedSessionId, result: null, code, aborted })
          return
        }
        if (code !== 0 && !lastResult && !aborted) {
          return reject(closedError(new Error(`claude exited ${code}: ${stderr.trim().slice(0, 800) || '(no stderr)'}`)))
        }
        resolveRun({ sessionId: capturedSessionId, result: lastResult, code, aborted })
      })
      child.on('close', (code) => {
        childCloseObserved = true
        if (onDurableEvent) durableWork.then(() => { if (!durableFailed) completeClose(code) })
        else completeClose(code)
      })
      if (!aborted) {
        if (followup) followup.start(prompt)
        else child.stdin.end(prompt)
      }
    }
  })
}

// Probe `claude --version` for startup checks / doctor (FR3.4, FR10.5).
// ── CLI 能力探测(2026-08-19)─────────────────────────────────────────────────
// ⚠ **判据是「`--help` 里有没有这个旗子」,不是版本号比大小。** 我们只知道 2.1.207 没有
// `--autocompact`、2.1.222 有,**引入版本的确切边界并不知道** —— 猜边界两头都会错:猜高了
// 本来能压缩的机器被白白降级,猜低了照样每轮崩。直接问 CLI 自己支持什么,不用推。
//
// 由来:v0.11.17 起 `autocompactTokens>0` 就无条件传这个旗子,而生产机当时装的是 2.1.207 ⇒
// 凡走 claude runner 的 provider **每轮必崩**(`unknown option '--autocompact'`)。潜伏 4 天才
// 暴露,因为那个群一直跑 codex(codex 走的是 `-c model_auto_compact_token_limit`,另一条路)。
// 当时只升了机器上的 CLI,代码层没治 —— 任何 claude 版本偏低的机器装上都会复现。
//
// 缓存的是 **Promise 不是结果**:同一 bin 的并发轮次共用一次探测,进程内只 spawn 一次。
// ⚠ 缓存**带 TTL**,不是一次定终身:2026-08-13 那次事故的止血手法正是「升级机器上的 claude,
// daemon 全程不重启」。若永久缓存,升级完 daemon 仍拿着旧答案不传旗子,而 doctor(另一个进程)
// 会说「可用」—— 两个消费者读不同来源、一个长期正确掩护另一个长期失效,正是教训 26 的形状。
// 成功结论缓存 10 分钟(装好的二进制不会自己变),探测失败只缓存 60 秒(多半是暂态,早点重试)。
const _flagCache = new Map()
const FLAG_TTL_OK_MS = 10 * 60 * 1000
const FLAG_TTL_ERR_MS = 60 * 1000
function supportsFlag(bin, flag, now = Date.now()) {
  const key = String(bin) + ' ' + flag
  const hit = _flagCache.get(key)
  if (hit && now < hit.until) return hit.p
  const p = new Promise((resolve) => {
    let out = ''
    let done = false
    const finish = (v) => { if (!done) { done = true; resolve(v) } }
    let child
    try {
      const { file, spawnArgs } = resolveSpawn(bin, ['--help'])
      child = spawn(file, spawnArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    } catch { return finish(null) }
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', () => finish(null))
    // 探不出来(spawn 失败 / 非零退出)⇒ null = 「不知道」,与「确定不支持」分开:调用方对两者
    // 都不传旗子(降级好过每轮崩),但 doctor 要能把它们说成两件事。
    child.on('close', (code) => finish(code === 0 ? out.includes(flag) : null))
    // 兜底:`--help` 正常是毫秒级,卡住多半是 shim 出了问题 —— 别让它拖住第一轮。
    setTimeout(() => { try { child.kill() } catch {} ; finish(null) }, 5000).unref?.()
  })
  // 先按失败 TTL 占位(并发调用共用同一个 Promise),拿到结论再按结论续期。
  _flagCache.set(key, { until: now + FLAG_TTL_ERR_MS, p })
  p.then((v) => {
    const cur = _flagCache.get(key)
    if (cur && cur.p === p) _flagCache.set(key, { until: now + (v === null ? FLAG_TTL_ERR_MS : FLAG_TTL_OK_MS), p })
  })
  return p
}

function probeVersion(bin = 'claude') {
  return new Promise((resolve) => {
    let out = ''
    const { file, spawnArgs } = resolveSpawn(bin, ['--version'])
    const child = spawn(file, spawnArgs, { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true })
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.on('error', (e) => resolve({ ok: false, error: e.code === 'ENOENT' ? `'${bin}' not found on PATH` : e.message }))
    child.on('close', (code) => resolve(code === 0 ? { ok: true, version: out.trim() } : { ok: false, error: `'${bin} --version' exited ${code}` }))
  })
}

module.exports = { runTurn, isClosedRunnerResult, isClosedRunnerError, buildEnv, normalizeEvent, probeVersion, supportsFlag, BASE_SKILL_ALLOWS }
