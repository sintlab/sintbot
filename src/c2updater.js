'use strict'

// Software updates for the multi-group service. Checking is read-only. Only a
// launchd-managed installation upgrades from the console, and only while every
// group is idle and settled: the exact stable version is installed side by
// side under the releases directory, then a detached switch process replaces
// the service entry with the same steps as the deploy scripts and rolls back
// on any failure. Foreground and development installations get instructions.
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, execFileSync, spawn } = require('node:child_process')
const { promisify } = require('node:util')
const { createHash } = require('node:crypto')
const { stableVersion, compareVersion, fetchVersion, CHECK_INTERVAL_MS } = require('./updater')
const { atomicWriteJSON } = require('./core/store')

const PACKAGE = 'sintbot'
const REGISTRIES = Object.freeze([
  { registry: 'https://registry.npmjs.org', source: 'npm' },
  { registry: 'https://registry.npmmirror.com', source: 'mirror' },
])
const QUEUE_TIMEOUT_MS = 24 * 60 * 60 * 1000
const ACTIVE = Object.freeze(['queued', 'installing', 'switching'])
const LABEL = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/
const execFileAsync = promisify(execFile)

function readJSON(file) {
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value === 'object' ? value : {}
  } catch { return {} }
}

function readPlist(file, { exec = execFileSync } = {}) {
  return JSON.parse(exec('/usr/bin/plutil', ['-convert', 'json', '-o', '-', file],
    { encoding: 'utf8', timeout: 10_000 }))
}

const real = file => { try { return fs.realpathSync(file) } catch { return null } }

// launchd names its job in XPC_SERVICE_NAME. The job counts as managing this
// process only when its plist starts this exact entry and launchd reports this
// exact PID; anything else is a foreground run.
function detectRunMode({ privateBuild, entry, env = process.env, pid = process.pid,
  uid = process.getuid?.(), home = os.homedir(), exec = execFileSync } = {}) {
  if (privateBuild === true) return Object.freeze({ mode: 'dev' })
  const label = env.XPC_SERVICE_NAME
  if (typeof label !== 'string' || !LABEL.test(label) || label === '0') {
    return Object.freeze({ mode: 'foreground' })
  }
  const plist = path.join(home, 'Library', 'LaunchAgents', `${label}.plist`)
  try {
    const spec = readPlist(plist, { exec })
    const args = spec.ProgramArguments
    if (spec.Label !== label || !Array.isArray(args) || args.length < 3 ||
        !args.every(arg => typeof arg === 'string') ||
        real(args[1]) === null || real(args[1]) !== real(entry)) {
      return Object.freeze({ mode: 'foreground', reason: 'launchd entry differs' })
    }
    const printed = exec('/bin/launchctl', ['print', `gui/${uid}/${label}`],
      { encoding: 'utf8', timeout: 10_000 })
    if (!new RegExp(`^\\s*pid = ${pid}\\s*$`, 'm').test(printed)) {
      return Object.freeze({ mode: 'foreground', reason: 'launchd pid differs' })
    }
    return Object.freeze({ mode: 'managed', label, plist, entry: args[1],
      logFile: typeof spec.StandardErrorPath === 'string' ? spec.StandardErrorPath : null })
  } catch {
    return Object.freeze({ mode: 'foreground', reason: 'launchd job unreadable' })
  }
}

