// Stable-version checks and guarded in-place upgrades for the global package.
// Checking is read-only. Installation is explicit, exact-version only, waits for
// every group queue to drain, and never escalates privileges.

const fs = require('node:fs')
const path = require('node:path')
const { execFile } = require('node:child_process')
const { promisify } = require('node:util')
const { atomicWriteJSON } = require('./core/store')

const execFileAsync = promisify(execFile)
const PACKAGE = 'sintbot'
const REGISTRIES = [
  { url: 'https://registry.npmjs.org/sintbot/latest', source: 'npm' },
  { url: 'https://registry.npmmirror.com/sintbot/latest', source: 'mirror' },
]
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000
const CHECK_TIMEOUT_MS = 10_000
const QUEUE_TIMEOUT_MS = 24 * 60 * 60 * 1000

function stableVersion(value) {
  const s = String(value || '').trim().replace(/^v/, '')
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(s) ? s : null
}

function compareVersion(a, b) {
  const av = stableVersion(a); const bv = stableVersion(b)
  if (!av || !bv) return 0
  const aa = av.split('.').map(BigInt); const bb = bv.split('.').map(BigInt)
  for (let i = 0; i < 3; i++) if (aa[i] !== bb[i]) return aa[i] > bb[i] ? 1 : -1
  return 0
}

function hasPendingWork(live) {
  // Updating while the engine is missing or its snapshot is incomplete is unsafe:
  // a busy group could be hidden by a failed state read. Treat unknown as busy.
  if (!live || live.running !== true || !Number.isFinite(Number(live.queue)) || !live.groups || typeof live.groups !== 'object') return true
  if (Number(live.queue) > 0) return true
  return Object.values(live.groups).some((g) => !g || g.busy || !Number.isFinite(Number(g.queue)) || Number(g.queue) > 0)
}

async function fetchVersion({ fetchImpl = globalThis.fetch, url, timeoutMs = CHECK_TIMEOUT_MS } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const res = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: ac.signal, redirect: 'error' })
    if (!res || !res.ok) throw new Error(`HTTP ${res && res.status || 'error'}`)
    const data = await res.json()
    const version = stableVersion(data && (data.version || (data['dist-tags'] && data['dist-tags'].latest)))
    if (!version) throw new Error('registry returned no stable version')
    return version
  } finally { clearTimeout(timer) }
}

function readState(file) {
  try {
    const v = JSON.parse(fs.readFileSync(file, 'utf8'))
    return v && typeof v === 'object' ? v : {}
  } catch { return {} }
}

