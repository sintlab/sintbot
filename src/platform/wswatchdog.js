// WS liveness watchdog — a pure, testable state machine over the Feishu WSClient
// connection lifecycle. It tracks connection health for the console and decides
// when the SDK's own recovery has failed and we must force-rebuild the client.
//
// Why a separate module: the SDK's reconnect path is opaque and only exercisable
// against a live Feishu link (real-machine only), but the "when do we stop
// trusting the SDK and rebuild" logic is pure state + timing — the part worth
// unit-testing. feishu.js feeds the real SDK callbacks into these methods; this
// module holds no SDK reference, only state and decisions.
//
// Layering (WS 活性看门狗):
//   L1  SDK pingTimeout pong-watchdog → terminates a silently-dead socket so its
//       own reconnect fires (handled inside the SDK once we enable it in feishu.js).
//   L2  onReady/onReconnecting/onReconnected/onError → this state machine + the
//       health snapshot surfaced in the console.
//   L3  THIS: force-rebuild the WSClient when the SDK reports a terminal error
//       (onError) or gets wedged in a non-connected state past a grace (tick).
//       Rebuilds are throttled with exponential backoff so a hard-down gateway
//       can't spin us in a tight rebuild loop.
//
// Timing is external + injectable (`now`, and the caller drives `tick()`), so the
// whole thing is deterministic under test — no real timers, no SDK.

const DEFAULTS = {
  // A connection stuck in reconnecting/failed with no recovery for this long is
  // treated as wedged → rebuild. Generous so we don't fight the SDK's own retry.
  staleReconnectingMs: 120_000,
  backoffBaseMs: 2_000,   // first backoff step after the immediate first rebuild
  backoffCapMs: 60_000,   // ceiling so a permanent outage settles to ~1 rebuild/min
}

/**
 * @param {object} deps
 *   now      — () => epoch ms (injectable for tests)
 *   rebuild  — () => void|Promise, performs the actual close+recreate of the WSClient
 *   log      — (msg) => void
 *   onConn   — (snapshot) => void, fired on every state transition (console SSE)
 *   staleReconnectingMs / backoffBaseMs / backoffCapMs — tuning overrides
 */
function createWatchdog({ now = () => Date.now(), rebuild = () => {}, log = () => {}, onConn = () => {}, ...opts } = {}) {
  const cfg = { ...DEFAULTS, ...opts }
  const s = {
    state: 'connecting', // connecting | connected | reconnecting | failed | stopped
    since: now(),        // when we entered `state`
    lastReadyAt: 0,      // last successful (re)connect
    lastEventAt: 0,      // last inbound event from Feishu (liveness proof, display-only)
    reconnects: 0,       // SDK-driven reconnect cycles observed
    rebuilds: 0,         // force-rebuilds we performed
    lastError: null,
  }
  let consecFail = 0       // rebuilds since the last healthy connect — drives backoff
  let pendingRebuildAt = 0 // 0 = nothing scheduled; else earliest epoch ms to rebuild
  let stopped = false

  const snapshot = () => ({ ...s })
  const emit = () => { try { onConn(snapshot()) } catch { /* observer must never break the WS */ } }
  const setState = (state, extra) => { s.state = state; s.since = now(); if (extra) Object.assign(s, extra); emit() }

  // Backoff for the Nth consecutive failure: 0 (immediate) for the first, then
  // base, 2·base, 4·base … capped. So recovery is snappy but a dead gateway settles.
  const delayFor = (n) => (n <= 0 ? 0 : Math.min(cfg.backoffCapMs, cfg.backoffBaseMs * 2 ** (n - 1)))

  const doRebuild = () => {
    if (stopped) return
    pendingRebuildAt = 0
    consecFail++
    s.rebuilds++
    setState('connecting') // a fresh client is coming up
    log(`ws watchdog: force-rebuilding WSClient (rebuild #${s.rebuilds}, consecutive fail ${consecFail})`)
    try { Promise.resolve(rebuild()).catch((e) => log('ws rebuild error: ' + (e && e.message))) }
    catch (e) { log('ws rebuild threw: ' + (e && e.message)) }
    // Arm the next backoff window: if this fresh client also fails before a tick,
    // the guard keeps us from rebuilding again immediately.
    pendingRebuildAt = now() + delayFor(consecFail)
  }

  const maybeRebuild = () => {
    if (stopped) return
    const t = now()
    if (s.state === 'connected') return // healthy — nothing to do
    // 'failed' rebuilds ASAP (subject to backoff). Any other non-connected state —
    // reconnecting (SDK retrying) OR connecting (initial / a rebuilt client that
    // never reported back) — only rebuilds once it's been stuck past the grace, so
    // we don't fight the SDK's own recovery or a still-connecting fresh client.
    const wedged = (t - s.since) > cfg.staleReconnectingMs
    if (s.state !== 'failed' && !wedged) return
    if (pendingRebuildAt && t < pendingRebuildAt) return // backoff not elapsed yet
    doRebuild()
  }

  // After stop() the watchdog is inert: a late SDK callback (defensive — close()
  // removes listeners) must not resurrect state or trigger a rebuild.
  return {
    snapshot,
    // SDK first-connect succeeded.
    onReady() {
      if (stopped) return
      consecFail = 0; pendingRebuildAt = 0; s.lastError = null
      setState('connected', { lastReadyAt: now() })
      log('ws watchdog: connected')
    },
    // SDK dropped the socket and is retrying on its own.
    onReconnecting() {
      if (stopped) return
      s.reconnects++
      setState('reconnecting')
    },
    // SDK's own retry got back in.
    onReconnected() {
      if (stopped) return
      consecFail = 0; pendingRebuildAt = 0; s.lastError = null
      setState('connected', { lastReadyAt: now() })
      log('ws watchdog: reconnected')
    },
    // SDK gave up (fatal pull error / reconnect exhausted) — we must rebuild.
    onError(err) {
      if (stopped) return
      s.lastError = (err && err.message) || String(err || 'unknown')
      if (!pendingRebuildAt) pendingRebuildAt = now() + delayFor(consecFail)
      setState('failed')
      log('ws watchdog: SDK reported terminal error — ' + s.lastError)
      maybeRebuild()
    },
    // Any inbound Feishu event — proof the link is alive (display-only; the SDK's
    // pong-watchdog is the real liveness signal). Cheap, so no emit here.
    onEvent() { if (!stopped) s.lastEventAt = now() },
    // Periodic health tick from the daemon: drives the wedged-state rebuild.
    tick() { if (!stopped) maybeRebuild() },
    stop() { if (stopped) return; stopped = true; pendingRebuildAt = 0; setState('stopped') },
  }
}

module.exports = { createWatchdog, DEFAULTS }
