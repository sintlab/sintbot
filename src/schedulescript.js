'use strict'
// Running a scheduled script: one shell command in the conversation's project
// folder, its exit code and output collected. The spawn can be injected.

const os = require('node:os')
const { spawn: nodeSpawn } = require('node:child_process')

const IS_WIN = process.platform === 'win32'
const DEFAULT_TIMEOUT_MS = 15 * 60_000 // a script that hangs is ended after this long unless its task sets a limit
const MAX_OUTPUT = 64 * 1024 // per stream; only the end is kept, for the failure detail
const STDIO_GRACE_MS = 1500 // after exit, how long the pipes may stay open (a background process it started still holds stdout)
const KILL_GRACE_MS = 2000 // after the timeout kill, how long to wait for close before settling anyway

// Run one command (through the shell, cwd = the project folder) and collect
// its exit code and both output streams. A timeout kills the whole process tree.
// Always resolves, never rejects: { code, signal, timedOut, stdout, stderr, ms, cwd, error }.
//   code null with error set = the process never started (no shell, no such folder).
// The run settles on **exit**, not on close: close waits until every stdio pipe
//   is closed, and a background process the script started (a daemonized
//   child, `some-server &`) can hold stdout for ever. Settling on close would
//   leave such a run unfinished, or report a script that exited 0 as timed out
//   and kill that process. After exit the streams get a short grace period,
//   then the run settles and both streams are destroyed; after a timeout kill a
//   fallback timer settles it as well when close never comes.
// onChild(child): receives the child process (so a stopping service can end it); optional.
function runScriptTask({ command, cwd, env, timeoutMs = DEFAULT_TIMEOUT_MS, spawn = nodeSpawn, now = Date.now, onChild } = {}) {
  return new Promise((resolve) => {
    const t0 = now()
    let stdout = '', stderr = '', settled = false, timedOut = false, timer = null, graceTimer = null, exited = null
    const cap = (s, add) => (s.length >= MAX_OUTPUT ? s : (s + add).slice(-MAX_OUTPUT))
    let child
    const destroyStreams = () => { try { child && child.stdout && child.stdout.destroy() } catch {} ; try { child && child.stderr && child.stderr.destroy() } catch {} }
    const finish = (r) => {
      if (settled) return
      settled = true
      if (timer) clearTimeout(timer)
      if (graceTimer) clearTimeout(graceTimer)
      destroyStreams()
      resolve({ code: null, signal: null, error: null, ...r, timedOut, stdout, stderr, ms: now() - t0, cwd })
    }
    try {
      // detached (POSIX): the child leads its own process group, so a timeout's kill(-pid) ends the shell and the script together; Windows uses taskkill /T.
      child = spawn(command, { cwd, env, shell: true, detached: !IS_WIN, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (e) {
      return finish({ error: (e && e.message) || String(e) })
    }
    if (typeof onChild === 'function') { try { onChild(child) } catch {} }
    const killTree = () => {
      if (!child || !child.pid) return
      if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {} ; return }
      try { process.kill(-child.pid, 'SIGKILL') } catch { try { child.kill('SIGKILL') } catch {} }
    }
    if (child.stdout) child.stdout.on('data', (d) => { stdout = cap(stdout, String(d)) })
    if (child.stderr) child.stderr.on('data', (d) => { stderr = cap(stderr, String(d)) })
    child.on('error', (e) => finish({ error: (e && e.message) || String(e) }))
    child.on('exit', (code, signal) => {
      exited = { code, signal }
      if (!graceTimer) graceTimer = setTimeout(() => finish(exited), STDIO_GRACE_MS)
    })
    child.on('close', (code, signal) => finish({ code, signal }))
    if (timeoutMs > 0) timer = setTimeout(() => { timedOut = true; killTree(); if (!graceTimer) graceTimer = setTimeout(() => finish(exited || { code: null, signal: 'SIGKILL' }), KILL_GRACE_MS) }, timeoutMs)
  })
}

// The end of a run's output (the lines people see when it failed): both streams
// together, blank lines dropped, the last maxLines lines, at most maxChars long.
// sanitize (for the conversation): no machine paths — stack-frame lines
//   (`    at …`) are dropped, the project folder becomes `.` and home becomes `~`.
function outputTail(res, { maxLines = 8, maxChars = 600, sanitize = false } = {}) {
  let lines = ((res.stderr || '') + '\n' + (res.stdout || '')).split(/\r?\n/).map((l) => l.trimEnd()).filter(Boolean)
  if (sanitize) {
    lines = lines.filter((l) => !/^\s+at\s/.test(l))
    const home = os.homedir()
    const cwd = res.cwd ? String(res.cwd).replace(/[\\/]+$/, '') : ''
    lines = lines.map((l) => {
      let t = l
      if (cwd) t = t.split(cwd).join('.')
      if (home) t = t.split(home).join('~')
      return t
    })
  }
  let out = lines.slice(-maxLines).join('\n')
  if (out.length > maxChars) out = '…' + out.slice(-maxChars)
  return out
}

module.exports = { runScriptTask, outputTail, DEFAULT_TIMEOUT_MS }
