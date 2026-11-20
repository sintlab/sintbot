'use strict'
// What a due scheduled task does, once the core has said "fire" and the claim
// is on disk (src/scheduleservice.js). Three kinds:
//
//   model   post one visible line into the conversation, then hand that very
//           message to the service ingress as an ordinary message: exactly
//           what the console's "say" does (src/consolesay.js). The posted
//           line's message id is the receipt's source; nothing in the journal
//           tells the turn from one a person asked for.
//   say     post the text once.
//   script  run the command in the conversation's project folder, outside the
//           conversation's queue and session.
//
// Every effect here is attempted once. This module reports what happened as
// one of the core's outcomes; the core turns it into the task's last result
// and says it is never retried.
const os = require('node:os')
const { createHash } = require('node:crypto')
const { taskId: receiptIdOf } = require('./core/enginecheckpoint')
const { runScriptTask, outputTail, DEFAULT_TIMEOUT_MS } = require('./schedulescript')
const { redact } = require('./core/redact')
const { chatLang, pick } = require('./chatlang')

const SEND_TIMEOUT_MS = 5000
const CONFIRM_MS = 5000
const POLL_MS = 10
const DURABLE_MESSAGE_ID = /^om_[A-Za-z0-9_-]{1,124}$/
// The prompt shown after the task's name in the conversation: its beginning.
const SHOWN_PROMPT_CHARS = 200
// Why the service did not take the posted line (as for the console's say).
const REFUSALS = { 'group-held': 'held', 'group-recovering': 'recovering', upgrading: 'upgrading',
  'stop-pending': 'stopping', 'skip-pending': 'stopping', 'queue-full': 'queue-full' }

// One request key per (task, occurrence): a conversation kept on this machine
// derives the line's id from it, so a repeated post is the same line.
const requestKey = (task, occurrence) => createHash('sha256')
  .update(`sintbot-schedule-v1\0${task.id}\0${occurrence}`).digest('hex').slice(0, 32)

// The mark and name people see. Nothing reads it back.
const shownMark = (lang, name) => `${pick(lang, '【定时】', '[Scheduled] ')}${name}`

function shownLine(task, group, platformName) {
  const lang = chatLang(group, platformName)
  const prompt = task.text.trim()
  const head = prompt.length > SHOWN_PROMPT_CHARS ? prompt.slice(0, SHOWN_PROMPT_CHARS) + '…' : prompt
  return redact(`${shownMark(lang, task.name)}\n${head}`, { pii: group?.redactPii !== false })
}

// One attempt to post a line. { id } when the platform returned something,
// { failed } when it said the line was not delivered, { unknown } when the
// call timed out or threw: the line may or may not be in the conversation.
async function postOnce(platform, chatId, text, { timeoutMs, requestId, log }) {
  let timer = null
  let timedOut = false
  // Everything a task posts is text its author wrote: `verbatim` tells an
  // adapter that rewords the service's own notices (Slack's command words) to
  // leave it alone. Adapters without such rewording ignore the option.
  const sending = Promise.resolve().then(() => platform.send(chatId, text, { requestId, verbatim: true }))
  sending.then(id => {
    if (timedOut) log(`scheduled line arrived after the timeout${typeof id === 'string' && id ? ` (${id})` : ''}; nothing was started for it`)
  }, () => {})
  try {
    const id = await Promise.race([sending,
      new Promise((_, reject) => { timer = setTimeout(() => { timedOut = true; reject(new Error('timeout')) }, timeoutMs) })])
    return typeof id === 'string' && id ? { id } : { failed: true }
  } catch (error) {
    log('scheduled line not confirmed: ' + (timedOut ? `timeout (${timeoutMs}ms)` : error?.message || String(error)))
    return { unknown: timedOut ? 'timeout' : 'error' }
  } finally { if (timer) clearTimeout(timer) }
}

const signalNumber = signal => os.constants.signals[signal] || 0

