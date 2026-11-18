'use strict'
// The Codex program on this machine: which version it is, the latest version
// on npm, and an upgrade with the npm that installed it (console, Codex model
// card). The model list comes from the program itself, so an old one simply
// has no new models.
// The install command is fixed (`npm i -g @openai/codex@latest`) and takes
// nothing from a request. A program that is not a confirmed npm global install
// is left alone and reported as needing a manual upgrade.
const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { resolveSpawn, IS_WIN } = require('./winexec')

const PKG = '@openai/codex'
const VERSION_MS = 8_000, LATEST_MS = 20_000, INSTALL_MS = 300_000
const NOT_NPM = '这台机器的 Codex 不是用 npm 全局安装的，需要在机器上手动升级'

// execFile with an argument array, never a shell. npm is a script that looks
// its interpreter up on PATH, so the directory it sits in goes first.
const run = (file, args, timeoutMs) => new Promise((resolve) => {
  const { file: f, spawnArgs } = resolveSpawn(file, args)
  const env = { ...process.env, PATH: [path.dirname(file), process.env.PATH || ''].filter(Boolean).join(path.delimiter) }
  execFile(f, spawnArgs, { timeout: timeoutMs, windowsHide: true, maxBuffer: 4 * 1024 * 1024, env }, (err, stdout, stderr) =>
    resolve({ ok: !err, timedOut: !!(err && err.killed), out: String(stdout || ''),
      err: String(stderr || '') + (err && !stderr ? String(err.message || '') : '') }))
})
const ver = (s) => { const m = /(\d+\.\d+\.\d+)/.exec(String(s || '')); return m ? m[1] : '' }
const cmp = (a, b) => {
  const x = a.split('.').map(Number), y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) if ((x[i] || 0) !== (y[i] || 0)) return (x[i] || 0) - (y[i] || 0)
  return 0
}

// The codex file (first on PATH) and, only when it is an npm global install,
// the npm of the same prefix. Confirmed means: the file resolves into that
// prefix's own global node_modules/@openai/codex and npm sits next to it.
function locate(bin = 'codex', env = process.env) {
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
  if (!file) return { file: '', npm: '' }
  const dir = path.dirname(file)
  const pkgDir = IS_WIN ? path.join(dir, 'node_modules', '@openai', 'codex') : path.join(path.dirname(dir), 'lib', 'node_modules', '@openai', 'codex')
  let viaNpm = false
  try {
    const realPkg = fs.realpathSync(pkgDir)
    viaNpm = IS_WIN ? /\.cmd$/i.test(file) : fs.realpathSync(file).startsWith(realPkg + path.sep)
  } catch { /* no such package under this prefix */ }
  const npm = path.join(dir, IS_WIN ? 'npm.cmd' : 'npm')
  return { file, npm: viaNpm && fs.existsSync(npm) ? npm : '' }
}

function createCodexCli({ bin = 'codex', exec = run, find = locate } = {}) {
  let busy = false
  // { version, latest, canUpgrade, newer, why }. An unknown latest version
  // (offline) is '' with newer:false; nothing is guessed.
  async function info() {
    const loc = find(bin)
    if (!loc.file) return { version: '', latest: '', canUpgrade: false, newer: false, why: '这台机器上没找到 Codex 程序' }
    const version = ver((await exec(loc.file, ['--version'], VERSION_MS)).out)
    if (!loc.npm) return { version, latest: '', canUpgrade: false, newer: false, why: NOT_NPM }
    const latest = ver((await exec(loc.npm, ['view', PKG, 'version'], LATEST_MS)).out)
    const newer = !!(version && latest && cmp(latest, version) > 0)
    return { version, latest, canUpgrade: newer, newer, why: latest ? '' : '没查到最新版本，请检查网络后再试' }
  }
  // One upgrade at a time. The version is read again afterwards and that
  // reading is the result: exit code 0 of the install does not prove a change.
  async function upgrade() {
    if (busy) return { ok: false, error: '已经有一次升级在进行' }
    busy = true
    try {
      const loc = find(bin)
      if (!loc.file || !loc.npm) return { ok: false, error: NOT_NPM }
      const from = ver((await exec(loc.file, ['--version'], VERSION_MS)).out)
      const r = await exec(loc.npm, ['i', '-g', PKG + '@latest'], INSTALL_MS)
      const to = ver((await exec(find(bin).file || loc.file, ['--version'], VERSION_MS)).out)
      if (r.timedOut) return { ok: false, from, to, error: '安装没成功：超过 5 分钟没有完成，已停止' }
      if (!r.ok || !to) return { ok: false, from, to, error: '安装没成功：' + ((r.err || r.out).trim().split('\n').slice(-2).join(' ').slice(0, 300) || '升级后读不到版本') }
      return { ok: true, from, to, changed: from !== to }
    } finally { busy = false }
  }
  return { info, upgrade }
}

module.exports = { createCodexCli, locate, ver, cmp, PKG }
