'use strict'

// `sintbot connect`: Feishu scan onboarding. The binary core decides every step
// and every sentence shown for it (connect_manifest / connect_plan /
// connect_config / qr_matrix); this file only performs I/O in the order the
// plan fixes: scan → token → app → precheck → scope → publish → dir → chat →
// config → init. Every network, file system and process dependency is
// injectable so the flow can run end to end without a Feishu account.
const nodeFs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const readline = require('node:readline')
const { parseArgs } = require('node:util')
const core = require('./agent/privatecore')
const { atomicWriteJSON } = require('./core/store')
const { installationStateDir, MANIFEST } = require('./c2install')
const { defaultProjectsRoot, tooWideReason, realpathLenient } = require('./projectsroot')

const CONNECT_OPTIONS = Object.freeze({
  config: { type: 'string' }, 'data-dir': { type: 'string' }, workdir: { type: 'string' },
  name: { type: 'string' }, provider: { type: 'string' }, 'app-id': { type: 'string' },
  chat: { type: 'string' }, basic: { type: 'boolean' }, 'no-open': { type: 'boolean' },
})
const APP_ID = /^cli_[A-Za-z0-9]{6,64}$/
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,124}$/
const PROJECT_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,59}$/u
const RUNNERS = Object.freeze(['codex', 'claude'])
// Files whose presence means the data directory is not fresh; the same list
// initializeInstallation refuses later, checked here before a scan is spent.
const STATE_FILES = Object.freeze(['state.json', 'pending-turns.json', 'engine-receipts.json', MANIFEST, 'daemon.lock'])
// The core keys a step failure on a Feishu code or HTTP status. A local
// failure (file system, missing chat id) has neither; it is reported as code 1.
const LOCAL_FAILURE = 1
const PUBLISH_POLL_MS = 30_000
const PUBLISH_POLL_STEP_MS = 3_000
const EXIT_INTERRUPTED = 130

function defaultDeps(deps) {
  const feishu = deps.feishu || require('./platform/feishu')
  return {
    registerApp: options => require('@larksuiteoapi/node-sdk').registerApp(options),
    feishuClient: feishu.feishuClient,
    feishu,
    initializeInstallation: (file, options) => require('./c2install').initializeInstallation(file, options),
    spawn: require('node:child_process').spawn,
    spawnSync: require('node:child_process').spawnSync,
    fs: nodeFs,
    now: Date.now,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    stdout: process.stdout,
    stderr: process.stderr,
    env: process.env,
    home: os.homedir(),
    tmpdir: os.tmpdir(),
    userName: localUserName(),
    isTTY: !!(process.stdin.isTTY && process.stderr.isTTY),
    prompt: null,
    signals: process,
    version: require('../package.json').version,
    ...deps,
  }
}

function localUserName() {
  try { return os.userInfo().username || '' } catch { return '' }
}

function askLine(question, fallback, { stderr }) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: stderr })
    rl.question(question, answer => { rl.close(); resolve(answer.trim() || fallback) })
  })
}

// Feishu failures arrive as an axios error (body under response.data), as an
// SDK result whose code is not 0, as the SDK's own token Error ("failed to get
// tenant_access_token, code: 21001, msg: …") or as a local Error. The core
// wants { status, code, msg }; no code and no status means the step succeeded.
function failureInput(error, larkErrMsg) {
  const data = error?.response?.data
  let code = Number.isInteger(data?.code) ? data.code
    : Number.isInteger(error?.code) ? error.code : null
  const status = Number.isInteger(error?.response?.status) ? error.response.status : null
  if (code === null && status === null) {
    const inMessage = /\bcode:\s*(\d+)/.exec(error?.message || '')
    code = inMessage ? Number(inMessage[1]) : LOCAL_FAILURE
  }
  return { status, code, msg: larkErrMsg(error) }
}

function assertOk(result, what) {
  if (result && typeof result === 'object' && Number.isInteger(result.code) && result.code !== 0) {
    const error = new Error(`${what} failed: ${result.msg || result.message || 'code ' + result.code}`)
    error.response = { data: result }
    throw error
  }
  return result
}

