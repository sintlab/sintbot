'use strict'

// Last-resort handler for the running service: an uncaught exception or an
// unhandled rejection.
//
// Without it Node exits on the spot: the log gets Node's own lines with no
// time, and the normal stop never runs (a running turn's executor child is
// left behind as an orphan, the tool socket directory stays, the console's
// last second of activity is not written; only the writer lock goes, through
// the existing exit hook). Here
// the cause is logged once with its stack and the time, then the same stop
// as SIGTERM runs, and the process exits 1 so a launchd job with KeepAlive
// starts it again.
//
// - Fires once. A further error while stopping is only logged, at most
//   MAX_LOGS lines in all, so an error repeating in a loop cannot flood the log.
// - The stop must finish within hardMs (20 s, as the old sbot daemon; the
//   service's own bounded stop is 2 s for the platform plus 12 s for the
//   runners), otherwise exit(1). A stop that throws exits 1 at once.
// - The ceiling timer is unref'd: if the event loop empties first, Node exits
//   by itself with the exitCode 1 set here.
// - The caller's shutdown first writes down the turns still running
//   (src/c2crashstop.js), before the stop seals the journals. At the next
//   start the core decides (ABI 40 unfinished_step "restart"): a turn the
//   crash cut off is told once in its conversation and never redone; the
//   group is not held. Nothing is ever replayed by this handler.

const MAX_LOGS = 5
const MAX_REASON = 8000

function describe(reason) {
  let text
  try {
    if (reason && (reason.stack || reason.message)) text = String(reason.stack || reason.message)
    else if (typeof reason === 'string') text = reason
    else {
      try { text = JSON.stringify(reason) } catch {}
      if (text === undefined) text = String(reason)
    }
  } catch { text = '[reason cannot be printed]' }
  return text.length > MAX_REASON ? text.slice(0, MAX_REASON) + '…' : text
}

function installFatalHandlers({ proc = process, log, shutdown, exit = code => proc.exit(code),
  hardMs = 20_000, setTimer = setTimeout, now = Date.now } = {}) {
  if (typeof log !== 'function' || typeof shutdown !== 'function' || typeof exit !== 'function' ||
      typeof setTimer !== 'function' || typeof now !== 'function' ||
      !Number.isSafeInteger(hardMs) || hardMs < 1 || !proc || typeof proc.on !== 'function') {
    throw new TypeError('Fatal handlers need a process, log, shutdown, exit and a ceiling')
  }
  let fired = false
  let logged = 0
  const write = message => {
    try { log(message) } catch { try { proc.stderr?.write(message + '\n') } catch {} }
  }
  const stamp = () => { try { return new Date(now()).toISOString() } catch { return '' } }
  // Error lines count against the cap; the two closing lines (ceiling, stop
  // failed) happen at most once each and are always written.
  const say = message => { if (logged >= MAX_LOGS) return; logged++; write(message) }
  const handler = kind => reason => {
    if (fired) { say(`SintBot fatal · ${stamp()} · ${kind} while stopping: ${describe(reason)}`); return }
    fired = true
    say(`SintBot fatal · ${stamp()} · ${kind}; stopping the service, then exiting with code 1: ${describe(reason)}`)
    proc.exitCode = 1
    const timer = setTimer(() => {
      write(`SintBot fatal · ${stamp()} · the stop did not finish within ${hardMs} ms; exiting with code 1`)
      exit(1)
    }, hardMs)
    timer?.unref?.()
    // Called synchronously so the service seals admission before anything
    // else runs; a synchronous throw takes the same path as a rejection.
    let stopping
    try { stopping = Promise.resolve(shutdown(kind, reason)) } catch (error) { stopping = Promise.reject(error) }
    stopping.catch(error => {
      write(`SintBot fatal · ${stamp()} · the stop failed; exiting with code 1: ${describe(error)}`)
      exit(1)
    })
  }
  const onException = handler('uncaughtException')
  const onRejection = handler('unhandledRejection')
  proc.on('uncaughtException', onException)
  proc.on('unhandledRejection', onRejection)
  return Object.freeze({
    get fired() { return fired },
    // A startup that fails normally removes the handlers again. Once a fatal
    // error has started the stop they stay, so a second error cannot end the
    // process in the middle of that stop.
    uninstall() {
      if (fired) return false
      proc.off?.('uncaughtException', onException)
      proc.off?.('unhandledRejection', onRejection)
      return true
    },
  })
}

module.exports = { installFatalHandlers, describe, MAX_LOGS }
