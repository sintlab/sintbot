'use strict'
// Signing in to a Claude or ChatGPT account from the console (model library),
// instead of opening a terminal. It runs the executor's own login command on
// this Mac (`claude auth login`, `codex login`): the command opens the
// browser itself and finishes through its own local callback. The page shows
// the sign-in link as a fallback, and for Claude a box for the code the page
// may ask to paste (written to the command's stdin). Nothing from the request
// reaches the command line; one sign-in per executor at a time; 10 minutes
// at most.
const { spawn } = require('node:child_process')

const RUNNERS = Object.freeze(['claude', 'codex'])
const TIMEOUT_MS = 10 * 60_000
const URL_RE = /https:\/\/[^\s"'<>]+/

function argsOf(runner) { return runner === 'claude' ? ['auth', 'login', '--claudeai'] : ['login'] }

function createRunnerLogin({ spawnImpl = spawn, env = () => process.env, binOf = runner => runner,
  timeoutMs = TIMEOUT_MS, onDone = () => {}, now = Date.now } = {}) {
  const jobs = new Map()
  const view = job => job ? { phase: job.phase, url: job.url, error: job.error, startedAt: job.startedAt } : { phase: 'idle', url: '', error: '', startedAt: 0 }
  function start(runner) {
    if (!RUNNERS.includes(runner)) throw new Error('unknown executor')
    const running = jobs.get(runner)
    if (running && (running.phase === 'starting' || running.phase === 'waiting')) return view(running)
    const job = { phase: 'starting', url: '', error: '', out: '', startedAt: now(), child: null }
    jobs.set(runner, job)
    let child
    try {
      child = spawnImpl(binOf(runner), argsOf(runner), { env: env(), stdio: ['pipe', 'pipe', 'pipe'] })
    } catch (error) {
      job.phase = 'failed'; job.error = String(error?.message || error).slice(0, 200)
      return view(job)
    }
    job.child = child
    const read = chunk => {
      job.out = (job.out + String(chunk)).slice(-8000)
      if (!job.url) {
        const m = URL_RE.exec(job.out)
        if (m) { job.url = m[0]; if (job.phase === 'starting') job.phase = 'waiting' }
      }
    }
    child.stdout?.on('data', read)
    child.stderr?.on('data', read)
    child.stdin?.on('error', () => {})
    const timer = setTimeout(() => { job.timedOut = true; try { child.kill('SIGTERM') } catch {} }, timeoutMs)
    const finish = (code, error) => {
      clearTimeout(timer)
      if (job.phase === 'done' || job.phase === 'failed' || job.phase === 'cancelled') return
      job.child = null
      if (job.cancelled) { job.phase = 'cancelled'; return }
      if (code === 0 && !error) { job.phase = 'done'; try { onDone(runner) } catch {} ; return }
      job.phase = 'failed'
      job.error = job.timedOut ? 'timeout' : String(error?.message || lastLine(job.out) || `exit ${code}`).slice(0, 200)
    }
    child.on('error', error => finish(-1, error))
    child.on('close', code => finish(code))
    return view(job)
  }
  // The code the sign-in page shows when its own redirect cannot reach this Mac.
  function code(runner, text) {
    const job = jobs.get(runner)
    const value = String(text || '').trim()
    if (!job || !job.child || !(job.phase === 'waiting' || job.phase === 'starting')) return false
    if (!value || value.length > 2000 || /[\r\n]/.test(value)) return false
    try { job.child.stdin.write(`${value}\n`); return true } catch { return false }
  }
  function cancel(runner) {
    const job = jobs.get(runner)
    if (!job || !job.child) return false
    job.cancelled = true
    try { job.child.kill('SIGTERM') } catch {}
    return true
  }
  const snapshot = () => Object.fromEntries(RUNNERS.map(r => [r, view(jobs.get(r))]))
  const stopAll = () => { for (const r of RUNNERS) cancel(r) }
  return { start, code, cancel, snapshot, stopAll }
}

function lastLine(text) {
  return String(text || '').split('\n').map(s => s.trim()).filter(Boolean).filter(s => !URL_RE.test(s)).pop() || ''
}

module.exports = { createRunnerLogin, RUNNERS }