// The SDK carries scopes, events and callbacks in nested buckets; the core's
// flat lists are tenant-identity items.
function sdkAddons(addons) {
  const out = { preset: addons.preset === true }
  if (addons.scopes.length) out.scopes = { tenant: addons.scopes }
  if (addons.events.length) out.events = { items: { tenant: addons.events } }
  if (addons.callbacks.length) out.callbacks = { items: addons.callbacks }
  return out
}

const escapeHtml = text => String(text).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch])
const shellQuote = text => "'" + String(text).replace(/'/g, "'\\''") + "'"

// One SVG rect per run of dark modules, quiet zone 4 modules, about 360px.
function qrPage(url) {
  const matrix = core.qrMatrix(url)
  const quiet = 4
  const total = matrix.size + quiet * 2
  const rects = []
  matrix.rows.forEach((row, y) => {
    let x = 0
    while (x < row.length) {
      if (row[x] !== '1') { x++; continue }
      let run = 1
      while (row[x + run] === '1') run++
      rects.push(`<rect x="${x + quiet}" y="${y + quiet}" width="${run}" height="1"/>`)
      x += run
    }
  })
  return `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>SintBot · Feishu</title>
<style>body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;font:14px/1.5 -apple-system,system-ui,sans-serif;background:#fff;color:#222}
svg{width:360px;height:360px;shape-rendering:crispEdges}p{max-width:560px;word-break:break-all;text-align:center;padding:0 16px}</style></head>
<body><svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${total} ${total}"><rect width="${total}" height="${total}" fill="#fff"/><g fill="#000">${rects.join('')}</g></svg>
<p><a href="${escapeHtml(url)}">${escapeHtml(url)}</a></p></body></html>
`
}

function readExistingConfig(fs, file) {
  let text
  try { text = fs.readFileSync(file, 'utf8') } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
  try { return JSON.parse(text) || {} } catch { return { unreadable: true } }
}

// A configuration may be replaced only to finish an earlier attempt: the same
// app, and no group bound yet. Anything else is someone's installation.
function assertReplaceable(existing, configPath, reuseAppId) {
  if (!existing) return
  const retry = `to reuse that app run sintbot connect --app-id <cli_…>, otherwise move ${configPath} aside first`
  if (reuseAppId === undefined) {
    throw new Error(existing.unreadable || existing.feishu?.appId || existing.feishu?.appSecret
      ? `${configPath} already holds a Feishu app; ${retry}`
      : `${configPath} already exists; move it aside before connecting`)
  }
  if (existing.unreadable) throw new Error(`${configPath} is not readable JSON; move it aside before connecting with --app-id`)
  if (existing.feishu?.appId !== reuseAppId) {
    throw new Error(`${configPath} belongs to a different Feishu app (${existing.feishu?.appId || 'none'}); ` +
      `run sintbot connect --app-id ${existing.feishu?.appId || '<cli_…>'} to continue with it, or move the file aside`)
  }
  if (Object.keys(existing.groups || {}).length) {
    throw new Error(`${configPath} already binds ${Object.keys(existing.groups).length} group(s); ` +
      'connect never replaces a configuration with groups — add groups in the console or by editing the file')
  }
}

function assertFreshState(fs, stateDir) {
  let names = []
  try { names = fs.readdirSync(stateDir) } catch (error) { if (error.code === 'ENOENT') return; throw error }
  const found = names.filter(name => STATE_FILES.includes(name) || /^c2-v2.*\.log$/.test(name))
  if (!found.length) return
  if (found.includes('daemon.lock')) throw new Error(`SintBot is running (${path.join(stateDir, 'daemon.lock')} exists); stop it before connecting`)
  throw new Error(`${found.join(', ')} already exist(s) in ${stateDir}; an existing journal requires review, ` +
    'and connect never overwrites or migrates existing state')
}

function probeRunners(spawnSync, env) {
  const runners = {}
  for (const runner of RUNNERS) {
    const probe = spawnSync(runner, ['--version'], { encoding: 'utf8', timeout: 10_000, maxBuffer: 64 * 1024, env })
    runners[runner] = !probe.error && probe.status === 0 && new RegExp(runner, 'i').test(probe.stdout || '')
  }
  return runners
}

// Width is judged on the literal path and on what it really points to, so a
// link to the home directory or the root is refused as well.
function dirObserved(fs, workdir, explicit, home) {
  let exists = false
  try { exists = fs.statSync(workdir).isDirectory() } catch {}
  const empty = !exists || fs.readdirSync(workdir).length === 0
  const tooWide = tooWideReason(workdir, { home }) ||
    tooWideReason(realpathLenient(workdir), { home: realpathLenient(home) })
  return { workdir, exists, empty, tooWide, explicit }
}

async function runConnect(argv, deps = {}) {
  const d = defaultDeps(deps)
  const { fs, feishu, stderr, stdout } = d
  const { values } = parseArgs({ args: argv, allowPositionals: false, options: CONNECT_OPTIONS })
  const basic = values.basic === true
  const reuseAppId = values['app-id']
  const givenChatId = values.chat
  if (reuseAppId !== undefined && !APP_ID.test(reuseAppId)) throw new Error('--app-id must be a Feishu app id (cli_…)')
  if (givenChatId !== undefined && !CHAT_ID.test(givenChatId)) throw new Error('--chat must be a Feishu group id (oc_…)')
  if (values.provider !== undefined && !RUNNERS.includes(values.provider)) throw new Error('--provider must be codex or claude')
  const say = text => stderr.write(`${text}\n`)
  // A wait notice repeats on every poll; it is printed once per change.
  let lastWait = null
  const decide = (step, input) => {
    const plan = core.connectPlan(step, { basic, ...input })
    if (plan.verdict === 'wait') {
      if (!(plan.retryAfterMs > 0)) throw new Error(`The core asked to wait on ${step} without a retry interval`)
      if (plan.notice !== lastWait) say(plan.notice)
      lastWait = plan.notice
    } else {
      lastWait = null
      say(plan.notice)
    }
    return plan
  }

  // Step 0: never touch an installation that already has credentials, state
  // or a running service; --app-id may only finish an attempt for that app.
  const stateDir = installationStateDir(values['data-dir'] === undefined ? path.join(d.home, '.sbot') : values['data-dir'])
  const configPath = values.config ? path.resolve(values.config)
    : d.env.SBOT_CONFIG ? path.resolve(d.env.SBOT_CONFIG) : path.join(d.home, '.sbot', 'config.json')
  if (!path.isAbsolute(configPath)) throw new Error('The configuration path must be absolute')
  assertReplaceable(readExistingConfig(fs, configPath), configPath, reuseAppId)
  assertFreshState(fs, stateDir)

  // Project directory per the directory rule: an existing --workdir, or a new
  // folder under ~/Projects named by --name or a prompt.
  let workdir
  const explicit = values.workdir !== undefined
  if (explicit) {
    workdir = values.workdir
    if (!path.isAbsolute(workdir) || workdir !== path.resolve(workdir)) throw new Error('--workdir must be a normalized absolute path')
    let stat = null
    try { stat = fs.statSync(workdir) } catch {}
    if (!stat?.isDirectory()) throw new Error('--workdir must be an existing directory')
  } else {
    let name = values.name
    if (name === undefined) {
      name = d.isTTY ? await (d.prompt || askLine)('项目名（默认 sintbot）：', 'sintbot', d) : 'sintbot'
    }
    if (!PROJECT_NAME.test(name) || name === '.' || name === '..') throw new Error('The project name may only use letters, digits, ".", "_" and "-" (max 60)')
    workdir = path.join(defaultProjectsRoot({ home: d.home }), name)
  }
  // The core's directory decision is taken before the scan too, so a refused
  // directory never costs the user a scan; it is taken again before creation.
  const early = core.connectPlan('dir', { basic, observed: dirObserved(fs, workdir, explicit, d.home) })
  if (early.verdict === 'stop') { say(early.notice); return 1 }

  // Runners present on this Mac; the group's provider must be one of them.
  const runners = probeRunners(d.spawnSync, d.env)
  const available = RUNNERS.filter(runner => runners[runner])
  if (!available.length) throw new Error('Install and sign in to Codex or Claude Code first; neither answered --version')
  let provider = values.provider
  if (provider !== undefined && !runners[provider]) throw new Error(`${provider} did not answer --version; install and sign in to it first`)
  if (provider === undefined) {
    provider = available.length === 1 || !d.isTTY ? available[0]
      : await (d.prompt || askLine)(`执行器（${available.join(' / ')}，默认 ${available[0]}）：`, available[0], d)
    if (!runners[provider]) throw new Error('--provider must be codex or claude')
  }
  // Everything the configuration needs apart from the scan result is known;
  // let the core validate it now with placeholders for the scanned identities.
  const configInput = { appId: reuseAppId || 'cli_pending', appSecret: 'pending', botOpenId: 'ou_pending', adminOpenId: 'ou_pending',
    chatId: givenChatId || null, workdir, home: d.home, provider, runners }
  const dryRun = core.connectConfig(configInput)
  if (!dryRun.ok) throw new Error(dryRun.error)

  // Step 1: the scan. The link is printed, and a local page renders the QR
  // code from the core's matrix; the page is removed however this ends.
  // The app is named before anyone has scanned, so the only name available
  // is the local account's; the scanner's Feishu display name (the SDK
  // returns none, contacts are read later) names the group instead.
  const manifest = core.connectManifest(basic, d.userName, d.version)
  say(manifest.hint)
  let qrDir = null
  const cleanupQr = () => {
    if (!qrDir) return
    try { fs.rmSync(qrDir, { recursive: true, force: true }) } catch {}
    qrDir = null
  }
  process.once('exit', cleanupQr)
  const abort = new AbortController()
  const onSignal = () => abort.abort()
  for (const signal of ['SIGINT', 'SIGTERM']) d.signals.on(signal, onSignal)
  let lastStatus = null
  let registration
  try {
    registration = await d.registerApp({
      ...(reuseAppId === undefined ? { createOnly: true } : { appId: reuseAppId }),
      appPreset: manifest.appPreset, addons: sdkAddons(manifest.addons), source: manifest.source, signal: abort.signal,
      onQRCodeReady: ({ url, expireIn }) => {
        stdout.write(`${url}\n`)
        say(`二维码 ${Math.floor(Number(expireIn) || 0)} 秒内有效。`)
        try {
          qrDir = fs.mkdtempSync(path.join(d.tmpdir, 'sintbot-connect-'))
          const page = path.join(qrDir, 'feishu-qr.html')
          fs.writeFileSync(page, qrPage(url), { mode: 0o600 })
          if (values['no-open'] !== true) {
            const child = d.spawn('open', [page], { stdio: 'ignore', detached: true })
            child.on?.('error', () => {})
            child.unref?.()
          }
        } catch (error) { say(`二维码页面未能打开（${error?.message || error}），请直接打开上面的链接。`) }
      },
      onStatusChange: info => {
        const status = info?.status || ''
        if (status === lastStatus) return
        lastStatus = status
        if (status === 'polling') say('等待扫码…')
        else if (status === 'slow_down') say('等待扫码…（已放慢轮询）')
        else if (status === 'domain_switched') say('已切换到 Lark 国际版域名。')
      },
    })
  } catch (error) {
    if (abort.signal.aborted) return EXIT_INTERRUPTED
    const reason = error?.description ? `${error.code}: ${error.description}` : (error?.message || String(error))
    throw new Error(`Feishu scan did not complete (${reason})`)
  } finally {
    cleanupQr()
    process.off('exit', cleanupQr)
    for (const signal of ['SIGINT', 'SIGTERM']) d.signals.off(signal, onSignal)
  }
  const appId = registration?.client_id || ''
  const appSecret = registration?.client_secret || ''
  const adminOpenId = registration?.user_info?.open_id || ''
  if (!appId || !appSecret) throw new Error('Feishu scan returned no app credentials')
  // The id (never the secret) lets every later stop be resumed with --app-id.
  say(`应用 ID：${appId}`)
  const client = d.feishuClient(appId, appSecret)
  const { larkErrMsg } = feishu

  // Step 2a: credentials and bot identity.
  let identity = null
  let plan
  try {
    identity = await feishu.fetchAppIdentity(client, appId)
    // An SDK body with a non-zero code does not throw; read it so a code such
    // as 21001 reaches the core instead of an empty identity.
    if (!identity.openId) assertOk(await client.request({ method: 'GET', url: '/open-apis/bot/v3/info' }), 'bot identity')
    plan = decide('token', {})
  } catch (error) { plan = decide('token', failureInput(error, larkErrMsg)) }
  if (plan.verdict === 'stop') return 1

  // Step 2b: app enabled, waiting for an organization review when there is one.
  let waitedMs = 0
  for (;;) {
    const enabled = identity?.activateOk === true
    plan = decide('app', { observed: { enabled, pendingReview: enabled ? false : await pendingReview(client, appId), waitedMs } })
    if (plan.verdict !== 'wait') break
    await d.sleep(plan.retryAfterMs)
    waitedMs += plan.retryAfterMs
    try { identity = await feishu.fetchAppIdentity(client, appId) } catch { identity = null }
  }
  if (plan.verdict === 'stop') return 1

  // Step 2c: the existing readiness checklist.
  const precheck = await feishu.feishuPrecheck(client, { appId })
  if (decide('precheck', { observed: { checks: precheck.checks } }).verdict === 'stop') return 1
  const botOpenId = precheck.botOpenId || identity?.openId || ''

  // Step 3: contact range, visibility and a published version. Failures only
  // warn; --basic skips both.
  if (basic) {
    decide('scope', {})
  } else {
    try {
      assertOk(await client.request({ method: 'PATCH', url: `/open-apis/application/v7/applications/${encodeURIComponent(appId)}/config`,
        data: { contacts: { contacts_range_type: 'all' }, visibility: { is_visible_to_all: true } } }), 'scope')
      decide('scope', {})
    } catch (error) { decide('scope', failureInput(error, larkErrMsg)) }
    try {
      assertOk(await client.request({ method: 'POST', url: `/open-apis/application/v7/applications/${encodeURIComponent(appId)}/publish`,
        data: { remark: 'SintBot 接入', changelog: `SintBot ${d.version} 接入：机器人、消息事件与卡片回调。`,
          mobile_default_ability: 'bot', pc_default_ability: 'bot' } }), 'publish')
      decide('publish', {})
      await waitPublished(client, appId, d)
    } catch (error) { decide('publish', failureInput(error, larkErrMsg)) }
  }

  // The real configuration input, validated before anything is created.
  Object.assign(configInput, { appId, appSecret, botOpenId, adminOpenId })
  let built = core.connectConfig(configInput)
  if (!built.ok) { decide('config', { code: LOCAL_FAILURE, msg: built.error }); return 1 }

  // Step 4: the project directory is judged now and created with the
  // configuration below, so a stopped group step leaves no folder behind.
  const observed = dirObserved(fs, workdir, explicit, d.home)
  if (decide('dir', { observed }).verdict === 'stop') return 1

  // Step 5: the group. A group given with --chat is bound as it is; otherwise
  // one is created with the scanner as its first member. Failure stops here,
  // before any file exists; the core's notice carries the resume command.
  let chatId = givenChatId || null
  const chatName = (await scannerName(client, adminOpenId, registration.user_info?.name, basic, d)) || manifest.appPreset.name
  if (!chatId) {
    try {
      const chat = await feishu.createChat(client, chatName, '', adminOpenId ? [adminOpenId] : [])
      if (!chat.chatId) throw new Error('create chat returned no chat_id')
      chatId = chat.chatId
      plan = decide('chat', { observed: { appId, chatId } })
    } catch (error) { plan = decide('chat', { ...failureInput(error, larkErrMsg), observed: { appId, chatId: null } }) }
  } else {
    plan = decide('chat', { observed: { appId, chatId } })
  }
  if (plan.verdict === 'stop') return 1
  try {
    await feishu.sendChatText(client, chatId,
      `你好，我是 ${chatName}。这个群绑定的项目目录是 ${workdir}；有任务直接 @ 我或在群里说。`)
  } catch {}

  // Step 6: the folder, config.json (0600 in a 0700 directory) and the README.
  built = core.connectConfig({ ...configInput, chatId })
  if (!built.ok) { decide('config', { code: LOCAL_FAILURE, msg: built.error }); return 1 }
  let createdDir = false
  try {
    if (!observed.exists) {
      fs.mkdirSync(path.dirname(workdir), { recursive: true, mode: 0o755 })
      fs.mkdirSync(workdir, { mode: 0o755 })
      createdDir = true
    }
    fs.mkdirSync(path.dirname(configPath), { recursive: true, mode: 0o700 })
    atomicWriteJSON(configPath, built.config, { mode: 0o600 })
    fs.chmodSync(configPath, 0o600)
    const readme = path.join(workdir, 'README.md')
    if (!fs.existsSync(readme)) fs.writeFileSync(readme, built.readme, { mode: 0o644 })
    plan = decide('config', {})
  } catch (error) {
    if (createdDir) { try { if (!fs.readdirSync(workdir).length) fs.rmdirSync(workdir) } catch {} }
    plan = decide('config', { code: LOCAL_FAILURE, msg: error?.message || String(error) })
  }
  if (plan.verdict === 'stop') return 1

  // Step 7: journals, under the unchanged fresh-state rules.
  try {
    d.initializeInstallation(configPath, { dataDir: stateDir })
    plan = core.connectPlan('init', { basic })
  } catch (error) { plan = decide('init', { code: LOCAL_FAILURE, msg: error?.message || String(error) }) }
  if (plan.verdict === 'stop') return 1
  const installed = path.join(d.home, '.local', 'share', 'sintbot', 'bin', 'sintbot')
  const bin = fs.existsSync(installed) ? '"$HOME/.local/share/sintbot/bin/sintbot"' : 'sintbot'
  stdout.write(`${plan.notice}\n${bin} start --config ${shellQuote(configPath)} --data-dir ${shellQuote(stateDir)} --ui\n`)
  return 0
}

const appVersions = (client, appId) => client.request({ method: 'GET',
  url: `/open-apis/application/v6/applications/${encodeURIComponent(appId)}/app_versions`,
  params: { lang: 'zh_cn', page_size: 10, user_id_type: 'open_id' } })
const versionItems = r => r?.data?.items || r?.items || []

// A version waiting for the organization's review (app_versions status 1).
// Unreadable (missing scope, no version yet) means no review is pending.
async function pendingReview(client, appId) {
  try { return versionItems(await appVersions(client, appId)).some(item => item?.status === 1) } catch { return false }
}

// After publish, give the app up to 30 s to report a published version. This
// only paces the next steps; the core has already judged the publish call.
async function waitPublished(client, appId, d) {
  const until = d.now() + PUBLISH_POLL_MS
  do {
    try { if (versionItems(await appVersions(client, appId)).some(item => item?.status === 2)) return true } catch { return false }
    await d.sleep(PUBLISH_POLL_STEP_MS)
  } while (d.now() < until)
  return false
}

// The scanner's display name, through the same core manifest that names the
// app, so the group is "<name>的 SintBot". A name in the SDK result (the
// current SDK sends only open_id) wins over the contact lookup; empty when
// neither is available.
async function scannerName(client, openId, sdkName, basic, d) {
  let name = typeof sdkName === 'string' ? sdkName.trim() : ''
  if (!name && openId) {
    try {
      const r = await client.contact.user.get({ params: { user_id_type: 'open_id' }, path: { user_id: openId } })
      name = r?.data?.user?.name || r?.data?.user?.nickname || ''
    } catch { name = '' }
  }
  return name ? core.connectManifest(basic, name, d.version).appPreset.name : ''
}

module.exports = { runConnect, CONNECT_OPTIONS, sdkAddons, qrPage, failureInput }
