'use strict'
// Setup mode: `sintbot start --ui` with no configuration serves a local page
// that runs the scan-to-connect flow in this process. The page collects the
// inputs `sintbot connect` would take as flags, shows the QR code, streams the
// step notices, and offers the resume paths (existing app, hand-made group)
// as buttons. Once the configuration is written and initialized, the server
// closes and the caller continues into the normal start.
//
// Everything that decides the flow stays in src/connect.js and the core; this
// module only adapts it to HTTP: arguments in, captured notices out.
const http = require('node:http')
const path = require('node:path')
const { spawnSync } = require('node:child_process')
const { runConnect, runLocalSetup, runWecomSetup, qrPage, probeRunners: connectProbe, EXIT_INTERRUPTED } = require('./connect')

const QR_URL = /^https:\/\/[^\s]+/
const APP_ID_LINE = /^应用 ID：(cli_[A-Za-z0-9]{6,64})$/m
const CHAT_HINT = /--chat <oc_…>/
const APP_ID = /^cli_[A-Za-z0-9]{6,64}$/
const CHAT_ID = /^oc_[A-Za-z0-9_-]{1,124}$/
const PROJECT_NAME = /^[\p{L}\p{N}][\p{L}\p{N}._-]{0,59}$/u
const RUNNERS = Object.freeze(['codex', 'claude'])
const BODY_LIMIT = 16 * 1024

// The same probe runConnect uses, so the page never offers a runner the run
// would then refuse.
function probeRunners(spawn = spawnSync, env = process.env) {
  try { return connectProbe(spawn, env) } catch { return Object.fromEntries(RUNNERS.map(r => [r, false])) }
}

function svgOf(url) {
  const m = /<svg[\s\S]*?<\/svg>/.exec(qrPage(url))
  return m ? m[0] : ''
}