// launchd refuses to load a disabled job ("Bootstrap failed: 5"). The switch
// unloads and reloads the job, and its rollback reloads it the same way, so on
// a disabled job an upgrade would leave the service stopped. A job that is
// running while disabled is still found here; an unreadable list is not
// treated as disabled, which keeps the earlier behaviour.
function parseDisabled(printed, label) {
  if (typeof printed !== 'string' || typeof label !== 'string' || !LABEL.test(label)) return false
  const quoted = label.replace(/[.\-]/g, '\\$&')
  const match = new RegExp(`^\\s*"${quoted}"\\s*=>\\s*(\\S+)\\s*$`, 'm').exec(printed)
  return !!match && (match[1] === 'disabled' || match[1] === 'true')
}
function jobDisabled({ label, uid = process.getuid?.(), exec = execFileSync } = {}) {
  try {
    return parseDisabled(exec('/bin/launchctl', ['print-disabled', `gui/${uid}`],
      { encoding: 'utf8', timeout: 10_000 }), label)
  } catch { return false }
}
const JOB_DISABLED = '后台服务已在系统里被停用；升级要重新载入它，现在升级会让服务停下。请先在系统设置的登录项里重新允许它，再升级'

function registriesFromEnv(env = process.env) {
  const custom = env.SINTBOT_UPDATE_REGISTRY
  if (custom === undefined || custom === '') return REGISTRIES
  const url = new URL(custom)
  if (!['http:', 'https:'].includes(url.protocol)) throw new Error('SINTBOT_UPDATE_REGISTRY must be an http(s) URL')
  return Object.freeze([{ registry: url.href.replace(/\/$/, ''), source: 'custom' }])
}

function defaultReleasesRoot(env = process.env, home = os.homedir()) {
  const dir = env.SINTBOT_RELEASES_DIR
  if (dir !== undefined && dir !== '') {
    if (!path.isAbsolute(dir) || path.resolve(dir) !== dir) throw new Error('SINTBOT_RELEASES_DIR must be a normalized absolute path')
    return dir
  }
  return path.join(home, '.local', 'share', 'sintbot', 'releases')
}

const entryOf = prefix => path.join(prefix, 'lib', 'node_modules', PACKAGE, 'bin', 'sintbot-v2.js')

function npmBin() {
  const sibling = path.join(path.dirname(process.execPath), 'npm')
  return fs.existsSync(sibling) ? sibling : 'npm'
}

async function defaultInstallVersion({ version, prefix, registry }) {
  const env = {}
  for (const key of ['PATH', 'HOME', 'USER', 'TMPDIR', 'HTTP_PROXY', 'HTTPS_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'no_proxy', 'LANG', 'LC_ALL']) {
    if (process.env[key] !== undefined) env[key] = process.env[key]
  }
  try {
    await execFileAsync(npmBin(), ['install', '--global', '--prefix', prefix, `--registry=${registry}`,
      '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', `${PACKAGE}@${version}`],
    { timeout: 10 * 60_000, maxBuffer: 4 * 1024 * 1024, env })
  } catch (error) {
    throw new Error(`安装 v${version} 失败（退出码 ${error?.code ?? '未知'}）；没有提权，也没有改用其他版本`)
  }
}

// The same verification as the public installer, in a child process so the
// service never loads modules of another version.
function defaultVerifyInstall({ version, prefix }) {
  const root = path.join(prefix, 'lib', 'node_modules', PACKAGE)
  // Only literal requires in this file: the package builder rejects computed ones.
  const script = `
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const root = process.argv[1];
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  if (pkg.name !== 'sintbot' || pkg.version !== process.argv[2] || pkg.private === true ||
      pkg.bin?.sintbot !== 'bin/sintbot-v2.js') throw new Error('package identity differs');
  await import(pathToFileURL(path.join(root, 'src/agent/privatecore.js')).href);
  await import(pathToFileURL(path.join(root, 'src/platform/feishu.js')).href);
})().catch(() => process.exit(1));`
  try {
    execFileSync(process.execPath, ['-e', script, root, version], { timeout: 60_000, stdio: 'ignore', cwd: '/' })
    const reported = execFileSync(process.execPath, [entryOf(prefix), 'version'],
      { encoding: 'utf8', timeout: 30_000, cwd: '/' }).trim()
    if (reported !== version) throw new Error('version differs')
  } catch {
    throw new Error(`v${version} 安装后的核对没有通过；新目录保留在 ${prefix}，服务没有切换`)
  }
}

function defaultSpawnSwitch({ entry, stateFile }) {
  const child = spawn(process.execPath, [entry, 'upgrade-switch', '--state', stateFile],
    { detached: true, stdio: 'ignore', cwd: '/', env: process.env })
  child.unref()
  return child.pid
}

function journalHashes(dataDir) {
  const out = {}
  for (const name of fs.readdirSync(dataDir).filter(name => /^c2-v2.*\.log$/.test(name)).sort()) {
    out[name] = createHash('sha256').update(fs.readFileSync(path.join(dataDir, name))).digest('hex')
  }
  return out
}

function alive(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) return false
  try { process.kill(pid, 0); return true } catch (error) { return error.code === 'EPERM' }
}

