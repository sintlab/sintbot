'use strict'
// Progress for a platform whose answer is a separate plain message (a Slack
// channel thread or direct message): one progress message the adapter opens
// where the answer will appear, kept up to date while the turn runs and closed
// when the turn ends. Display only: it is no receipt, no effect and no part of
// the answer. Every call is best effort: an error is logged once per turn and
// never reaches the turn, and the turn never waits for any of it.
//
//   platform.openProgress(chatId, replyCtx, { lang, title, steps, elapsedMs }) -> handle | null (or a Promise of one)
//   handle.update({ title, steps, elapsedMs }) -> Promise
//   handle.close({ outcome, title, steps, elapsedMs }) -> Promise
//   steps: [{ id, text, status: 'in_progress' | 'complete' | 'error' }]
//   outcome: 'done' | 'stopped' | 'failed' | 'silent'
//
// The adapter needs only `lang` to open; the first frame rides along so it can
// show it at once. Calls to one handle never overlap: an update waits for the
// one in flight, frames asked for meanwhile collapse into the latest, and two
// updates start at least `minGapMs` apart. close() supersedes anything not yet
// sent and waits for an open or update in flight; it is sent once.

const OUTCOMES = Object.freeze(['done', 'stopped', 'failed', 'silent'])
const MIN_GAP_MS = 3_000

// frame(): the running frame { title, steps, elapsedMs }; finalFrame(outcome):
// the closing one. Both are read when a call is made, so a frame is always the
// latest; finalFrame is read once, when close() is called.
function createPlainProgress({ platform, chatId, replyCtx, lang = 'zh', frame, finalFrame, log = () => {},
  minGapMs = MIN_GAP_MS, now = Date.now, setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  if (!platform || typeof platform.openProgress !== 'function' ||
      typeof frame !== 'function' || typeof finalFrame !== 'function') {
    throw new TypeError('plain progress needs an adapter that opens progress and its frames')
  }
  // idle → opening → open → closed; off: the adapter gave no handle (or failed to open).
  let phase = 'idle'
  let handle = null
  let closing = null // the closing frame, once close() was called
  let paused = false // the runner has ended: nothing but the close is sent
  let busy = false // an update is in flight
  let want = null // null | 'changed' (only when the steps changed) | 'force'
  let lastAt = 0
  let lastKey = ''
  let timer = null
  let logged = false
  let settle = null
  const closed = new Promise(resolve => { settle = resolve })
  const fail = (what, error) => {
    if (logged) return
    logged = true
    try { log(`group ${chatId}: progress message ${what} failed (${error?.message || String(error)}); the turn goes on`) } catch {}
  }
  const call = (what, fn) => Promise.resolve().then(fn).then(() => true, error => { fail(what, error); return false })
  const stepsKey = value => { try { return JSON.stringify(value?.steps || []) } catch { return '' } }
  const read = (what, fn, arg) => {
    try { return fn(arg) } catch (error) { fail(what, error); return null }
  }
  const stopTimer = () => { if (timer) { clearTimer(timer); timer = null } }

  function finish() {
    if (phase === 'closed') return
    const wasOpen = phase === 'open'
    phase = 'closed'
    stopTimer()
    if (!wasOpen || !closing) return settle(false)
    call('close', () => handle.close(closing)).then(settle)
  }
  function flush() {
    if (phase !== 'open' || closing || paused) { want = null; return }
    if (!want || busy) return
    const next = read('frame', frame)
    if (!next) { want = null; return }
    const key = stepsKey(next)
    if (want !== 'force' && key === lastKey) { want = null; return }
    want = null
    lastKey = key
    lastAt = now()
    busy = true
    call('update', () => handle.update(next)).then(() => {
      busy = false
      if (closing) finish()
      else if (want) schedule()
    })
  }
  function schedule() {
    if (busy || timer || phase !== 'open') return
    const wait = lastAt + minGapMs - now()
    if (wait > 0) {
      timer = setTimer(() => { timer = null; flush() }, wait)
      if (timer && typeof timer.unref === 'function') timer.unref()
    } else flush()
  }

  return {
    get opened() { return phase === 'open' },
    get lastSentAt() { return lastAt },
    // Opens the message once; later calls do nothing.
    open() {
      if (phase !== 'idle' || closing || paused) return
      phase = 'opening'
      lastAt = now()
      const first = read('frame', frame)
      if (first) lastKey = stepsKey(first)
      let opening
      try {
        opening = Promise.resolve(platform.openProgress(chatId, replyCtx, { lang, ...(first || {}) }))
      } catch (error) { opening = Promise.reject(error) }
      opening.then(value => {
        if (phase !== 'opening') return
        if (!value || typeof value.update !== 'function' || typeof value.close !== 'function') {
          phase = 'off'
          if (closing) finish()
          return
        }
        handle = value
        phase = 'open'
        if (closing) return finish()
        // Steps seen while the message was being posted.
        if (!paused) { want = want || 'changed'; schedule() }
      }, error => {
        fail('open', error)
        if (phase !== 'opening') return
        phase = 'off'
        if (closing) finish()
      })
    },
    // A newer frame. `force`: send it even when only the title changed (the
    // elapsed time); otherwise only when the steps changed.
    request({ force = false } = {}) {
      if (closing || paused) return
      want = force ? 'force' : want || 'changed'
      if (phase === 'open') schedule()
    },
    // The runner ended: no more updates; the close says how it ended.
    pause() {
      paused = true
      want = null
      stopTimer()
    },
    // Ends the message. Resolves once the adapter answered (or nothing was
    // open); never rejects. Called again, it returns the same promise.
    close(outcome) {
      if (closing || phase === 'closed') return closed
      const kind = OUTCOMES.includes(outcome) ? outcome : 'failed'
      const last = read('frame', finalFrame, kind) || {}
      closing = { ...last, outcome: kind }
      paused = true
      want = null
      stopTimer()
      if (phase === 'idle' || phase === 'off') finish()
      else if (phase === 'open' && !busy) finish()
      // opening, or an update in flight: finished when that settles.
      return closed
    },
  }
}

module.exports = { createPlainProgress, PLAIN_PROGRESS_OUTCOMES: OUTCOMES, PLAIN_PROGRESS_MIN_GAP_MS: MIN_GAP_MS }
