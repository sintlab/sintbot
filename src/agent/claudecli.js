'use strict'
// The Claude Code program on this machine: which version it is, the latest
// version, and an upgrade through the way it was installed (console, Claude
// subscription card; the same row as the Codex one in codexcli.js). Every
// Claude Code model card runs this one program (`agent.bin`), third-party
// endpoints included.
// Two ways of installing it on a Mac are recognised, each by where the file
// really is:
// - npm: the program resolves into its own npm prefix's global
//   node_modules/@anthropic-ai/claude-code and that prefix's npm sits next to
//   it. Latest = `npm view @anthropic-ai/claude-code version`; upgrade =
//   `npm i -g @anthropic-ai/claude-code@latest` with that npm (the upgrade the
//   official setup page gives for an npm install).
// - the native installer: the launcher is a link into …/claude/versions/
//   (~/.local/bin/claude → ~/.local/share/claude/versions/<version>).
//   Latest = the release channel the program follows (autoUpdatesChannel in
//   its settings: "stable", otherwise "latest"), read from the release
//   bucket the installer itself reads; upgrade = the program's own `update`.
//   A stable channel older than the installed version offers nothing, so this
//   never moves a program backwards.
// Anything else (a Homebrew cask, a copied file, a launcher of one's own) is
// left alone and reported as needing a manual upgrade. Every command is fixed
// and takes nothing from a request.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { resolveSpawn, IS_WIN } = require('./winexec')
const { maskPaths, ver, cmp } = require('./codexcli')

const PKG = '@anthropic-ai/claude-code'
const RELEASES = 'https://downloads.claude.ai/claude-code-releases/'
const CURL = fs.existsSync('/usr/bin/curl') ? '/usr/bin/curl' : 'curl'
const VERSION_MS = 8_000, LATEST_MS = 20_000, INSTALL_MS = 300_000
const NOT_FOUND = '这台机器上没找到 Claude Code 程序'
const MANUAL = '这台机器的 Claude Code 不是用 npm 或官方安装器装的，需要在机器上手动升级'

// execFile with an argument array, never a shell. npm is a script that looks
// its interpreter up on PATH, so the directory it sits in goes first. Nothing
// here answers a question: stdin is closed at once, so a prompt ends the
// command instead of holding it until the time limit.
const run = (file, args, timeoutMs) => new Promise((resolve) => {
  const { file: f, spawnArgs } = resolveSpawn(file, args)
  const env = { ...process.env, PATH: [path.dirname(file), process.env.PATH || ''].filter(Boolean).join(path.delimiter) }
  const child = execFile(f, spawnArgs, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) =>
    resolve({ ok: !err, timedOut: !!(err && err.killed), out: String(stdout || ''),
      err: String(stderr || '') + (err && !stderr ? String(err.message || '') : '') }))
  if (child && child.stdin) child.stdin.end()
})

// The claude file (an absolute path, or the first one on PATH) and how it was
// installed: { file, via: 'npm' | 'native' | '', npm }.
function locate(bin = 'claude', env = process.env) {
  let file = ''
  if (path.isAbsolute(bin)) { try { if (fs.statSync(bin).isFile()) file = bin } catch { /* not there */ } }
  else for (const d of String(env.PATH || '').split(path.delimiter)) {
    if (!d) continue
    for (const n of IS_WIN ? [bin + '.cmd', bin + '.exe', bin] : [bin]) {
      const p = path.join(d, n)
      try { if (fs.statSync(p).isFile()) { file = p; break } } catch { /* not in this directory */ }
    }
    if (file) break
  }
  if (!file) return { file: '', via: '', npm: '' }
  const dir = path.dirname(file)
  const pkgDir = IS_WIN ? path.join(dir, 'node_modules', '@anthropic-ai', 'claude-code') : path.join(path.dirname(dir), 'lib', 'node_modules', '@anthropic-ai', 'claude-code')
  let viaNpm = false
  try {
    const realPkg = fs.realpathSync(pkgDir)
    viaNpm = IS_WIN ? /\.cmd$/i.test(file) : fs.realpathSync(file).startsWith(realPkg + path.sep)
  } catch { /* no such package under this prefix */ }
  const npm = path.join(dir, IS_WIN ? 'npm.cmd' : 'npm')
  if (viaNpm && fs.existsSync(npm)) return { file, via: 'npm', npm }
  // The native installer's launcher: a link whose target sits in …/claude/versions/.
  if (!IS_WIN) {
    try {
      const versions = path.dirname(fs.realpathSync(file))
      if (fs.lstatSync(file).isSymbolicLink() && path.basename(versions) === 'versions' && path.basename(path.dirname(versions)) === 'claude') return { file, via: 'native', npm: '' }
    } catch { /* a broken link: not something to update */ }
  }
  return { file, via: '', npm: '' }
}