function createC2Updater({ currentVersion, runMode, stateFile, dataDir, configPath,
  gate, beginMaintenance = () => {}, endMaintenance = () => {}, expectedGroups = () => 0,
  registries = REGISTRIES, fetchImpl = globalThis.fetch, releasesRoot = defaultReleasesRoot(),
  installVersion = defaultInstallVersion, verifyInstall = defaultVerifyInstall,
  spawnSwitch = defaultSpawnSwitch, hashJournals = journalHashes, isAlive = alive,
  isJobDisabled = label => jobDisabled({ label }),
  now = Date.now, waitMs = 5_000, queueTimeoutMs = QUEUE_TIMEOUT_MS,
  checkIntervalMs = CHECK_INTERVAL_MS, autoCheck = true, setAnnouncementBaseline = null,
  log = () => {} } = {}) {
  if (typeof currentVersion !== 'string' || !runMode || typeof runMode.mode !== 'string' ||
      typeof stateFile !== 'string' || !path.isAbsolute(stateFile) || typeof gate !== 'function') {
    throw new TypeError('C2 updater needs the version, run mode, state file and idle gate')
  }
  if (setAnnouncementBaseline !== null && typeof setAnnouncementBaseline !== 'function') {
    throw new TypeError('C2 updater announcement baseline must be a function')
  }
  // The new version announces itself in the groups on its first start; an
  // upgrade started without announcement records the target version as the
  // baseline first, so that start finds nothing new.
  function baseline(version) {
    try { setAnnouncementBaseline(version); return true } catch (error) {
      log(`update announcement baseline: ${error?.message || String(error)}`)
      return false
    }
  }
  const current = stableVersion(currentVersion)
  let data = readJSON(stateFile)
  let timer = null
  let checking = null
  let closed = false

  function persist() {
    try { atomicWriteJSON(stateFile, data, { mode: 0o600 }) } catch (error) { log(`update state: ${error.message}`) }
  }
  function setJob(patch, message) {
    data.job = { ...data.job, ...patch, ...(message ? { message } : {}), updatedAt: now() }
    persist()
    return data.job
  }
  function fail(message) {
    setJob({ state: 'failed' }, String(message).slice(0, 300))
    return status()
  }

  // A switch that this process did not finish is settled from the evidence:
  // the new version reached here, the switch process is still working, or it
  // stopped without writing a result.
  if (data.job?.state === 'switching' && data.job.to !== current && !isAlive(data.job.helperPid)) {
    fail('切换过程中断，现场已保留；请检查后重新发起')
  } else if (data.job?.state === 'installing') {
    fail('安装被中断，可重新发起升级')
  }

  // The switch process writes this file too; always act on its latest bytes.
  function refresh() { data = readJSON(stateFile) }
  function status() {
    refresh()
    const latest = stableVersion(data.latestVersion)
    const upgradeSupported = runMode.mode === 'managed'
    return {
      currentVersion, latestVersion: latest, checkedAt: Number(data.checkedAt) || null,
      source: data.source || '', ignoredVersion: data.ignoredVersion || '',
      available: !!current && !!latest && compareVersion(latest, current) > 0 && data.ignoredVersion !== latest,
      mode: runMode.mode, upgradeSupported, announceSupported: !!setAnnouncementBaseline,
      job: data.job ? { ...data.job } : null,
    }
  }

  async function check() {
    if (closed) return status()
    if (checking) return checking
    checking = (async () => {
      let lastError = null
      for (const item of registries) {
        try {
          const version = await fetchVersion({ fetchImpl, url: `${item.registry}/${PACKAGE}/latest` })
          refresh()
          data.latestVersion = version
          data.checkedAt = now()
          data.source = item.source
          data.registry = item.registry
          if (data.ignoredVersion && data.ignoredVersion !== version) data.ignoredVersion = ''
          persist()
          return status()
        } catch (error) { lastError = error }
      }
      if (lastError) log(`update check unavailable: ${lastError.message || 'network error'}`)
      return status()
    })().finally(() => { checking = null })
    return checking
  }

  function ignore(version) {
    refresh()
    const v = stableVersion(version)
    if (!v || v !== stableVersion(data.latestVersion)) throw new Error('只能忽略当前检测到的版本')
    data.ignoredVersion = v
    persist()
    return status()
  }

  function startUpgrade({ version, announce = true } = {}) {
    refresh()
    if (runMode.mode !== 'managed') {
      throw new Error(runMode.mode === 'dev' ? '开发版请用部署脚本升级' : '前台运行请按卡片上的步骤升级')
    }
    const v = stableVersion(version)
    if (!current || !v || v !== stableVersion(data.latestVersion) || compareVersion(v, current) <= 0) {
      throw new Error('版本信息已变化，请先重新检查')
    }
    if (data.job && ACTIVE.includes(data.job.state)) throw new Error('已有升级正在进行')
    if (gate().includes('held')) throw new Error('有暂停的群，先处理后再升级')
    if (isJobDisabled(runMode.label)) throw new Error(JOB_DISABLED)
    data.job = { id: `${now()}-${Math.random().toString(36).slice(2, 8)}`, state: 'queued',
      from: current, to: v, registry: data.registry || registries[0].registry,
      announce: announce !== false,
      createdAt: now(), updatedAt: now(), message: '等所有群空闲、记录结清后升级' }
    persist()
    schedule(0)
    return status()
  }

  function schedule(ms = waitMs) {
    if (closed || timer || data.job?.state !== 'queued') return
    timer = setTimeout(() => { timer = null; void processQueue() }, ms)
    timer.unref?.()
  }

  async function processQueue() {
    const job = data.job
    if (closed || job?.state !== 'queued') return status()
    if (now() - job.createdAt > queueTimeoutMs) return fail('等待群空闲超时；可在空闲后重新发起')
    const blocked = gate()
    if (blocked.includes('held')) return fail('有暂停的群，升级已取消；先处理暂停的群')
    if (blocked.length) { schedule(); return status() }
    let prefix = job.installed ? job.prefix : path.join(releasesRoot, job.to)
    if (!job.installed) {
      setJob({ state: 'installing', prefix }, `正在安装 v${job.to}`)
      try {
        let reusable = false
        if (fs.existsSync(prefix)) {
          // Never repair an existing tree in place: another process may still
          // use it. A failed check leaves it intact as evidence.
          try { await verifyInstall({ version: job.to, prefix }); reusable = true }
          catch { /* retry in an independent installation directory */ }
        }
        if (!reusable) {
          fs.mkdirSync(releasesRoot, { recursive: true, mode: 0o700 })
          // The directory becomes eligible for switching only after validation.
          // Keeping its unique path also avoids overwriting a concurrently
          // installed or running release when a download is retried.
          prefix = fs.mkdtempSync(path.join(releasesRoot, `${job.to}-`))
          setJob({ prefix })
          await installVersion({ version: job.to, prefix, registry: job.registry })
          await verifyInstall({ version: job.to, prefix })
        }
      } catch (error) { return fail(error.message) }
      if (closed) return status()
      setJob({ state: 'queued', installed: true }, `v${job.to} 已安装，等所有群空闲后切换`)
    }
    // Close admission first, then prove idleness once more: nothing can start
    // between this check and the switch process stopping the service.
    if (gate().length) { schedule(); return status() }
    // The job can be disabled while the upgrade waited or installed.
    if (isJobDisabled(runMode.label)) return fail(JOB_DISABLED)
    beginMaintenance()
    const settled = gate()
    if (settled.length) { endMaintenance(); schedule(); return status() }
    let hashes
    try { hashes = hashJournals(dataDir) } catch (error) { endMaintenance(); return fail(`无法读取群记录：${error.message}`) }
    const silent = job.announce === false && !!setAnnouncementBaseline && baseline(job.to)
    setJob({ state: 'switching', oldEntry: runMode.entry, newEntry: entryOf(prefix), label: runMode.label,
      plist: runMode.plist, logFile: runMode.logFile, dataDir, configPath,
      expectedGroups: expectedGroups(), journals: hashes, servicePid: process.pid,
      backupDir: path.join(dataDir, 'upgrades', new Date(now()).toISOString().replace(/[:.]/g, '-')),
      steps: [] }, `正在切换到 v${job.to}；期间的消息会提示稍后重发`)
    try {
      const pid = spawnSwitch({ entry: runMode.entry, stateFile })
      setJob({ helperPid: pid })
    } catch (error) {
      // This version keeps running: its own start recorded it as the baseline.
      if (silent) baseline(currentVersion)
      endMaintenance()
      return fail(`切换进程没有启动：${error.message}`)
    }
    return status()
  }

  // The new version marks the switch done only after every group connected.
  function confirmStarted() {
    refresh()
    if (data.job?.state === 'switching' && data.job.to === current) {
      setJob({ state: 'done', finishedAt: now() }, `已升级到 v${current}`)
    }
    return status()
  }

  if (data.job?.state === 'queued') schedule(0)
  const checkTimer = autoCheck ? setInterval(() => { void check() }, checkIntervalMs) : null
  checkTimer?.unref?.()
  return { status, check, ignore, startUpgrade, processQueue, confirmStarted,
    start() { return autoCheck ? check() : Promise.resolve(status()) },
    close() { closed = true; if (checkTimer) clearInterval(checkTimer); if (timer) clearTimeout(timer); timer = null } }
}