// One attempt = one `runConnect` run with captured output. The state object
// is what the page polls; it carries no secrets (the app secret never reaches
// stdout/stderr by design of runConnect).
function createSetupSession({ configFile, dataDir, home, version, runners, connect = runConnect, localSetup = runLocalSetup, wecomSetup = runWecomSetup, deps = {},
  initialize = (file, options) => require('./c2install').initializeInstallation(file, options), log = () => {} }) {
  const state = {
    phase: 'form',            // form | running | waitingChat | done | failed
    mode: 'feishu',           // feishu (scan) | local (a conversation in the console, no chat platform)
    lines: [],                // notices in order (stderr of runConnect)
    qr: null,                 // inline SVG once the scan link is known
    appId: null,              // printed by runConnect after the scan; reused by every retry
    notice: '',               // last notice when stopped or failed
    groupAppId: null,         // app owning the confirmed group
    chatId: null,             // a confirmed created group, reused after cancellation or retry
    initOnly: false,          // the configuration is written; only the journals failed
    modelDefaults: null,      // the live recommendation confirmed before scanning
    runners,                  // which executors answered --version
    defaults: { name: 'sintbot', projectsRoot: path.join(home, 'Projects') },
    startedAt: null, endedAt: null,
  }
  let signalHandlers = new Map()
  let current = null
  let finish
  const completed = new Promise(resolve => { finish = resolve })

  const argvFor = (input) => {
    const argv = ['--config', configFile, '--no-open']
    if (dataDir) argv.push('--data-dir', dataDir)
    if (input.workdir) argv.push('--workdir', input.workdir)
    else argv.push('--name', input.name || 'sintbot')
    if (input.provider) argv.push('--provider', input.provider)
    if (input.basic) argv.push('--basic')
    if (input.appId) argv.push('--app-id', input.appId)
    if (input.chatId) argv.push('--chat', input.chatId)
    return argv
  }

  const validate = (input) => {
    if (!input || typeof input !== 'object') throw new Error('请填写接入信息')
    const out = {}
    if (input.workdir !== undefined && input.workdir !== '') {
      if (typeof input.workdir !== 'string' || !path.isAbsolute(input.workdir)) throw new Error('项目目录必须是绝对路径')
      out.workdir = path.resolve(input.workdir)
    } else {
      const name = input.name === undefined || input.name === '' ? 'sintbot' : String(input.name)
      if (!PROJECT_NAME.test(name) || name === '.' || name === '..') throw new Error('项目名只能用字母、数字、"."、"_" 和 "-"（最长 60）')
      out.name = name
    }
    if (input.provider !== undefined && input.provider !== '' && input.provider !== 'auto') {
      if (!RUNNERS.includes(input.provider)) throw new Error('执行器只能是 codex 或 claude')
      out.provider = input.provider
    }
    out.basic = input.basic === true
    if (input.appId !== undefined && input.appId !== '') {
      if (!APP_ID.test(input.appId)) throw new Error('应用 ID 应形如 cli_…')
      out.appId = input.appId
    }
    if (input.chatId !== undefined && input.chatId !== '') {
      if (!CHAT_ID.test(input.chatId)) throw new Error('群 ID 应形如 oc_…')
      out.chatId = input.chatId
    }
    return out
  }

  function start(rawInput) {
    if (state.phase === 'running') throw new Error('接入正在进行')
    if (state.phase === 'done') throw new Error('接入已完成')
    if (state.initOnly) return retryInit()
    // A resume (hand-made group) keeps the directory and options of the run
    // that failed, even if the page was reloaded in between.
    if (rawInput && rawInput.chatId && state.input) {
      const keep = state.input
      rawInput = { name: keep.name || undefined, workdir: keep.workdir || undefined, provider: keep.provider || undefined, basic: keep.basic, ...rawInput }
      for (const k of ['name', 'workdir', 'provider']) if (rawInput[k] === '' || rawInput[k] === null) rawInput[k] = keep[k] || undefined
    }
    const input = validate(rawInput)
    // Every retry reuses the app the first scan created: no second app in the
    // organization, and the same --app-id resume the terminal route offers.
    if (!input.appId && state.appId) input.appId = state.appId
    if (!input.chatId && state.chatId && input.appId === state.groupAppId) input.chatId = state.chatId
    state.phase = 'running'
    state.mode = 'feishu'
    state.modelDefaults = null
    state.lines = []
    state.qr = null
    state.notice = ''
    state.startedAt = Date.now()
    state.endedAt = null
    state.input = { name: input.name || null, workdir: input.workdir || null, provider: input.provider || null, basic: input.basic }
    signalHandlers = new Map()
    const stderrText = { buf: '' }
    const write = (sink) => (chunk) => {
      sink.buf += String(chunk)
      let nl
      while ((nl = sink.buf.indexOf('\n')) >= 0) {
        const line = sink.buf.slice(0, nl)
        sink.buf = sink.buf.slice(nl + 1)
        sink.onLine(line)
      }
    }
    const stdout = { buf: '', onLine: line => {
      if (QR_URL.test(line)) { if (!state.qr) { state.qr = svgOf(line); state.lines.push('请用手机飞书扫描页面上的二维码。') }; return }
      // The final notice arrives on stdout; the start command does not apply here.
      if (line.trim() && !/\bstart --config\b/.test(line)) state.lines.push(line)
    } }
    stderrText.onLine = line => {
      if (!line.trim()) return
      state.lines.push(line)
      const m = APP_ID_LINE.exec(line)
      if (m) { state.appId = m[1]; state.qr = null }
    }
    const run = (async () => {
      let code
      try {
        code = await connect(argvFor(input), { ...deps, stdout: { write: write(stdout) }, stderr: { write: write(stderrText) },
          isTTY: false, version, env: process.env, home,
          onModelDefaults: value => { state.modelDefaults = { provider: value.provider, model: value.model, effort: value.effort, name: value.name, source: value.source } },
          onGroupReady: ({ appId, chatId }) => { state.appId = appId; state.groupAppId = appId; state.chatId = chatId },
          signals: { on: (sig, fn) => signalHandlers.set(sig, fn), off: (sig) => signalHandlers.delete(sig) } })
      } catch (error) {
        code = 1
        state.lines.push(error?.message || String(error))
      }
      if (stdout.buf.trim()) stdout.onLine(stdout.buf)
      if (stderrText.buf.trim()) stderrText.onLine(stderrText.buf)
      if (code === EXIT_INTERRUPTED) state.lines.push('已取消，没有写入任何文件。')
      state.qr = null
      state.endedAt = Date.now()
      const last = [...state.lines].reverse().find(l => l.trim()) || ''
      state.notice = last
      if (code === 0) {
        state.phase = 'done'
        log('setup: configuration written and initialized')
        finish(true)
      } else if (state.appId && state.lines.some(l => CHAT_HINT.test(l))) {
        state.phase = 'waitingChat'
      } else {
        state.phase = 'failed'
        // The configuration exists but the journals do not: retry only that step.
        if (state.lines.some(l => /^初始化失败/.test(l))) state.initOnly = true
      }
      current = null
    })()
    current = run
    return state
  }

  // Setup without a chat platform: no scan, no app; one conversation in the
  // console. Same captured-notice session as the scan run.
  function startLocal(rawInput) { return startConversation(rawInput, 'local') }
  function startWecom(rawInput) { return startConversation(rawInput, 'wecom') }
  function startConversation(rawInput, mode) {
    if (state.phase === 'running') throw new Error('接入正在进行')
    if (state.phase === 'done') throw new Error('接入已完成')
    if (state.initOnly) return retryInit()
    if (state.appId) throw new Error('这次接入已经创建了飞书应用，请继续完成扫码接入')
    const input = validate({ name: rawInput?.name, workdir: rawInput?.workdir, provider: rawInput?.provider })
    state.phase = 'running'
    state.mode = mode
    state.modelDefaults = null
    state.lines = []
    state.qr = null
    state.notice = ''
    state.startedAt = Date.now()
    state.endedAt = null
    state.input = { name: input.name || null, workdir: input.workdir || null, provider: input.provider || null, basic: false }
    signalHandlers = new Map()
    const push = chunk => { for (const line of String(chunk).split('\n')) if (line.trim()) state.lines.push(line) }
    const run = (async () => {
      let code
      try {
        code = await (mode === 'wecom' ? wecomSetup : localSetup)({ config: configFile, dataDir, name: input.name, workdir: input.workdir, provider: input.provider,
          ...(mode === 'wecom' ? { botId: rawInput?.botId, secret: rawInput?.secret } : {}) },
          { ...deps, stdout: { write: push }, stderr: { write: push }, isTTY: false, version, env: process.env, home,
            onModelDefaults: value => { state.modelDefaults = { provider: value.provider, model: value.model, effort: value.effort, name: value.name, source: value.source } },
            signals: { on: (sig, fn) => signalHandlers.set(sig, fn), off: (sig) => signalHandlers.delete(sig) } })
      } catch (error) {
        code = 1
        state.lines.push(error?.message || String(error))
      }
      state.endedAt = Date.now()
      state.notice = [...state.lines].reverse().find(l => l.trim()) || ''
      if (code === 0) {
        state.phase = 'done'
        log('setup: local conversation configured and initialized')
        finish(true)
      } else {
        state.phase = 'failed'
        if (state.lines.some(l => /^初始化失败/.test(l))) state.initOnly = true
      }
      current = null
    })()
    current = run
    return state
  }

  function retryInit() {
    state.phase = 'running'; state.notice = ''; state.startedAt = Date.now()
    const run = (async () => {
      try {
        initialize(configFile, { dataDir })
        state.initOnly = false
        state.lines.push('初始化完成。')
        state.phase = 'done'
        state.endedAt = Date.now()
        finish(true)
      } catch (error) {
        state.lines.push(`初始化失败（${error?.message || error}）。`)
        state.notice = state.lines[state.lines.length - 1]
        state.phase = 'failed'
        state.endedAt = Date.now()
      }
      current = null
    })()
    current = run
    return state
  }

  // Signals the run exactly like Ctrl-C; runConnect stops at its next step
  // boundary and writes nothing. False when nothing can be cancelled.
  function cancel() {
    if (state.phase !== 'running') return false
    const handler = signalHandlers.get('SIGINT') || signalHandlers.get('SIGTERM')
    if (!handler) return false
    handler()
    return true
  }

  function reset() {
    if (state.phase === 'running' || state.phase === 'done') return false
    state.phase = 'form'; state.lines = []; state.qr = null; state.notice = ''; state.mode = 'feishu'
    return true
  }

  const snapshot = () => ({ ...state, lines: state.lines.slice(-60) })
  void EXIT_INTERRUPTED
  return { state, snapshot, start, startLocal, startWecom, cancel, reset, completed, wait: () => current }
}