function createUpdater({
  currentVersion,
  stateFile,
  getLiveState = () => null,
  fetchImpl = globalThis.fetch,
  registries = REGISTRIES,
  now = Date.now,
  waitMs = 5000,
  queueTimeoutMs = QUEUE_TIMEOUT_MS,
  checkIntervalMs = CHECK_INTERVAL_MS,
  isGlobalInstall = defaultGlobalInstall,
  installExact = defaultInstallExact,
  readInstalledVersion = defaultReadInstalledVersion,
  getManagedService = () => false,
  restartManagedService = async () => ({ ok: false }),
  setAnnouncementBaseline = () => {},
  log = () => {},
} = {}) {
  const file = stateFile || path.join(require('node:os').homedir(), '.sbot', 'update.json')
  const current = stableVersion(currentVersion) || '0.0.0'
  let data = readState(file)
  let queueTimer = null
  let checking = null
  let closed = false

  // If a previous daemon was replaced during the restart step, the new package
  // version is the evidence that installation and restart both completed.
  if (data.job && data.job.state === 'restarting') {
    data.job = data.job.to === current
      ? { ...data.job, state: 'done', message: '更新完成并已重启', updatedAt: now() }
      : { ...data.job, state: 'failed', message: '更新后未能自动重启，请手动重启服务', updatedAt: now() }
    persist()
  }

  function persist() { try { atomicWriteJSON(file, data, { mode: 0o600 }) } catch (e) { log('update state: ' + (e && e.message)) } }
  function status() {
    const latest = stableVersion(data.latestVersion)
    return {
      currentVersion: current,
      latestVersion: latest,
      checkedAt: Number(data.checkedAt) || null,
      source: data.source || '',
      ignoredVersion: data.ignoredVersion || '',
      available: !!latest && compareVersion(latest, current) > 0 && data.ignoredVersion !== latest,
      job: data.job ? { ...data.job } : null,
    }
  }

  async function check() {
    if (closed) return status()
    if (checking) return checking
    checking = (async () => {
      let lastError = null
      for (const r of registries) {
        try {
          const version = await fetchVersion({ fetchImpl, url: r.url })
          data.latestVersion = version
          data.checkedAt = now()
          data.source = r.source || ''
          if (data.ignoredVersion && data.ignoredVersion !== version) data.ignoredVersion = ''
          persist()
          return status()
        } catch (e) { lastError = e }
      }
      // Network errors are deliberately quiet and never erase the last success.
      if (lastError) log('update check unavailable: ' + (lastError && lastError.message || 'network error'))
      return status()
    })().finally(() => { checking = null })
    return checking
  }

  function ignore(version) {
    const v = stableVersion(version)
    if (!v || v !== stableVersion(data.latestVersion)) throw new Error('只能忽略当前检测到的版本')
    data.ignoredVersion = v
    persist()
    return status()
  }

  function startUpgrade({ version, announce = true } = {}) {
    const v = stableVersion(version)
    if (!v || v !== stableVersion(data.latestVersion) || compareVersion(v, current) <= 0) throw new Error('版本信息已变化，请先重新检查')
    if (data.job && ['queued', 'installing', 'restarting', 'restart-needed'].includes(data.job.state)) throw new Error('已有更新需要完成或重启后再试')
    data.job = { id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, state: 'queued', from: current, to: v,
      announce: announce !== false, createdAt: now(), updatedAt: now(), message: '等待所有群任务结束后更新' }
    persist()
    void processQueue()
    return status()
  }

  function scheduleQueueCheck() {
    if (closed || queueTimer || !data.job || data.job.state !== 'queued') return
    queueTimer = setTimeout(() => { queueTimer = null; void processQueue() }, waitMs)
    if (queueTimer.unref) queueTimer.unref()
  }

  async function processQueue() {
    const job = data.job
    if (closed || !job || job.state !== 'queued') return
    if (now() - job.createdAt > queueTimeoutMs) {
      data.job = { ...job, state: 'failed', message: '等待群任务结束超时；可在任务空闲后重新发起', updatedAt: now() }
      persist(); return
    }
    let live
    try { live = getLiveState() }
    catch (e) { log('update queue: live state unavailable: ' + (e && e.message)); return scheduleQueueCheck() }
    if (hasPendingWork(live)) return scheduleQueueCheck()
    if (queueTimer) { clearInterval(queueTimer); queueTimer = null }
    data.job = { ...job, state: 'installing', message: '正在检查安装位置并安装指定版本', updatedAt: now() }
    persist()
    try {
      const checkResult = await isGlobalInstall()
      if (!checkResult || !checkResult.ok) throw new Error((checkResult && checkResult.reason) || '当前运行位置不是可写的全局安装')
      const result = await installExact(PACKAGE, job.to, checkResult)
      if (!result || result.ok === false) throw new Error((result && result.reason) || '安装失败；检查包管理器日志后可手动重试')
      const installed = await readInstalledVersion(checkResult)
      if (stableVersion(installed) !== job.to) throw new Error('安装完成后的版本核对不符；请手动检查后重启')
      if (!job.announce) { try { setAnnouncementBaseline(job.to) } catch (e) { log('update announcement baseline: ' + (e && e.message)) } }
      const managed = await getManagedService()
      if (managed) {
        data.job = { ...job, state: 'restarting', message: '已安装，正在重启后台服务', updatedAt: now() }
        persist()
        const restarted = await restartManagedService()
        if (restarted && restarted.ok) return status()
        data.job = { ...job, state: 'restart-needed', message: '已安装新版；后台服务未能自动重启，请手动重启', updatedAt: now() }
      } else {
        data.job = { ...job, state: 'restart-needed', message: '已安装新版；当前不是受托管服务，请手动重启 SintBot', updatedAt: now() }
      }
      persist()
    } catch (e) {
      data.job = { ...job, state: 'failed', message: String(e && e.message || e).slice(0, 300), updatedAt: now() }
      persist()
    }
    return status()
  }

  if (data.job && data.job.state === 'queued') void processQueue()
  const checkTimer = setInterval(() => { void check() }, checkIntervalMs)
  if (checkTimer.unref) checkTimer.unref()

  return {
    status,
    check,
    ignore,
    startUpgrade,
    start() { return check() },
    close() { closed = true; clearInterval(checkTimer); if (queueTimer) clearTimeout(queueTimer); queueTimer = null },
  }
}

function defaultGlobalInstall() {
  const { execFileSync } = require('node:child_process')
  const rootOut = execFileSync('npm', ['root', '-g'], { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const globalRoot = fs.realpathSync(rootOut)
  const globalPackage = path.join(globalRoot, PACKAGE)
  const runningPackage = fs.realpathSync(path.resolve(__dirname, '..'))
  if (runningPackage !== fs.realpathSync(globalPackage)) return { ok: false, reason: '当前运行的是开发目录或非全局副本；请在终端手动更新' }
  fs.accessSync(globalRoot, fs.constants.W_OK | fs.constants.X_OK)
  fs.accessSync(path.dirname(globalPackage), fs.constants.W_OK | fs.constants.X_OK)
  return { ok: true, globalRoot, globalPackage }
}

async function defaultInstallExact(name, version) {
  const env = {}
  const allowed = ['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'TEMP', 'TMP', 'SystemRoot', 'PATHEXT',
    'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'no_proxy', 'LANG', 'LC_ALL']
  for (const k of allowed) if (process.env[k] !== undefined) env[k] = process.env[k]
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm'
  try {
    await execFileAsync(npm, ['install', '--global', `${name}@${version}`, '--omit=dev', '--no-audit', '--no-fund'],
      { timeout: 10 * 60 * 1000, maxBuffer: 2 * 1024 * 1024, windowsHide: true, env })
    return { ok: true }
  } catch (e) {
    return { ok: false, reason: `安装失败(退出码 ${e && e.code != null ? e.code : '未知'})；未提权，也未改用其他版本` }
  }
}

function defaultReadInstalledVersion(info) {
  try { return JSON.parse(fs.readFileSync(path.join(info.globalPackage, 'package.json'), 'utf8')).version || null } catch { return null }
}

module.exports = { PACKAGE, REGISTRIES, CHECK_INTERVAL_MS, stableVersion, compareVersion, hasPendingWork, fetchVersion, createUpdater, defaultGlobalInstall, defaultInstallExact, defaultReadInstalledVersion }