// What keeps a console upgrade from starting: 'not-serving', 'held', 'busy'
// or 'unsettled'. The updater's own maintenance flag never blocks it, so the
// final check after admission closes can pass.
function createC2UpgradeGate({ isRunning, service, capacity, assertJournalScope }) {
  return () => {
    const reasons = new Set()
    const live = service()
    if (!isRunning() || !live) return ['not-serving']
    if (live.held.size) reasons.add('held')
    const shared = capacity.snapshot()
    if (shared.closed) reasons.add('not-serving')
    if (shared.active || shared.waiting) reasons.add('busy')
    for (const [chatId, binding] of live.bindings) {
      if (binding.gate.blocked) reasons.add('not-serving')
      for (const rt of binding.engine.rts.values()) {
        if (rt.v2NormalRouteActive || rt.v2AdmissionPending || rt.v2Controller ||
            rt.v2QueueReceiptIds?.length) reasons.add('busy')
      }
      try { assertJournalScope(binding.journal, chatId, { requireSettled: true }) }
      catch { reasons.add('unsettled') }
    }
    return [...reasons]
  }
}

module.exports = { createC2Updater, createC2UpgradeGate, detectRunMode, parseDisabled, jobDisabled, registriesFromEnv, defaultReleasesRoot,
  entryOf, journalHashes, readPlist, defaultVerifyInstall, REGISTRIES, PACKAGE }