function createSetupServer(options) {
  const { host = '127.0.0.1', port = 4600, version = '', log = () => {}, page = setupPage } = options
  if (!['127.0.0.1', 'localhost', '::1'].includes(host)) throw new Error('Setup mode only listens on this Mac')
  const session = createSetupSession(options)
  const json = (res, status, body) => {
    const text = JSON.stringify(body)
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', 'content-length': Buffer.byteLength(text) })
    res.end(text)
  }
  const readBody = (req) => new Promise((resolve, reject) => {
    let size = 0, raw = ''
    if (Number(req.headers['content-length']) > BODY_LIMIT) { const e = new Error('请求过大'); e.status = 413; return reject(e) }
    req.on('data', chunk => { size += chunk.length; if (size > BODY_LIMIT) { const e = new Error('请求过大'); e.status = 413; reject(e) } else raw += chunk })
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}) } catch { reject(new Error('请求不是 JSON')) } })
    req.on('error', reject)
  })
  let boundPort = port
  const localHost = value => /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/.test(value || '') &&
    (Number((value.match(/:(\d+)$/) || [])[1] || 80) === boundPort)
  const server = http.createServer(async (req, res) => {
    try {
      // Local page only: the Host must be this listener (no DNS rebinding) and
      // a browser Origin, when present, must be the same host and port.
      if (!localHost(req.headers.host)) return json(res, 403, { error: 'forbidden' })
      const origin = req.headers.origin
      if (origin) {
        let originHost = null
        try { const parsed = new URL(origin); if (parsed.protocol === 'http:') originHost = parsed.host } catch {}
        if (!originHost || originHost !== req.headers.host) return json(res, 403, { error: 'forbidden' })
      }
      const url = new URL(req.url, 'http://127.0.0.1')
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/setup')) {
        const html = page({ version })
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' })
        return res.end(html)
      }
      if (req.method === 'GET' && url.pathname === '/api/setup/state') return json(res, 200, session.snapshot())
      if (req.method === 'POST' && url.pathname === '/api/setup/start') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: '需要 JSON' })
        const body = await readBody(req)
        return json(res, 200, { ok: true, state: session.start(body) && session.snapshot() })
      }
      if (req.method === 'POST' && url.pathname === '/api/setup/wecom') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: '需要 JSON' })
        const body = await readBody(req)
        return json(res, 200, { ok: true, state: session.startWecom(body) && session.snapshot() })
      }
      if (req.method === 'POST' && url.pathname === '/api/setup/local') {
        if (!/^application\/json/.test(req.headers['content-type'] || '')) return json(res, 415, { error: '需要 JSON' })
        const body = await readBody(req)
        return json(res, 200, { ok: true, state: session.startLocal(body) && session.snapshot() })
      }
      if (req.method === 'POST' && url.pathname === '/api/setup/cancel') return json(res, 200, { ok: session.cancel() })
      if (req.method === 'POST' && url.pathname === '/api/setup/reset') return json(res, 200, { ok: session.reset() })
      if (req.method === 'GET') { res.writeHead(302, { location: '/' }); return res.end() }
      return json(res, 404, { error: 'not found' })
    } catch (error) {
      if (res.headersSent || res.destroyed) return
      return json(res, error?.status || 400, { error: error?.message || String(error) })
    }
  })
  server.keepAliveTimeout = 1000
  server.on('clientError', (error, socket) => {
    if (!socket.destroyed) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n')
  })
  return {
    server, session,
    listen: () => new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(port, host, () => {
        server.off('error', reject)
        boundPort = server.address().port
        server.on('error', error => log(`setup server error: ${error.message}`))
        resolve(server.address())
      })
    }),
    // Resolves once the configuration is written; the server is then closed
    // after a short grace so the page can read the final state.
    completed: session.completed,
    close: () => new Promise(resolve => { server.closeAllConnections?.(); server.close(() => resolve()) }),
    log,
  }
}

// Display-only translations: the core's original notices still drive the session.
// Unknown upstream details retain machine-readable error codes without mixing UI languages.
function translateSetupNotice(value, lang = 'en') {
  const line = String(value || '')
  if (lang === 'zh' && /^Could not read live model defaults for /.test(line)) return '无法读取执行器实时推荐的型号和思考深度。请检查执行器登录和网络后重试；本次尚未完成接入。'
  if (lang === 'zh' && /^The live model catalog did not provide/.test(line)) return '实时模型清单没有提供有效的型号和思考深度，请检查执行器登录后重试。'
  if (lang === 'zh') return line.replace(/然后执行 sintbot connect.*$/, '然后在此页面填写群 ID 并继续。')
    .replace(/重新执行 sintbot connect(?: --app-id \S+)?[。]?/g, '在此页面重试。')
    .replace(/可手动执行 sintbot init 重试。/, '请点击「重试初始化」。')
  const exact = {
    "请填写机器人 Bot ID 和 Secret": "Enter the bot ID and secret.",
    "请将机器人添加到目标企业微信群，并在群里 @ 机器人发送“连接”。": "Add the bot to your WeCom group, then @mention it with “connect”.",
    "机器人连接失败，请检查凭据和网络": "Could not connect the bot. Check its credentials and your network.",
    "等待群消息超时，请确认机器人已添加到群后重试": "No group message arrived. Add the bot to your group, then retry.",
    "机器人连接不可用，请检查凭据及是否被其他设备使用": "The bot connection is unavailable. Check its credentials and whether another device is using it.",
    "机器人连接尚未完全关闭，请稍后重试": "The bot connection has not closed yet. Please retry shortly.",
    "已取消接入": "Connection cancelled.",
    "企业微信已连接，请回到群里 @机器人 发送任务。": "WeCom is connected. Return to the group and @mention the bot with a task.",

    '请填写接入信息': 'Enter the project details.',
    '项目目录必须是绝对路径': 'Enter an absolute path for the project folder.',
    '项目名只能用字母、数字、"."、"_" 和 "-"（最长 60）': 'Use letters, digits, ".", "_" or "-" for the project name (up to 60 characters).',
    '执行器只能是 codex 或 claude': 'Choose Codex or Claude Code.',
    '应用 ID 应形如 cli_…': 'An app ID must start with cli_.',
    '群 ID 应形如 oc_…': 'A group ID must start with oc_.',
    '正在读取执行器推荐的型号和思考深度…': 'Reading the executor’s recommended model and thinking depth…',
    '接入正在进行': 'Setup is already running.', '接入已完成': 'Setup is already complete.',
    '请求过大': 'The request is too large.', '请求不是 JSON': 'The request is not valid JSON.', '需要 JSON': 'Send a JSON request.',
    '请用手机飞书扫描页面上的二维码。': 'Scan this QR code with Feishu on your phone.',
    '请先确认手机飞书当前在企业/团队身份下；没有组织的个人身份扫不了，需先新建一个团队（免费）。': 'Switch Feishu on your phone to a company or team account. A personal account without an organization cannot connect; create a free team first.',
    '等待扫码…': 'Waiting for you to scan…', '等待扫码…（已放慢轮询）': 'Waiting for you to scan… (checking less often)',
    '已切换到 Lark 国际版域名。': 'Switched to the international Lark service.',
    '已取消，没有写入任何文件。': 'Cancelled. No configuration or project files were written.',
    '已获取应用凭证。': 'App credentials received.', '应用已启用。': 'The app is enabled.',
    '当前是个人身份，飞书不允许它调用接口。请新建一个团队，切换过去后重新扫码。': 'Feishu does not allow this personal account to use the API. Create a team, switch to it, and scan again.',
    '已提交，等组织管理员审核通过。': 'Submitted. Waiting for your organization administrator to approve the app.',
    '应用未启用：请到飞书开发者后台启用该应用后重新执行 sintbot connect。': 'Enable the app in the Feishu developer console, then retry here.',
    '自检通过。': 'Readiness checks passed.', '基础模式，跳过权限开通。': 'Basic setup: skipping permission changes.',
    '基础模式，跳过发布。': 'Basic setup: skipping publication.', '权限已开通。': 'Permissions enabled.',
    '已提交发布。': 'App publication submitted.', '使用你提供的群。': 'Using the group you provided.',
    '群已创建并拉入机器人。': 'Group created and the bot added.', '初始化完成。': 'Initialization complete.',
    '本机对话已就绪，在控制台的「对话」里说第一句吧。': 'Your conversation is ready. Open Chat in the console and say what you need.',
    '这次接入已经创建了飞书应用，请继续完成扫码接入': 'A Feishu app was already created in this setup. Finish connecting by scanning.',
    '连接完成。': 'Connected.', '连接完成，去飞书群里 @机器人 试试吧。': 'Connected. Send your first task to the bot in the Feishu group.',
  }
  if (exact[line]) return exact[line]
  let match
  if ((match = /^新群默认：(.*) · (.*?)。接入后可在控制台修改。$/.exec(line))) return `New group defaults: ${match[1]} · ${match[2]}. You can change them in the console after setup.`
  if ((match = /^对话默认：(.*) · (.*?)。之后可在控制台修改。$/.exec(line))) return `Conversation defaults: ${match[1]} · ${match[2]}. You can change them in the console later.`
  if ((match = /^二维码 (\d+) 秒内有效。$/.exec(line))) return `The QR code expires in ${match[1]} seconds.`
  if ((match = /^应用 ID：(.*)$/.exec(line))) return `App ID: ${match[1]}`
  if ((match = /^项目目录 (.*) 就绪。$/.exec(line))) return `Project folder ready: ${match[1]}`
  if ((match = /^配置已写入 (.*)。$/.exec(line))) return `Configuration saved to ${match[1]}.`
  if ((match = /^目录 (.*) 已存在且非空。/.exec(line))) return `The folder ${match[1]} already contains files. Choose another project name, or enter that folder in the existing-project field.`
  if (/^目录 /.test(line)) return 'This folder is too broad to use as a project. Choose a specific project folder.'
  const codes = [...line.matchAll(/(?:code[ :：]+|HTTP\s+|（)(\d{3,})/g)].map(m => m[1])
  const suffix = codes.length ? ` (code ${[...new Set(codes)].join(', ')})` : ''
  const detail = /（([^）]+)）/.exec(line)?.[1]
  const extra = detail && !/[\u3400-\u9fff]/.test(detail) ? ` (${detail})` : suffix
  if (/^二维码页面未能打开/.test(line)) return 'The separate QR window could not open. Use the QR code on this page.'
  if (/^获取 tenant_access_token 失败/.test(line)) return `Could not obtain an app access token${extra}. Check that the app is available, then retry.`
  if (/^查询应用状态失败/.test(line)) return `Could not read the app status${extra}. Retry after checking the app in the Feishu developer console.`
  if (/^审核超时/.test(line)) return 'Approval is still pending. Retry after your organization administrator approves the app.'
  if (/^自检未通过|^自检失败/.test(line)) return `Readiness checks failed${extra}. Review the bot, event subscriptions and permissions in the Feishu developer console, then retry.`
  if (/^自检有提醒/.test(line)) return `Readiness checks reported warnings${extra}. Setup can continue, but some bot features may be unavailable. Review permissions and event subscriptions in the Feishu developer console.`
  if (/^权限开通失败/.test(line)) return `Could not enable permissions${extra}. Setup can continue; ask an administrator to enable messaging and card permissions in the Feishu developer console.`
  if (/^发布失败（210304）/.test(line)) return 'Publication failed (210304). Enable the bot as the default app ability in the Feishu developer console, then create and publish a version. Until publication, only the developer can use it.'
  if (/^发布失败/.test(line)) return `Publication failed${extra}. Setup can continue. Publish a version in the Feishu developer console; until then, only the developer can use the bot.`
  if (/^应用可用范围不含你|^自动建群失败/.test(line)) return `Could not create the group${extra}. Create a Feishu group, add the bot, then enter its group ID here to continue.`
  if (/^创建项目目录失败/.test(line)) return `Could not create the project folder${extra}. Check folder permissions and retry.`
  if (/^写入 .* 失败/.test(line)) return `Could not save the configuration${extra}. Check folder permissions and retry.`
  if (/^初始化失败/.test(line)) return `Initialization failed${extra}. Your configuration is saved. Choose Retry initialization.`
  if (/[\u3400-\u9fff]/.test(line)) return `Setup could not complete this step${suffix}. Check the app in the Feishu developer console and retry.`
  return line
}

