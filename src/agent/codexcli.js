'use strict'
// The Codex program on this machine: which version it is, the latest version
// on npm, and an upgrade with the npm that installed it (console, Codex model
// card). The model list comes from the program itself, so an old one simply
// has no new models.
// The install command is fixed (`npm i -g @openai/codex@latest`) and takes
// nothing from a request. A program that is not a confirmed npm global install
// is left alone and reported as needing a manual upgrade.
// A model card may name its own program (`bin`). The install command only
// reaches the first `codex` on PATH, so a card whose program is not that file
// gets its version shown and no upgrade.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { resolveSpawn, IS_WIN } = require('./winexec')

const PKG = '@openai/codex'
const VERSION_MS = 8_000, LATEST_MS = 20_000, INSTALL_MS = 300_000
const NOT_NPM = '这台机器的 Codex 不是用 npm 全局安装的，需要在机器上手动升级'
const OTHER_BIN = '这张模型卡用的是另外指定的 Codex 程序，需要在机器上手动升级'
const CARD_BIN_MISSING = '没找到这张模型卡指定的 Codex 程序'

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

// What a person is shown of an install failure. npm's last lines name files
// on this machine: the home directory becomes `~`, any other absolute path
// keeps only its last part, and addresses (https://…) stay as they are.
const rx = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
function maskPaths(text, home = os.homedir()) {
  let s = String(text || '').replace(/\bfile:\/\/+/gi, '/')
  const homes = new Set([home])
  try { homes.add(fs.realpathSync(home)) } catch { /* the given one is enough */ }
  for (const h of [...homes].filter((x) => x && x.length > 1).sort((a, b) => b.length - a.length)) {
    s = s.replace(new RegExp(rx(h).replace(/\\\\/g, '[\\\\/]') + '(?![\\w.-])', /^[A-Za-z]:/.test(h) ? 'gi' : 'g'), '~')
  }
  const last = (m) => m.split(/[\\/]/).filter(Boolean).pop() || ''
  const mask = (part) => part
    .replace(/(?:\b[A-Za-z]:[\\/]|\\\\)[^\s'"`;,()<>|]+/g, (m) => '…\\' + last(m))
    .replace(/(?<![\w~.\\/])\/[^\s'"`;,()<>|:]+/g, (m) => '…/' + last(m))
  return s.split(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s'"<>]+)/i).map((part, i) => (i % 2 ? part : mask(part))).join('')
}

// Two names for one program (a link and its target count as the same).
const sameFile = (a, b) => { try { return fs.realpathSync(a) === fs.realpathSync(b) } catch { return a === b } }

function createCodexCli({ bin = 'codex', exec = run, find = locate, home = os.homedir() } = {}) {
  let busy = false
  // The card's own program when it is not the one this module upgrades:
  // null = the card runs the PATH program; otherwise { file } ('' = not found).
  const other = (cardBin) => {
    if (!cardBin || typeof cardBin !== 'string' || cardBin === bin) return null
    const mine = find(bin).file, theirs = find(cardBin).file
    return mine && theirs && sameFile(mine, theirs) ? null : { file: theirs }
  }
  // { version, latest, canUpgrade, newer, why }. An unknown latest version
  // (offline) is '' with newer:false; nothing is guessed. `cardBin` is the
  // `bin` of the model card the row is drawn for ('' = none).
  async function info({ cardBin = '' } = {}) {
    const card = other(cardBin)
    if (card) {
      const version = card.file ? ver((await exec(card.file, ['--version'], VERSION_MS)).out) : ''
      return { version, latest: '', canUpgrade: false, newer: false, why: card.file ? OTHER_BIN : CARD_BIN_MISSING }
    }
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
  // A failed install carries two texts: `error` is what a person is shown
  // (paths masked), `detail` is npm's own wording for the audit.
  async function upgrade({ cardBin = '' } = {}) {
    if (other(cardBin)) return { ok: false, refused: true, error: OTHER_BIN }
    if (busy) return { ok: false, error: '已经有一次升级在进行' }
    busy = true
    try {
      const loc = find(bin)
      if (!loc.file || !loc.npm) return { ok: false, error: NOT_NPM }
      const from = ver((await exec(loc.file, ['--version'], VERSION_MS)).out)
      const r = await exec(loc.npm, ['i', '-g', PKG + '@latest'], INSTALL_MS)
      const to = ver((await exec(find(bin).file || loc.file, ['--version'], VERSION_MS)).out)
      if (r.timedOut) return { ok: false, from, to, error: '安装没成功：超过 5 分钟没有完成，已停止' }
      if (!r.ok || !to) {
        const tail = (r.err || r.out).trim().split('\n').slice(-2).join(' ')
        if (!tail) return { ok: false, from, to, error: '安装没成功：升级后读不到版本' }
        return { ok: false, from, to, error: '安装没成功：' + maskPaths(tail, home).slice(0, 300), detail: '安装没成功：' + tail.slice(0, 300) }
      }
      return { ok: true, from, to, changed: from !== to }
    } finally { busy = false }
  }
  return { info, upgrade }
}

module.exports = { createCodexCli, locate, maskPaths, ver, cmp, PKG }
