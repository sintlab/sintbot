// Installs the executors (Claude Code, Codex) a new Mac does not have yet,
// from the setup page, in the background: the page never waits on it and the
// scan is never blocked. Each package goes into its own prefix under SintBot's
// tools folder (next to `releases/`; `tools/pkg/<name>`), so the two install at
// the same time without sharing an npm lockfile; `tools/bin/<name>` links to
// it. Never the system npm prefix: no sudo, and an executor the person
// installed themselves is never touched. Together they take about 750 MB.
// The desktop app already puts `<root>/tools/bin` on the service PATH; the
// service entry adds it at start (`toolsBinOnPath`) for terminal installs.
//
// Registry: the person's own npm registry when they set one; otherwise the
// official one if it answers, else the mainland mirror (same rule as
// src/installdeps.js, which the terminal wizard uses).
const fs = require('node:fs')
const path = require('node:path')
const { spawn } = require('node:child_process')
const installdeps = require('./installdeps')

const NAMES = Object.freeze(['claude', 'codex'])
const TAIL = 600
// Both packages unpack to about 750 MB; ask for headroom before starting.
const MIN_FREE_BYTES = 2 * 1024 ** 3

function freeBytes(dir) {
  try { const st = fs.statfsSync(dir); return Number(st.bavail) * Number(st.bsize) } catch { return Infinity }
}

function toolsRoot(env = process.env, home = require('node:os').homedir()) {
  const releases = env.SINTBOT_RELEASES_DIR
  const base = releases && path.isAbsolute(releases) ? path.dirname(releases) : path.join(home, '.local', 'share', 'sintbot')
  return path.join(base, 'tools')
}

function toolsBin(env, home) { return path.join(toolsRoot(env, home), 'bin') }

// Appends the tools bin to PATH (lowest priority: a person's own install wins).
function toolsBinOnPath(env = process.env, home) {
  const bin = toolsBin(env, home)
  const parts = String(env.PATH || '').split(path.delimiter).filter(Boolean)
  if (!parts.includes(bin)) parts.push(bin)
  // Codex installed here is a node script (`#!/usr/bin/env node`); a Mac with
  // only the desktop app's own node has no other, so that node goes last too.
  const node = path.dirname(process.execPath)
  if (!parts.includes(node)) parts.push(node)
  env.PATH = parts.join(path.delimiter)
  return env.PATH
}

function npmBin() {
  const sibling = path.join(path.dirname(process.execPath), 'npm')
  return fs.existsSync(sibling) ? sibling : 'npm'
}

// Runs npm without a shell; resolves { code, out } with a bounded output tail.
function runNpm(args, { env, timeout = 15 * 60_000, spawnImpl = spawn } = {}) {
  return new Promise(resolve => {
    let out = ''
    let child
    try { child = spawnImpl(npmBin(), args, { env, stdio: ['ignore', 'pipe', 'pipe'] }) } catch (error) {
      return resolve({ code: -1, out: String(error?.message || error) })
    }
    const keep = chunk => { out = (out + String(chunk)).slice(-4000) }
    child.stdout?.on('data', keep)
    child.stderr?.on('data', keep)
    const timer = setTimeout(() => { try { child.kill('SIGTERM') } catch {} }, timeout)
    child.on('error', error => { clearTimeout(timer); resolve({ code: -1, out: `${out}\n${error.message}` }) })
    child.on('close', code => { clearTimeout(timer); resolve({ code: code ?? -1, out }) })
  })
}

// Plain-language reason for a failed install, from npm's output.
function failureReason(out) {
  const text = String(out || '')
  if (/ENOSPC/.test(text)) return 'disk'
  if (/EACCES|EPERM/.test(text)) return 'permission'
  if (/ENOTFOUND|ETIMEDOUT|ECONNRESET|ECONNREFUSED|EAI_AGAIN|network|fetch failed|socket hang up/i.test(text)) return 'network'
  return 'other'
}