// The release channel a native install follows ('latest' unless its settings say 'stable').
function channelOf(env = process.env, home = os.homedir()) {
  try {
    const s = JSON.parse(fs.readFileSync(path.join(env.CLAUDE_CONFIG_DIR || path.join(home, '.claude'), 'settings.json'), 'utf8'))
    return s && s.autoUpdatesChannel === 'stable' ? 'stable' : 'latest'
  } catch { return 'latest' }
}

function createClaudeCli({ exec = run, find = locate, channel = channelOf, home = os.homedir() } = {}) {
  let busy = false
  const latestOf = async (loc) => loc.via === 'npm'
    ? ver((await exec(loc.npm, ['view', PKG, 'version'], LATEST_MS)).out)
    : ver((await exec(CURL, ['-fsSL', '--max-time', '15', RELEASES + channel()], LATEST_MS)).out)
  // { version, latest, canUpgrade, newer, why, via }. An unknown latest
  // version (offline) is '' with newer:false; nothing is guessed. `bin` is the
  // configured program (`agent.bin`).
  async function info({ bin = 'claude' } = {}) {
    const loc = find(bin || 'claude')
    if (!loc.file) return { version: '', latest: '', canUpgrade: false, newer: false, why: NOT_FOUND, via: '' }
    const version = ver((await exec(loc.file, ['--version'], VERSION_MS)).out)
    if (!loc.via) return { version, latest: '', canUpgrade: false, newer: false, why: MANUAL, via: '' }
    const latest = await latestOf(loc)
    const newer = !!(version && latest && cmp(latest, version) > 0)
    return { version, latest, canUpgrade: newer, newer, why: latest ? '' : '没查到最新版本，请检查网络后再试', via: loc.via }
  }
  // One upgrade at a time. The version is read again afterwards and that
  // reading is the result: exit code 0 does not prove a change. A failed
  // upgrade carries two texts: `error` is what a person is shown (paths
  // masked), `detail` is the command's own wording for the audit.
  async function upgrade({ bin = 'claude' } = {}) {
    if (busy) return { ok: false, error: '已经有一次升级在进行' }
    busy = true
    try {
      const loc = find(bin || 'claude')
      if (!loc.file || !loc.via) return { ok: false, error: loc.file ? MANUAL : NOT_FOUND, via: '' }
      const from = ver((await exec(loc.file, ['--version'], VERSION_MS)).out)
      const r = loc.via === 'npm' ? await exec(loc.npm, ['i', '-g', PKG + '@latest'], INSTALL_MS) : await exec(loc.file, ['update'], INSTALL_MS)
      const to = ver((await exec(find(bin || 'claude').file || loc.file, ['--version'], VERSION_MS)).out)
      const via = loc.via
      if (r.timedOut) return { ok: false, from, to, via, error: '安装没成功：超过 5 分钟没有完成，已停止' }
      if (!r.ok || !to) {
        const tail = (r.err || r.out).trim().split('\n').slice(-2).join(' ')
        if (!tail) return { ok: false, from, to, via, error: '安装没成功：升级后读不到版本' }
        return { ok: false, from, to, via, error: '安装没成功：' + maskPaths(tail, home).slice(0, 300), detail: '安装没成功：' + tail.slice(0, 300) }
      }
      return { ok: true, from, to, changed: from !== to, via }
    } finally { busy = false }
  }
  return { info, upgrade }
}

module.exports = { createClaudeCli, locate, channelOf, PKG, RELEASES }