// Dependencies, all injected:
//   getGroup(chatId)            the conversation's live configuration
//   getPlatform(chatId)         its real adapter (the one its messages arrive on), or null
//   route(msg, platform)        the service ingress (routeMessage)
//   receiptState(chatId, id)    'pending' | 'completed' | null in that conversation's journal
//   scriptEnv(chatId)           the environment a script inherits
//   platformOf(chatId)          the conversation's platform name, for the language of
//                               a conversation whose entry does not name its platform
function createScheduleFire({ getGroup, getPlatform, route, receiptState, scriptEnv = () => process.env,
  platformOf = () => undefined,
  runScript = runScriptTask, log = () => {}, now = () => Date.now(), sendTimeoutMs = SEND_TIMEOUT_MS,
  confirmMs = CONFIRM_MS, pollMs = POLL_MS } = {}) {
  for (const hook of [getGroup, getPlatform, route, receiptState, scriptEnv, platformOf, runScript, log, now]) {
    if (typeof hook !== 'function') throw new TypeError('schedule firing needs explicit hooks')
  }
  // The language of this conversation's own words (src/chatlang.js).
  const langOf = (chatId, group) => chatLang(group, platformOf(chatId) || undefined)
  const running = new Map() // task id -> child process of the script still running
  let stopped = false

  const post = (platform, chatId, text, requestId) =>
    postOnce(platform, chatId, text, { timeoutMs: sendTimeoutMs, requestId, log })

  // The receipt appears as soon as the message is registered; the route's own
  // promise lasts for the whole turn.
  function watch(chatId, receiptId, settled) {
    let done = false
    settled.then(() => { done = true })
    return (async () => {
      const deadline = Date.now() + confirmMs
      while (!done && Date.now() < deadline) {
        if (receiptState(chatId, receiptId)) return { admitted: true }
        await new Promise(resolve => setTimeout(resolve, pollMs))
      }
      return receiptState(chatId, receiptId) ? { admitted: true } : { timeout: true }
    })()
  }

  // `recheck()` puts the conversation's facts to the core once more (null =
  // it still says fire, otherwise the core's reason).
  async function fireModel(task, occurrence, group, platform, recheck) {
    const posted = await post(platform, task.chatId, shownLine(task, group, platformOf(task.chatId) || undefined), requestKey(task, occurrence))
    if (posted.failed) return { outcome: 'post-failed', reason: 'post-failed', detail: null }
    if (posted.unknown) return { outcome: 'post-unknown', reason: 'post-unknown', detail: posted.unknown }
    // Without a message id the durable route can take, there is no receipt
    // identity; none is made up. The line stays; no turn is started.
    if (!DURABLE_MESSAGE_ID.test(posted.id)) return { outcome: 'post-failed', reason: 'unusable-id', detail: null }
    const receiptId = receiptIdOf({ source: 'message', chatId: task.chatId, sourceId: posted.id })
    // Shaped like a message the platform delivered. `scheduled` is a fact for
    // this process only (like a Slack thread): the engine hands it to the core,
    // which keeps the turn at standard speed and out of follow-ups. It is in no
    // journal, so after a restart the turn is an ordinary one.
    const msg = { chatId: task.chatId, userId: 'schedule',
      senderName: pick(langOf(task.chatId, group), '定时任务', 'Scheduled task'), text: task.text, msgId: posted.id,
      createTimeMs: now(), replyCtx: { chatId: task.chatId, messageId: posted.id }, scheduled: true }
    // Posting took time, and the conversation may have changed meanwhile (the
    // console's say looks again here too). The core is asked once more with
    // the facts as they are now; if it no longer says fire, the message is not
    // handed over: the line stays in the conversation, no turn starts, and the
    // occurrence reads as not admitted. The question and the hand-over below
    // run in the same tick, so nothing can come between them.
    const closed = recheck()
    if (closed) return { outcome: 'post-failed', reason: 'not-admitted', detail: `${closed} · line posted, no turn started` }
    let routing
    try { routing = route(msg, platform) } catch (error) { routing = Promise.reject(error) }
    const settled = Promise.resolve(routing).then(value => ({ value }), error => ({ error }))
    // An ingress that threw is never read as a started turn, receipt or not.
    const routeError = error => {
      log('scheduled turn: ' + (error?.message || String(error)))
      return { outcome: 'post-unknown', reason: 'route-error', detail: null }
    }
    const first = await Promise.race([settled, watch(task.chatId, receiptId, settled)])
    if (first.admitted || first.timeout) {
      // A message registered and then refused with an error shows it at once.
      const soon = await Promise.race([settled, new Promise(resolve => setTimeout(resolve, 5 * pollMs))])
      if (soon?.error) return routeError(soon.error)
      // The turn goes on in the background; its own durable path ends it.
      settled.then(({ error }) => { if (error) log('scheduled turn: ' + (error?.message || String(error))) })
      return first.admitted ? { outcome: 'posted', reason: null, detail: null }
        : { outcome: 'post-unknown', reason: 'unconfirmed', detail: null }
    }
    const { value, error } = first
    if (error) return routeError(error)
    if (receiptState(task.chatId, receiptId) || value?.duplicate) return { outcome: 'posted', reason: null, detail: null }
    // The line is in the conversation but the service did not take it (it
    // answered there when it had something to say). Not tried again.
    const why = value?.quarantined ? 'quarantined' : value?.held ? 'held' : value?.recovered ? 'recovering'
      : value?.ignored ? 'not-serving' : value?.rejected ? REFUSALS[value.reason] || 'refused' : 'refused'
    return { outcome: 'post-failed', reason: 'not-admitted', detail: why }
  }

  async function fireSay(task, occurrence, group, platform) {
    const posted = await post(platform, task.chatId, redact(task.text, { pii: group?.redactPii !== false }),
      requestKey(task, occurrence))
    if (posted.failed) return { outcome: 'post-failed', reason: 'post-failed', detail: null }
    if (posted.unknown) return { outcome: 'post-unknown', reason: 'post-unknown', detail: posted.unknown }
    return { outcome: 'posted', reason: null, detail: null }
  }

  // How a finished run reads in the core's terms. A run ended by a signal has
  // no exit code: one this service killed for its timeout is `timeout`; any
  // other is reported the way a shell reports it, exit code 128 + the signal
  // number (SIGKILL: 137), with the signal named in the detail.
  function scriptOutcome(res) {
    if (res.timedOut) return { outcome: 'timeout', exitCode: null, reason: 'timeout' }
    if (res.error) return { outcome: 'spawn-failed', exitCode: null, reason: 'spawn-failed' }
    if (Number.isInteger(res.code) && res.code >= 0) return { outcome: 'exit', exitCode: res.code, reason: res.code === 0 ? null : 'exit' }
    return { outcome: 'exit', exitCode: 128 + signalNumber(res.signal), reason: 'signal' }
  }
  const scriptReason = (lang, res, exitCode) => res.timedOut ? pick(lang, '超时被终止', 'timed out and was stopped')
    : res.error ? pick(lang, '没能启动', 'could not start')
    : res.signal && !Number.isInteger(res.code) ? pick(lang, `被信号终止 ${res.signal}`, `stopped by signal ${res.signal}`)
    : pick(lang, `退出码 ${exitCode}`, `exit code ${exitCode}`)

  async function fireScript(task, occurrence, group, tz) {
    // One run of a task at a time: a run still going when the next one is due
    // is this host's own reason to skip it.
    if (running.has(task.id)) return { outcome: 'skipped', reason: 'still-running', detail: null }
    if (!group?.workdir) return { outcome: 'spawn-failed', exitCode: null, reason: 'spawn-failed', detail: 'no project folder' }
    running.set(task.id, null)
    let res
    try {
      res = await new Promise(resolve => resolve(runScript({ command: task.text, cwd: group.workdir,
        env: { ...scriptEnv(task.chatId), TZ: tz },
        timeoutMs: task.timeoutMin > 0 ? task.timeoutMin * 60_000 : DEFAULT_TIMEOUT_MS,
        onChild: child => { if (running.has(task.id)) running.set(task.id, child) } })))
    } catch (error) {
      res = { code: null, signal: null, error: error?.message || String(error), timedOut: false, stdout: '', stderr: '', ms: 0, cwd: group.workdir }
    } finally { running.delete(task.id) }
    const result = scriptOutcome(res)
    const failed = !(result.outcome === 'exit' && result.exitCode === 0)
    log(`scheduled script ${task.id} ${failed ? 'failed' : 'ok'} (${result.outcome}${result.exitCode === null ? '' : ' ' + result.exitCode}) in ${Math.round((res.ms || 0) / 1000)}s`
      + (failed && res.error ? `: ${res.error}` : ''))
    // The list's detail and the notice share one tail: stack frames dropped,
    // the project folder and home folder shortened, secrets redacted.
    const tail = failed ? redact(outputTail(res, { sanitize: true, maxLines: 6, maxChars: 300 }), { pii: group.redactPii !== false }) : ''
    const lang = langOf(task.chatId, group)
    return { ...result, detail: failed ? [scriptReason('en', res, result.exitCode), stopped ? 'service stopping' : '', tail].filter(Boolean).join(' · ') : null,
      // Offered to the caller, which posts it only when the core calls the run failed.
      notice: failed && !stopped ? `${pick(lang, '❌ 定时脚本没跑成功', '❌ Scheduled script failed')}`
        + `${pick(lang, '（', ' (')}${scriptReason(lang, res, result.exitCode)}${pick(lang, '）', ')')} · ${task.name}` + (tail ? '\n' + tail : '') : null }
  }

  // Run one due occurrence. Never rejects: an unexpected error is reported as
  // an outcome whose effect is unknown.
  async function fire(task, occurrence, tz, { recheck = () => null } = {}) {
    try {
      const group = getGroup(task.chatId)
      if (task.kind === 'script') return await fireScript(task, occurrence, group, tz)
      const platform = getPlatform(task.chatId)
      if (!platform || typeof platform.send !== 'function') return { outcome: 'post-failed', reason: 'no-platform', detail: null }
      return task.kind === 'say' ? await fireSay(task, occurrence, group, platform) : await fireModel(task, occurrence, group, platform, recheck)
    } catch (error) {
      log(`scheduled task ${task.id} failed unexpectedly: ${error?.message || String(error)}`)
      return task.kind === 'script' ? { outcome: 'spawn-failed', exitCode: null, reason: 'spawn-failed', detail: null }
        : { outcome: 'post-unknown', reason: 'post-unknown', detail: 'error' }
    }
  }

  // One line telling the conversation a script failed. One attempt; returns
  // 'sent', 'failed' or 'unknown'.
  async function notify(task, text) {
    try {
      const platform = getPlatform(task.chatId)
      if (!platform || typeof platform.send !== 'function') return 'failed'
      const posted = await post(platform, task.chatId, text, undefined)
      return posted.id ? 'sent' : posted.failed ? 'failed' : 'unknown'
    } catch { return 'unknown' }
  }

  return { fire, notify,
    runningScripts: () => [...running.keys()],
    // Service stop: scripts still running are ended with their process group.
    // Their run then reports the signal; no notice is posted for it.
    stop() {
      stopped = true
      let killed = 0
      for (const [id, child] of running) {
        if (!child?.pid) continue
        killed++
        try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
        log(`scheduled script ${id} stopped with the service`)
      }
      return killed
    } }
}

module.exports = { createScheduleFire, shownLine, shownMark, requestKey, SEND_TIMEOUT_MS, SHOWN_PROMPT_CHARS }