function createRunnerInstaller({ env = process.env, home, run = runNpm, probe = installdeps.probeCli,
  isInstalled = () => false, log = () => {}, free = freeBytes } = {}) {
  const prefix = toolsRoot(env, home)
  const bin = path.join(prefix, 'bin')
  const state = Object.fromEntries(NAMES.map(name => [name, { phase: 'idle', reason: '', version: '', tail: '' }]))
  let registryPick = null
  const childEnv = () => {
    const out = {}
    for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'ALL_PROXY',
      'http_proxy', 'https_proxy', 'no_proxy', 'all_proxy', 'LANG', 'LC_ALL', 'npm_config_registry']) {
      if (env[key] !== undefined) out[key] = env[key]
    }
    // npm's own shebang needs a node; the one running SintBot is always there.
    out.PATH = [path.dirname(process.execPath), out.PATH || ''].filter(Boolean).join(path.delimiter)
    return out
  }
  const pickRegistry = async () => {
    if (registryPick) return registryPick
    registryPick = (async () => {
      const configured = await run(['config', 'get', 'registry'], { env: childEnv(), timeout: 15_000 })
      const value = configured.code === 0 ? String(configured.out || '').trim().split('\n').pop().trim() : ''
      if (value && !/^https?:\/\/registry\.npmjs\.org\/?$/i.test(value)) return installdeps.chooseRegistry(value, false)
      const ping = await run(['ping', '--registry', 'https://registry.npmjs.org/', '--fetch-timeout=6000', '--fetch-retries=0'], { env: childEnv(), timeout: 20_000 })
      return installdeps.chooseRegistry(value, ping.code === 0)
    })()
    return registryPick
  }
  async function installOne(name) {
    const s = state[name]
    s.phase = 'installing'; s.reason = ''; s.tail = ''
    try {
      const own = path.join(prefix, 'pkg', name)
      fs.mkdirSync(own, { recursive: true, mode: 0o755 })
      fs.mkdirSync(bin, { recursive: true, mode: 0o755 })
      if (free(prefix) < MIN_FREE_BYTES) { s.phase = 'failed'; s.reason = 'disk'; log(`${name} not installed: less than 2 GB free`); return }
      const { registry } = await pickRegistry()
      const args = installdeps.installArgs(installdeps.PACKAGES[name], registry)
      // `install -g` into this executor's own prefix: the binary lands in <own>/bin.
      args.splice(2, 0, '--prefix', own)
      args.push('--no-audit', '--no-fund')
      log(`installing ${name}${registry ? ` from ${registry}` : ''}`)
      const r = await run(args, { env: childEnv() })
      s.tail = String(r.out || '').trim().slice(-TAIL)
      if (r.code !== 0) { s.phase = 'failed'; s.reason = failureReason(r.out); log(`${name} install failed (${s.reason})`); return }
      const target = path.join(own, 'bin', name)
      const check = probe(target, { name })
      if (!check.ok) { s.phase = 'failed'; s.reason = 'verify'; s.tail = String(check.error || '').slice(-TAIL); log(`${name} did not answer --version after install`); return }
      // The shared bin links to the executor's own prefix; replaced atomically.
      const link = path.join(bin, name)
      const tmp = `${link}.${process.pid}.tmp`
      try { fs.rmSync(tmp, { force: true }) } catch {}
      fs.symlinkSync(path.relative(bin, target), tmp)
      fs.renameSync(tmp, link)
      s.phase = 'done'; s.version = check.version
      toolsBinOnPath(env, home)
      log(`${name} installed: ${check.version}`)
    } catch (error) {
      s.phase = 'failed'; s.reason = failureReason(error?.message); s.tail = String(error?.message || error).slice(-TAIL)
    }
  }
  const running = new Set()
  return {
    prefix, bin,
    // Starts the executors that are missing and not already installing or
    // installed. They run side by side (each has its own prefix).
    ensure(names = NAMES) {
      const started = []
      for (const name of names) {
        if (!NAMES.includes(name)) continue
        const s = state[name]
        if (s.phase === 'installing' || s.phase === 'queued' || s.phase === 'done') continue
        if (isInstalled(name)) { s.phase = 'present'; continue }
        s.phase = 'queued'; s.reason = ''
        started.push(name)
        const job = installOne(name).finally(() => running.delete(job))
        running.add(job)
      }
      return started
    },
    // An install cut short (the service restarted mid-way) leaves its own
    // prefix without the shared link: started again at the next service start.
    resume() {
      return this.ensure(NAMES.filter(name => fs.existsSync(path.join(prefix, 'pkg', name)) && !fs.existsSync(path.join(bin, name))))
    },
    snapshot: () => Object.fromEntries(NAMES.map(name => [name, { phase: state[name].phase, reason: state[name].reason, version: state[name].version }])),
    idle: () => Promise.all([...running]),
  }
}

module.exports = { createRunnerInstaller, toolsRoot, toolsBin, toolsBinOnPath, failureReason, NAMES }
