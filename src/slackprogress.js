'use strict'
// Slack: the progress message of a running turn (contract I1, 2026-11-22).
//
// One message where the answer will appear (a channel answer's thread, or
// the direct message itself) shows a `plan` block: the turn's title and its
// latest steps, each complete, in progress or failed. The engine decides
// when to open it, what the title and steps say and when to close; this
// module only draws them and keeps the Web API calls polite:
//   - one call at a time per message; while one is in flight only the newest
//     frame waits, older ones are dropped (each frame is the whole state);
//   - an update is one attempt (no retry); a 429 drops that frame and every
//     progress message holds off for the Retry-After (the limit is the app's);
//   - a workspace without plan blocks (`invalid_blocks`, unsupported type)
//     gets plain section lines (✓ / ◐ / ✗) instead, remembered for the
//     process; other refused content falls back for that message only;
//   - closing as 'silent' deletes the message; any other outcome rewrites it
//     to the final title once (a 429 there is waited out once).
// Display only: nothing here is awaited for delivery, an error never reaches
// the turn, and each message logs at most one line about itself.
//
// Every block carries a `sint_progress_<n>` block id (a new one on each
// update), so the message is recognisable when read back from Slack, also
// after a restart: thread context never counts it as the bot's reply.

const TASKS_KEPT = 10
// Slack accepts much longer titles (3001 characters went through on
// 2026-11-22) but documents no limit; a line in a plan stays readable here.
const TITLE_MAX = 150
const TASK_ID_MAX = 48
const STATUSES = new Set(['in_progress', 'complete', 'error'])
const MARKS = { complete: '✓', in_progress: '◐', error: '✗' }
const BLOCK_PREFIX = 'sint_progress_'
const OUTCOMES = new Set(['done', 'stopped', 'failed', 'silent'])
const BLOCK_ERRORS = new Set(['invalid_blocks', 'invalid_blocks_format'])
// The message is gone or cannot be written any more: stop touching it.
const GONE = new Set(['message_not_found', 'cant_update_message', 'edit_window_closed', 'channel_not_found',
  'not_in_channel', 'is_archived', 'msg_too_long', 'msg_blocks_too_long', 'too_many_attachments'])

const T = {
  open: { zh: '处理中', en: 'Working on it' },
  done: { zh: '完成', en: 'Done' },
  stopped: { zh: '已停止', en: 'Stopped' },
  failed: { zh: '没有完成', en: 'Did not finish' },
}

// For the whole process: whether this workspace renders plan blocks, and
// until when every progress message waits after a 429.
const processState = { fallback: false, quietUntil: 0, fallbackLogged: false }