function setupPage({ version = '' } = {}) {
  return String.raw`<!doctype html>
<html lang="en" data-sintbot-setup="true"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>SintBot · Connect Feishu</title>
<style>
:root{color-scheme:light;--bg:#f6f5f1;--side:#eeede8;--panel:#fff;--ink:#252b32;--dim:#59616a;--muted:#68717a;--line:rgba(22,27,34,.08);--line-hi:rgba(22,27,34,.16);--ember:#a15b30;--ring:rgba(161,91,48,.18);--primary:#252b32;--primary-ink:#fff;--primary-hover:#3a424c;--inset:rgba(22,27,34,.03);--fail:#b44935;--ok:#36734e;--input:#fff}
:root[data-theme=dark]{color-scheme:dark;--bg:#13171c;--side:#101318;--panel:#20262d;--ink:#f6f5f1;--dim:#d1d5d9;--muted:#a5adb7;--line:rgba(246,245,241,.09);--line-hi:rgba(246,245,241,.18);--ember:#e7a46b;--ring:rgba(231,164,107,.22);--primary:#f6f5f1;--primary-ink:#252b32;--primary-hover:#f0d9be;--inset:rgba(0,0,0,.13);--fail:#f0776a;--ok:#6fd5a6;--input:rgba(0,0,0,.18)}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--ink);font:400 13px/20px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB",sans-serif;-webkit-font-smoothing:antialiased}
button,input,select{font:inherit;color:inherit}button,select,summary{cursor:pointer}button,input,select,summary{transition:background-color .15s,border-color .15s,box-shadow .15s,color .15s}
.topbar{height:52px;border-bottom:1px solid var(--line);padding:0 24px;display:flex;align-items:center;justify-content:space-between;gap:12px;background:var(--side)}.brand{display:flex;align-items:center;gap:10px}.word{font-size:16px;font-weight:650;letter-spacing:-.5px}.ver{font:11px ui-monospace,SFMono-Regular,Menlo,monospace;padding:1px 7px;border:1px solid var(--line);border-radius:5px;color:var(--muted)}.toolbar{display:flex;gap:8px;align-items:center}.toolbar label{display:flex;align-items:center;gap:6px;color:var(--muted);font-size:12px}.toolbar select{height:28px;background:transparent;border:1px solid var(--line-hi);border-radius:6px;padding:0 6px;max-width:130px}
.wrap{max-width:850px;margin:0 auto;padding:36px 24px 24px}.setup{display:grid;grid-template-columns:228px minmax(0,1fr);border:1px solid var(--line-hi);border-radius:10px;overflow:hidden;background:var(--panel)}.intro{padding:28px 24px;background:var(--inset);border-right:1px solid var(--line)}h1{font-size:20px;line-height:28px;letter-spacing:-.4px;font-weight:600;margin:0 0 10px}h2{font-size:15px;line-height:22px;font-weight:600;margin:0}.sub{color:var(--muted);font-size:12px;line-height:20px;margin:0}.steps{list-style:none;margin:28px 0 0;padding:0;display:grid;gap:20px}.steps li{display:grid;grid-template-columns:22px minmax(0,1fr);gap:10px;position:relative}.step-num{width:22px;height:22px;display:grid;place-items:center;border:1px solid var(--line-hi);border-radius:50%;font:11px ui-monospace,monospace;color:var(--muted)}.steps strong{display:block;font-size:12px;font-weight:550;color:var(--dim)}.steps small{display:block;font-size:11px;line-height:17px;color:var(--muted);margin-top:3px}.steps li.active .step-num{color:var(--ember);border-color:var(--ember);background:var(--ring)}.steps li.active strong{color:var(--ink)}.steps li.complete .step-num{color:var(--ok)}.local-note{margin-top:28px;padding-top:16px;border-top:1px solid var(--line);font-size:11px;line-height:18px;color:var(--muted)}.card{padding:26px 28px;min-width:0}.section-head{margin-bottom:20px}.section-head .hint{margin-top:4px}
label.f,.field-label{display:block;font-size:12px;font-weight:550;margin:0 0 7px;color:var(--dim)}.field{margin-bottom:18px}.hint{color:var(--muted);font-size:12px;line-height:18px;margin:6px 0 0;overflow-wrap:anywhere}.mono{font-family:ui-monospace,SFMono-Regular,Menlo,monospace;font-size:11px}input:is([type=text],[type=password]){width:100%;height:34px;padding:0 10px;border:1px solid var(--line-hi);border-radius:6px;background:var(--input);min-width:0}input:is([type=text],[type=password]):focus{outline:none;border-color:var(--ember);box-shadow:0 0 0 3px var(--ring)}input[type=checkbox],input[type=radio]{accent-color:var(--ember)}
.folder{margin-top:9px}.folder summary{font-size:12px;color:var(--muted);list-style:none;display:flex;gap:6px;align-items:center;min-height:24px}.folder summary::before{content:'›';display:inline-block;font-size:16px;transition:transform .15s}.folder[open] summary::before{transform:rotate(90deg)}.folder[open] .folder-body{padding-top:10px}.folder-body .f{font-weight:400}.folder summary::-webkit-details-marker{display:none}
.providers{display:flex;gap:8px;flex-wrap:wrap}.providers label{display:flex;align-items:center;gap:7px;flex:1;min-width:110px;padding:8px 10px;border:1px solid var(--line-hi);border-radius:6px;cursor:pointer;white-space:nowrap}.providers label:has(input:checked){border-color:var(--ember);background:var(--ring)}.providers input{margin:0}.provider-only{display:inline-flex;align-items:center;gap:8px;padding:7px 10px;background:var(--inset);border:1px solid var(--line);border-radius:6px}.provider-only::before{content:'';height:6px;width:6px;border-radius:50%;background:var(--ok)}
.advanced{padding-top:12px;border-top:1px solid var(--line);margin-top:4px}.check{display:flex;gap:8px;align-items:flex-start;font-size:12px;color:var(--dim);margin-top:10px}.check input{margin:3px 0 0}.advanced .hint{margin-left:21px;font-size:11px}.actions{display:grid;gap:8px;margin-top:20px}.row{display:flex;gap:8px;flex-wrap:wrap;align-items:center}.btn{display:inline-flex;justify-content:center;align-items:center;gap:8px;min-height:32px;padding:6px 12px;border-radius:6px;border:1px solid var(--line-hi);background:transparent;font-weight:500;cursor:pointer;line-height:18px}.btn:hover:not(:disabled){background:var(--inset);border-color:var(--muted)}.btn:active:not(:disabled){transform:translateY(1px)}.btn.primary{background:var(--primary);border-color:var(--primary);color:var(--primary-ink)}.btn.primary:hover:not(:disabled){background:var(--primary-hover);border-color:var(--primary-hover)}.btn:disabled{opacity:.45;cursor:default}.actions>.btn{width:100%;min-height:36px}.actions .secondary{border-color:transparent;color:var(--dim)}.actions .secondary:hover:not(:disabled){border-color:var(--line-hi)}.action-note{text-align:center;font-size:11px;color:var(--muted);margin:0}.error{color:var(--fail);font-size:12px;line-height:18px;margin-top:10px;overflow-wrap:anywhere}.error:empty{display:none}
.btn:focus-visible,select:focus-visible,summary:focus-visible,input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--ember);outline-offset:3px}.run-head{display:flex;align-items:center;justify-content:space-between;gap:10px}.status{font-size:15px;line-height:22px;font-weight:600}.status.failed{color:var(--fail)}.status.done{color:var(--ok)}.run-summary{min-height:20px;margin:8px 0 16px;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.qr{display:flex;justify-content:center;padding:4px 0 18px}.qr:empty{display:none}.qr svg{display:block;width:min(224px,100%);height:auto;aspect-ratio:1;background:#fff;border:10px solid white;border-radius:8px}.defaults{font-size:11px;color:var(--muted);background:var(--inset);border:1px solid var(--line);padding:7px 10px;border-radius:6px;margin:12px 0;overflow-wrap:anywhere}.progress-details{border-top:1px solid var(--line);padding-top:10px;margin-top:14px}.progress-details summary{font-size:12px;color:var(--muted);min-height:24px}.log{font:11px/18px ui-monospace,SFMono-Regular,Menlo,monospace;max-height:180px;overflow:auto;background:var(--inset);border-radius:6px;padding:10px 12px;white-space:pre-wrap;overflow-wrap:anywhere;margin-top:8px}.state-actions{margin-top:14px}.footer{display:flex;justify-content:space-between;gap:12px;color:var(--muted);font-size:11px;padding-top:14px}.hidden{display:none!important}
@media(max-width:680px){.wrap{max-width:520px;padding:20px 16px}.setup{grid-template-columns:minmax(0,1fr)}.intro{padding:20px;border-right:0;border-bottom:1px solid var(--line)}h1{font-size:18px;line-height:24px;margin-bottom:5px}.steps{display:flex;gap:12px;margin-top:16px}.steps li{display:flex;align-items:center;gap:6px;flex:1}.steps small,.local-note{display:none}.steps strong{font-size:11px;line-height:16px}.step-num{flex:none}.card{padding:20px}.section-head{margin-bottom:16px}.topbar{padding:0 16px}.toolbar label>span{display:none}}
@media(max-width:400px){.topbar{padding:0 12px}.toolbar{gap:5px}.toolbar select{font-size:11px;padding:0 3px;max-width:86px}.brand{gap:6px}.ver{display:none}.wrap{padding:14px 12px}.intro,.card{padding:16px}.steps{gap:5px}.steps li{gap:5px}.step-num{width:20px;height:20px}.footer{flex-wrap:wrap}.row .btn{flex:1}.btn{min-height:40px}.actions>.btn{min-height:40px}.providers label{min-width:100px}.section-head{margin-bottom:14px}}
@media(prefers-reduced-motion:reduce){*{transition:none!important}.btn:active{transform:none}}
</style></head><body>
<header class="topbar"><div class="brand"><span class="word">SintBot</span><span class="ver">${String(version).replace(/[&<>"\']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])}</span></div><div class="toolbar"><label><span data-i18n="appearance">外观</span><select id="theme" aria-label="Appearance"><option value="system" data-i18n="systemTheme">跟随系统</option><option value="light" data-i18n="lightTheme">亮色</option><option value="dark" data-i18n="darkTheme">暗色</option></select></label><label><span>Language</span><select id="language" aria-label="Language"><option value="en">English</option><option value="zh">简体中文</option></select></label></div></header>
<main class="wrap"><div class="setup">
<aside class="intro"><h1 data-i18n="title">连接你的项目</h1><p class="sub" data-i18n="intro">选好项目与执行器，接入飞书后就能在群里交代任务。</p><ol class="steps"><li class="active"><span class="step-num">1</span><div><strong data-i18n="step1">配置项目</strong><small data-i18n="step1Note">选择工作目录与执行器</small></div></li><li><span class="step-num">2</span><div><strong data-i18n="step2">飞书扫码</strong><small data-i18n="step2Note">用手机确认授权</small></div></li><li><span class="step-num">3</span><div><strong data-i18n="step3">开始使用</strong><small data-i18n="step3Note">自动建群，发送第一条任务</small></div></li></ol><p class="local-note" data-i18n="localHint">也可以先在本机对话，之后再接飞书。</p></aside>
<section class="card" id="form"><div class="section-head"><h2 data-i18n="projectHeading">项目设置</h2><p class="hint" data-i18n="projectIntro">它将在这个目录里处理你的任务。</p></div>
<div class="field"><label class="f" for="name" data-i18n="name">项目名称</label><input type="text" id="name" value="sintbot" autocomplete="off" aria-describedby="projectRoot"><div class="hint" id="projectRoot"><span data-i18n="rootBefore">新项目保存在</span> <span class="mono" id="root"></span><span data-i18n="rootAfter"></span></div>
<details class="folder" id="folderDetails"><summary data-i18n="existingFolder">使用已有项目目录</summary><div class="folder-body"><label class="f" for="workdir" data-i18n="workdir">项目目录（绝对路径）</label><input type="text" id="workdir" placeholder="/Users/you/Projects/my-app" autocomplete="off"></div></details></div>
<div class="field"><div class="field-label" id="executorLabel" data-i18n="executor">执行器</div><div class="providers" id="providers" role="group" aria-labelledby="executorLabel"></div><p class="hint" data-i18n="modelHint">自动采用推荐型号与思考深度，之后可在控制台调整。</p></div>
<details class="folder advanced" id="advancedDetails"><summary data-i18n="advanced">组织接入选项</summary><label class="check"><input type="checkbox" id="basic"><span data-i18n="basic">我不是组织管理员</span></label><p class="hint" data-i18n="basicHint">跳过应用发布，稍后由管理员完成。</p></details>
<div class="field"><label class="f" for="channel" data-i18n="channel">聊天平台</label><select id="channel" class="btn"><option value="feishu">飞书 · Feishu</option><option value="wecom">企业微信 · WeCom</option></select></div>
<div id="wecomFields" class="hidden"><p class="hint" data-i18n="wecomGuide">在企业微信工作台创建智能机器人，选择 API 模式和长连接。</p><p class="hint"><a href="https://work.weixin.qq.com/" target="_blank" rel="noopener noreferrer" data-i18n="wecomOpen">打开企业微信</a></p><div class="field"><label class="f" for="wecomBotId">Bot ID</label><input id="wecomBotId" type="text" autocomplete="off" spellcheck="false"></div><div class="field"><label class="f" for="wecomSecret">Secret</label><input id="wecomSecret" type="password" autocomplete="off" spellcheck="false"><p class="hint" data-i18n="wecomSecretHint">仅保存在这台 Mac，不要发送到群里。</p></div></div>
<div class="actions"><button class="btn primary" id="start" disabled data-i18n="start">扫码连接飞书</button><p class="action-note" data-i18n="teamHint">需要飞书企业或团队身份</p><button class="btn secondary" id="startLocal" disabled data-i18n="localStart">先在本机使用</button></div><div class="error" id="formErr" role="alert"></div></section>
<section class="card hidden" id="run"><div class="run-head"><h2 class="status" id="status" role="status" aria-live="polite">Preparing…</h2><button class="btn" id="cancel" data-i18n="cancel">取消</button></div><p class="run-summary" id="runSummary"></p><div class="qr" id="qr"></div><div class="defaults hidden" id="modelDefaults"></div>
<div id="chat" class="hidden state-actions"><label class="hint" for="chatId" data-i18n="chatHint">自动建群未完成，请输入已有群 ID。</label><div class="row"><input type="text" id="chatId" placeholder="oc_…"><button class="btn primary" id="resume" data-i18n="resume">继续</button></div></div>
<div id="retry" class="hidden state-actions"><div class="row"><button class="btn" id="back" data-i18n="back">修改设置</button><button class="btn primary" id="again" data-i18n="again">重试</button></div></div>
<div id="chatBack" class="hidden state-actions"><button class="btn" id="back2" data-i18n="back2">返回项目设置</button></div>
<div id="doneBox" class="hidden"><p class="hint" data-i18n="doneHint">接入完成，正在打开控制台。</p></div>
<details class="progress-details" id="progressDetails"><summary data-i18n="progressDetails">查看接入详情</summary><div class="log" id="log"></div></details></section>
</div><footer class="footer"><span data-i18n="footerLocal">由这台 Mac 执行任务</span><span data-i18n="footerSettings">接入后可在控制台调整设置</span></footer></main>
<script>
(function(){
const $=s=>document.querySelector(s);
const translate=${translateSetupNotice.toString()};
const words={en:{channel:'Chat platform',wecomGuide:'In WeCom Workbench, create a smart bot in API mode and select long connection.',wecomOpen:'Open WeCom',wecomSecretHint:'Saved on this Mac only. Do not send this secret to a group.',wecomStart:'Connect WeCom',wecomWait:'Add the bot to your group and @mention it to connect this project.',wecomDone:'WeCom is connected. Send your next task in the group.',modelHint:'Uses the live recommended model and thinking depth; adjust them later.',modelDefaults:'New group defaults',thinking:'thinking depth',title:'Connect your project',intro:'Choose a project, executor and chat platform to send tasks from your group.',step1:'Project',step2:'Connect',step3:'Ready',name:'Project name',rootBefore:'New projects are saved in',rootAfter:'',workdir:'Project folder (absolute path)',executor:'Executor',executorHint:'Choose if both are installed. A single available executor is selected automatically.',basic:'I am not an organization administrator',basicHint:'Skip availability changes and app publication. An administrator can finish them later.',start:'Connect Feishu',cancel:'Cancel',chatHint:'The group could not be created automatically. Create a Feishu group, add the bot, then paste its group ID (oc_…) here:',resume:'Continue',back:'Edit details',again:'Retry',back2:'Back to project details',doneHint:'Feishu is connected. Opening the console; send your first task in the new group.',noRunner:'No available executor was detected. Install Codex or Claude Code and sign in, then reopen this page.',waiting:'Waiting for scan confirmation…',preparing:'Preparing…',chat:'Create a group to continue',done:'Connected',failed:'Setup did not complete',init:'Retry initialization',launching:'Connected. Starting the console…',switching:'Opening the console…',cannotCancel:'This step cannot be cancelled yet. Please wait.',cancelling:'Cancelling at the next step boundary…',offline:'Cannot reach setup. Check that SintBot is still running, then reload this page.',handoffFailed:'The console did not become ready. Check the terminal for a startup error, then reload this page.',retryConnection:'Reload page',requestFailed:'The request failed. Please retry.',localHint:'You can also start with a local conversation and connect Feishu later.',localStart:'Use on this Mac first',localPreparing:'Setting up your conversation…',localDone:'Ready',localLaunching:'Ready. Opening the console…',localDoneHint:'Your configuration is saved. This page will open the console; go to Chat and ask it to read the first line of README.',step1Note:'Choose a folder and executor',step2Note:'Confirm with Feishu on your phone',step3Note:'Create a group and send a task',projectHeading:'Project settings',projectIntro:'Tasks run in this project folder.',existingFolder:'Use an existing project folder',advanced:'Organization options',teamHint:'A Feishu company or team account is required',appearance:'Appearance',systemTheme:'System',lightTheme:'Light',darkTheme:'Dark',footerLocal:'Tasks run on this Mac',footerSettings:'Adjust settings later in the console',progressDetails:'Connection details',scanHint:'Scan with Feishu on your phone and confirm.',progressHint:'Keep this window open while setup finishes.',localProgressHint:'Preparing your project and local conversation.'},
zh:{channel:'聊天平台',wecomGuide:'在企业微信工作台创建智能机器人，选择 API 模式和长连接。',wecomOpen:'打开企业微信',wecomSecretHint:'仅保存在这台 Mac，不要发送到群里。',wecomStart:'连接企业微信',wecomWait:'将机器人添加到目标群，并在群里 @机器人 发送“连接”。',wecomDone:'企业微信已接入，回到群里发送下一条任务。',modelHint:'实时采用推荐型号与思考深度，之后可在控制台调整。',modelDefaults:'新群默认',thinking:'思考深度',title:'连接你的项目',intro:'选好项目、执行器与聊天平台，就能在群里交代任务。',step1:'配置项目',step2:'连接平台',step3:'开始使用',name:'项目名称',rootBefore:'新项目保存在',rootAfter:'',workdir:'项目目录（绝对路径）',executor:'执行器',executorHint:'两个都装了才需要选；只装了一个会自动用它。',basic:'我不是组织管理员',basicHint:'跳过可用范围调整与应用发布，稍后由管理员完成。',start:'扫码连接飞书',cancel:'取消',chatHint:'自动建群没有成功。请在飞书里手动建一个群，把机器人拉进去，复制群 ID（oc_…）粘贴到这里继续：',resume:'继续',back:'返回修改',again:'重试',back2:'返回项目设置',doneHint:'飞书已接入，正在打开控制台；去新群里交代第一条任务吧。',noRunner:'未检测到可用执行器，请先安装 Codex 或 Claude Code 并登录，再重新打开此页面。',waiting:'等待扫码确认…',preparing:'正在准备…',chat:'需要你手动建群',done:'接入完成',failed:'接入没有完成',init:'重试初始化',launching:'接入完成，正在启动控制台…',switching:'正在切换到控制台…',cannotCancel:'现在这一步不能取消，请稍等。',cancelling:'正在取消，等待当前步骤结束…',offline:'暂时无法连接接入页。请确认 SintBot 仍在运行，然后刷新页面。',handoffFailed:'控制台未能就绪，请查看终端中的启动错误后刷新页面。',retryConnection:'刷新页面',requestFailed:'请求失败，请重试。',localHint:'也可以先在本机对话，之后再接飞书。',localStart:'先在本机使用',localPreparing:'正在准备本机对话…',localDone:'准备好了',localLaunching:'准备好了，正在打开控制台…',localDoneHint:'配置已写好。这一页几秒后会切到控制台；到「对话」里发「读取 README 第一行」试试。',step1Note:'选择工作目录与执行器',step2Note:'用手机飞书确认授权',step3Note:'自动建群，发送第一条任务',projectHeading:'项目设置',projectIntro:'它将在这个目录里处理你的任务。',existingFolder:'使用已有项目目录',advanced:'组织接入选项',teamHint:'需要飞书企业或团队身份',appearance:'外观',systemTheme:'跟随系统',lightTheme:'亮色',darkTheme:'暗色',footerLocal:'由这台 Mac 执行任务',footerSettings:'接入后可在控制台调整设置',progressDetails:'查看接入详情',scanHint:'用手机飞书扫描二维码，并确认授权。',progressHint:'正在完成接入，请保持窗口打开。',localProgressHint:'正在准备项目和本机对话。'}};
let lang='en';try{const saved=localStorage.getItem('sbot-lang');lang=saved==='zh'||saved==='en'?saved:(navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en'}catch(e){lang=(navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en'}
const t=k=>words[lang][k]??k;
const api=async(p,b)=>{const r=await fetch(p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(5000)}:{cache:'no-store',signal:AbortSignal.timeout(5000)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||String(r.status));return j};
let last=null,timer=null,formError='',actionError='',actionKey='',polling=false,handoffStarted=false;
function displayError(error){return translate(error&&error.message||String(error),lang)||t('requestFailed')}
function renderForm(st){$('#root').textContent=st.defaults.projectsRoot;const box=$('#providers');const chosen=document.querySelector('input[name=prov]:checked')?.value;box.replaceChildren();const avail=Object.keys(st.runners||{}).filter(k=>st.runners[k]);$('#start').disabled=!avail.length;$('#startLocal').disabled=!avail.length;
 if(!avail.length){const hint=document.createElement('span');hint.className='hint';hint.style.color='var(--fail)';hint.textContent=t('noRunner');box.appendChild(hint);return}
 if(avail.length===1){const badge=document.createElement('span');badge.className='provider-only';badge.textContent=avail[0]==='claude'?'Claude Code':'Codex';box.appendChild(badge);return}
 for(const r of avail){const l=document.createElement('label'),radio=document.createElement('input');radio.type='radio';radio.name='prov';radio.value=r;radio.checked=r===(chosen||avail[0]);l.append(radio,document.createTextNode(' '+(r==='claude'?'Claude Code':'Codex')));box.appendChild(l)}}
function restore(st){if(!st.input)return;$('#name').value=st.input.name||'sintbot';$('#workdir').value=st.input.workdir||'';$('#basic').checked=!!st.input.basic;if(st.input.workdir)$('#folderDetails').open=true;if(st.input.basic)$('#advancedDetails').open=true;if(st.input.provider){const r=document.querySelector('input[name=prov][value="'+st.input.provider+'"]');if(r)r.checked=true}}
function render(st){if(st.phase==='done')$('#wecomSecret').value='';const previous=last?.phase;last=st;const phaseStep=st.phase==='form'?0:st.mode==='local'||st.phase==='done'||st.appId?2:1;document.querySelectorAll('.steps li').forEach((el,i)=>{el.classList.toggle('active',i===phaseStep);el.classList.toggle('complete',i<phaseStep)});if(st.phase!=='running')actionKey='';const running=st.phase!=='form';$('#form').classList.toggle('hidden',running);$('#run').classList.toggle('hidden',!running);$('#formErr').textContent=formError?translate(formError,lang):'';if(!running)return;
 const local=st.mode==='local',wecom=st.mode==='wecom';$('#runSummary').textContent=st.phase==='failed'?translate(st.notice||st.lines.at(-1)||'',lang):t(wecom?'wecomWait':local?'localProgressHint':st.qr?'scanHint':'progressHint');if((st.phase==='failed'&&previous!=='failed')||actionError||actionKey)$('#progressDetails').open=true;$('#status').textContent=t(st.phase==='running'?(local?'localPreparing':st.qr?'waiting':'preparing'):st.phase==='waitingChat'?'chat':st.phase==='done'?(local?'localDone':'done'):'failed');
 const dh=document.querySelector('#doneBox [data-i18n]');if(dh){dh.dataset.i18n=wecom?'wecomDone':local?'localDoneHint':'doneHint';dh.textContent=t(dh.dataset.i18n)}
 $('#modelDefaults').classList.toggle('hidden',!st.modelDefaults);$('#modelDefaults').textContent=st.modelDefaults?t('modelDefaults')+': '+(st.modelDefaults.name||st.modelDefaults.model)+' · '+t('thinking')+': '+st.modelDefaults.effort:'';
 $('#status').className='status '+st.phase;$('#qr').innerHTML=st.phase==='running'&&st.qr?st.qr:'';$('#log').textContent=st.lines.map(l=>translate(l,lang)).concat(actionKey?[t(actionKey)]:actionError?[translate(actionError,lang)]:[]).join('\n');$('#log').scrollTop=1e9;
 $('#cancel').classList.toggle('hidden',st.phase!=='running');$('#chat').classList.toggle('hidden',st.phase!=='waitingChat');$('#chatBack').classList.toggle('hidden',st.phase!=='waitingChat');$('#retry').classList.toggle('hidden',st.phase!=='failed');$('#doneBox').classList.toggle('hidden',st.phase!=='done');$('#again').textContent=t(st.initOnly?'init':'again')}
function setLanguage(value){lang=value==='zh'?'zh':'en';$('#language').value=lang;document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.title='SintBot · '+(lang==='zh'?'项目接入':'Project setup');document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n)});if(last){renderForm(last);render(last)}updateChannel();try{localStorage.setItem('sbot-lang',lang)}catch(e){}}
$('#language').onchange=()=>setLanguage($('#language').value);setLanguage(lang);
const media=matchMedia('(prefers-color-scheme:dark)');let theme='system';try{theme=localStorage.getItem('sbot-theme')||'system'}catch(e){}
function applyTheme(){document.documentElement.dataset.theme=theme==='system'?(media.matches?'dark':'light'):theme;$('#theme').value=theme;}
if(!['system','light','dark'].includes(theme))theme='system';applyTheme();media.addEventListener('change',applyTheme);$('#theme').onchange=()=>{theme=$('#theme').value;try{localStorage.setItem('sbot-theme',theme)}catch(e){}applyTheme()};
// A valid console response must be HTML without the setup marker. A failed
// request can mean normal handoff or a stopped process; the wait is bounded.
async function handoff(){if(handoffStarted)return;handoffStarted=true;clearInterval(timer);$('#status').textContent=t(last?.phase==='done'?(last.mode==='local'?'localLaunching':'launching'):'switching');for(let i=0;i<60;i++){try{const r=await fetch('/',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(r.ok&&/text\/html/.test(r.headers.get('content-type')||'')){const html=await r.text();if(!html.includes('data-sintbot-setup=')&&html.includes('<html')){location.replace('/');return}}}catch(e){}await new Promise(r=>setTimeout(r,2000))}actionError=t('handoffFailed');$('#progressDetails').open=true;$('#status').textContent=t('failed');$('#log').textContent+='\n'+actionError;const reload=document.createElement('button');reload.className='btn';reload.textContent=t('retryConnection');reload.onclick=()=>location.reload();$('#run').appendChild(reload)}
let gone=0;async function poll(){if(polling||handoffStarted)return;polling=true;try{const st=await api('/api/setup/state');if(!st.phase){await handoff();return}gone=0;if(!last){renderForm(st);restore(st)}formError='';render(st);if(st.phase==='done')void handoff()}catch(e){if(last&&last.phase!=='form'&&++gone>=2)void handoff();else if(!last||last.phase==='form'){formError=t('offline');$('#formErr').textContent=formError}}finally{polling=false}}
async function start(extra){formError='';actionError='';actionKey='';$('#formErr').textContent='';const prov=document.querySelector('input[name=prov]:checked');const input={name:$('#name').value.trim(),workdir:$('#workdir').value.trim(),provider:prov?prov.value:'',basic:$('#basic').checked,...extra};
 try{const r=await api('/api/setup/start',input);render(r.state)}catch(e){formError=e.message;actionError=e.message;if(last)render(last);else $('#formErr').textContent=displayError(e)}}
async function startLocal(){formError='';actionError='';actionKey='';$('#formErr').textContent='';const prov=document.querySelector('input[name=prov]:checked');
 try{const r=await api('/api/setup/local',{name:$('#name').value.trim(),workdir:$('#workdir').value.trim(),provider:prov?prov.value:''});render(r.state)}catch(e){formError=e.message;actionError=e.message;if(last)render(last);else $('#formErr').textContent=displayError(e)}}
function updateChannel(){const wecom=$('#channel').value==='wecom';$('#wecomFields').classList.toggle('hidden',!wecom);$('.advanced').classList.toggle('hidden',wecom);$('.action-note').classList.toggle('hidden',wecom);$('#start').textContent=t(wecom?'wecomStart':'start');document.querySelector('[data-i18n=step2Note]').textContent=wecom?t('wecomWait'):t('step2Note');document.querySelector('[data-i18n=step3Note]').textContent=wecom?t('wecomDone'):t('step3Note');}
$('#channel').onchange=updateChannel;
async function startWecom(){formError='';actionError='';actionKey='';const prov=document.querySelector('input[name=prov]:checked');try{const r=await api('/api/setup/wecom',{name:$('#name').value.trim(),workdir:$('#workdir').value.trim(),provider:prov?prov.value:'',botId:$('#wecomBotId').value.trim(),secret:$('#wecomSecret').value});render(r.state)}catch(e){formError=e.message;actionError=e.message;if(last)render(last)}}
$('#startLocal').onclick=startLocal;
$('#start').onclick=()=>$('#channel').value==='wecom'?startWecom():start({});$('#again').onclick=()=>(last&&last.mode==='wecom'?startWecom():last&&last.mode==='local'?startLocal():start({}));$('#resume').onclick=()=>start({chatId:$('#chatId').value.trim()});
$('#cancel').onclick=async()=>{try{const r=await api('/api/setup/cancel',{});actionKey=r.ok?'cancelling':'cannotCancel';render(last)}catch(e){actionError=e.message;render(last)}};
const back=async()=>{try{await api('/api/setup/reset',{});formError='';actionError='';actionKey='';render(await api('/api/setup/state'))}catch(e){actionError=e.message;render(last)}};$('#back').onclick=back;$('#back2').onclick=back;
api('/api/setup/state').then(st=>{renderForm(st);restore(st);render(st)}).catch(e=>{formError=t('offline');$('#formErr').textContent=formError});timer=setInterval(poll,1500);
})();
</script></body></html>`
}

module.exports = { createSetupServer, createSetupSession, probeRunners, setupPage, svgOf, translateSetupNotice }