const clip = (value, max) => {
  const text = String(value == null ? '' : value).replace(/\s+/g, ' ').trim()
  return text.length > max ? text.slice(0, max - 1) + '…' : text
}
// Slack reads `&`, `<` and `>` as markup in mrkdwn and in the top-level text.
const escapeText = (text) => String(text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')

// The engine's frame as Slack will show it: a clipped title and the last
// ten valid steps, each with a unique id. `outcome` settles a step still in
// progress: complete when the turn is done, failed when it stopped or failed.
function normalizeFrame(frame, { lang = 'en', outcome = null } = {}) {
  const words = lang === 'zh' ? 'zh' : 'en'
  const fallbackTitle = (outcome && T[outcome] ? T[outcome] : T.open)[words]
  const title = clip(frame && frame.title, TITLE_MAX) || fallbackTitle
  const steps = Array.isArray(frame && frame.steps) ? frame.steps : []
  const kept = steps.filter((step) => step && typeof step === 'object' && clip(step.text, TITLE_MAX)).slice(-TASKS_KEPT)
  const seen = new Set()
  const tasks = kept.map((step, index) => {
    let status = STATUSES.has(step.status) ? step.status : 'in_progress'
    if (status === 'in_progress' && outcome === 'done') status = 'complete'
    else if (status === 'in_progress' && (outcome === 'stopped' || outcome === 'failed')) status = 'error'
    // Slack refuses a plan whose task ids repeat (invalid_blocks, "task_ids must be unique").
    let id = String(step.id == null ? '' : step.id).replace(/[^\w.-]/g, '_').slice(0, TASK_ID_MAX) || `s${index}`
    if (seen.has(id)) { let n = 2; while (seen.has(`${id}_${n}`)) n++; id = `${id}_${n}` }
    seen.add(id)
    return { id, text: clip(step.text, TITLE_MAX), status }
  })
  return { title, tasks }
}

function planBlocks(frame, seq) {
  return [{ type: 'plan', block_id: BLOCK_PREFIX + seq, title: frame.title,
    tasks: frame.tasks.map((task) => ({ task_id: task.id, title: task.text, status: task.status })) }]
}

function sectionBlocks(frame, seq) {
  const lines = [`*${escapeText(frame.title)}*`, ...frame.tasks.map((task) => `${MARKS[task.status]} ${escapeText(task.text)}`)]
  return [{ type: 'section', block_id: BLOCK_PREFIX + seq, text: { type: 'mrkdwn', text: lines.join('\n') } }]
}

// The top-level text: what a notification and a client without blocks show.
// The title, and the step in progress if there is one.
function frameText(frame) {
  const current = [...frame.tasks].reverse().find((task) => task.status === 'in_progress')
  return escapeText(clip(current ? `${frame.title} · ${current.text}` : frame.title, 300))
}

const FINAL_RETRIES = 2
const FINAL_RETRY_MS = 1500

// Whether a message read back from Slack is one of these progress messages.
function isProgressMessage(message) {
  const blocks = message && Array.isArray(message.blocks) ? message.blocks : []
  return blocks.some((block) => block && typeof block.block_id === 'string' && block.block_id.startsWith(BLOCK_PREFIX))
}

// An `invalid_blocks` that names the block type: this workspace (or client
// version) does not know plan blocks. Without details Slack said nothing more
// specific, which is read the same way.
function unsupportedType(error) {
  const messages = error && error.payload && error.payload.response_metadata && error.payload.response_metadata.messages
  if (!Array.isArray(messages) || !messages.length) return true
  return messages.some((line) => /unsupported type|unknown type|invalid type/i.test(String(line)))
}

/**
 * One progress message. Nothing is posted until the first frame: `open`
 * puts a "Working on it" frame in line on the next turn of the event loop,
 * and a frame given before then replaces it.
 * @param {object} o
 *   call          the adapter's Web API helper (form encoded, proxy aware)
 *   channel       Slack channel id
 *   threadTs      the thread the answer goes in, or null (a direct message)
 *   lang          'zh' | 'en': the default titles
 *   remember      (ts) => void: marks the message as the bot's own (loop guard)
 *   deleteMessage (channel, ts) => Promise<boolean>
 *   state         shared state (tests); defaults to the process's
 */
function openSlackProgress({ call, channel, threadTs = null, lang = 'en', log = () => {}, remember = () => {},
  deleteMessage = null, state = processState, now = Date.now, defer = setImmediate, initial = null, retryMs = FINAL_RETRY_MS } = {}) {
  if (typeof call !== 'function' || typeof channel !== 'string' || !channel) return null
  let ts = null
  let seq = 0
  let pending = null
  let running = null
  let closed = false
  let dead = false
  let ownFallback = false
  let logged = false
  let finished = null
  const once = (line) => { if (!logged) { logged = true; try { log(line) } catch {} } }

  // One attempt at one frame; true when Slack took it.
  async function send(frame, { final = false, attempt = 0 } = {}) {
    const fallback = state.fallback || ownFallback
    seq += 1
    const body = { channel, text: frameText(frame), blocks: fallback ? sectionBlocks(frame, seq) : planBlocks(frame, seq) }
    const first = !ts
    if (first) Object.assign(body, threadTs ? { thread_ts: threadTs } : {}, { unfurl_links: false, unfurl_media: false })
    else body.ts = ts
    try {
      const response = await call(first ? 'chat.postMessage' : 'chat.update', body, { retries: 0, retry429: final ? 1 : 0 })
      if (first) {
        if (response && typeof response.ts === 'string' && response.ts) { ts = response.ts; try { remember(ts) } catch {} }
        // Accepted without an id: nothing to update or delete later.
        else { dead = true; once('Slack progress message: posted without an id; not updated further') }
      }
      return true
    } catch (error) {
      const code = (error && error.code) || 'unknown'
      if (BLOCK_ERRORS.has(code) && !fallback) {
        if (unsupportedType(error)) {
          state.fallback = true
          if (!state.fallbackLogged) { state.fallbackLogged = true; try { log(`Slack plan blocks unavailable (${code}); progress shows plain lines from now on`) } catch {} }
        } else ownFallback = true
        seq -= 1
        return send(frame, { final, attempt })
      }
      if (code === 'ratelimited' || code === 'rate_limited') {
        const wait = Number(error.payload && error.payload.retryAfterMs) || 1000
        state.quietUntil = Math.max(state.quietUntil, now() + wait)
        once(`Slack progress: rate limited, frames skipped for ${Math.ceil(wait / 1000)}s`)
        return false
      }
      // A first post that timed out may still have landed: posting again
      // could leave two, so this message stops here.
      if (first || GONE.has(code) || (error && (error.kind === 'fatal' || error.kind === 'channel'))) {
        dead = true
        once(`Slack progress stopped (${code})`)
        return false
      }
      // The closing frame is an update of a message that exists: sending it
      // again cannot leave a second one, so a transient failure gets two more tries.
      if (final && attempt < FINAL_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, retryMs))
        return send(frame, { final, attempt: attempt + 1 })
      }
      once(`Slack progress update skipped (${code})`)
      return false
    }
  }

  // `busy`, not `running`, says whether the loop runs: a loop that drops every
  // frame ends before its promise is even assigned.
  let busy = false
  function pump() {
    if (busy) return running
    busy = true
    running = (async () => {
      try {
        while (pending && !dead && !closed) {
          const frame = pending
          pending = null
          // While Slack asks the app to wait, frames are dropped; the next one shows the state.
          if (now() < state.quietUntil) continue
          await send(frame)
        }
      } catch (error) { once(`Slack progress error (${(error && error.message) || error})`) }
      finally { busy = false }
    })()
    return running
  }

  const handle = {
    update(frame) {
      if (closed || dead) return Promise.resolve()
      pending = normalizeFrame(frame, { lang })
      return pump()
    },
    close({ outcome = 'done', ...frame } = {}) {
      if (finished) return finished
      closed = true
      pending = null
      const end = OUTCOMES.has(outcome) ? outcome : 'done'
      finished = (async () => {
        try { await running } catch {}
        if (!ts || dead) return
        if (end === 'silent') {
          try {
            if (deleteMessage) await deleteMessage(channel, ts)
            else { try { remember(ts) } catch {} await call('chat.delete', { channel, ts }, { retries: 1 }) }
          } catch (error) { once(`Slack progress message not deleted (${(error && error.code) || error})`) }
          return
        }
        await send(normalizeFrame(frame, { lang, outcome: end }), { final: true })
      })().catch(() => {})
      return finished
    },
    get ts() { return ts },
  }
  // The opening frame, unless the engine's first frame arrives first.
  // The engine may hand the first frame with the open (steps already known).
  defer(() => { if (!pending && !ts && !closed && !dead && !busy && !running) { pending = normalizeFrame(initial && typeof initial === 'object' ? initial : {}, { lang }); pump() } })
  return handle
}

module.exports = { openSlackProgress, normalizeFrame, planBlocks, sectionBlocks, frameText, isProgressMessage,
  BLOCK_PREFIX, TASKS_KEPT, TITLE_MAX, processState }
