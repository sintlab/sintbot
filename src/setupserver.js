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
const { runConnect, qrPage, probeRunners: connectProbe, EXIT_INTERRUPTED } = require('./connect')

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
function createSetupSession({ configFile, dataDir, home, version, runners, connect = runConnect, deps = {},
  initialize = (file, options) => require('./c2install').initializeInstallation(file, options), log = () => {} }) {
  const state = {
    phase: 'form',            // form | running | waitingChat | done | failed
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
    state.phase = 'form'; state.lines = []; state.qr = null; state.notice = ''
    return true
  }

  const snapshot = () => ({ ...state, lines: state.lines.slice(-60) })
  void EXIT_INTERRUPTED
  return { state, snapshot, start, cancel, reset, completed, wait: () => current }
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
  if (lang === 'zh' && /^Could not read live model defaults for /.test(line)) return '无法读取执行器实时推荐的型号和思考深度。请检查执行器登录和网络后重试；本次没有新建飞书应用。'
  if (lang === 'zh' && /^The live model catalog did not provide/.test(line)) return '实时模型清单没有提供有效的型号和思考深度，请检查执行器登录后重试。'
  if (lang === 'zh') return line.replace(/然后执行 sintbot connect.*$/, '然后在此页面填写群 ID 并继续。')
    .replace(/重新执行 sintbot connect(?: --app-id \S+)?[。]?/g, '在此页面重试。')
    .replace(/可手动执行 sintbot init 重试。/, '请点击「重试初始化」。')
  const exact = {
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
    '连接完成。': 'Connected.', '连接完成，去飞书群里 @机器人 试试吧。': 'Connected. Send your first task to the bot in the Feishu group.',
  }
  if (exact[line]) return exact[line]
  let match
  if ((match = /^新群默认：(.*) · (.*?)。接入后可在控制台修改。$/.exec(line))) return `New group defaults: ${match[1]} · ${match[2]}. You can change them in the console after setup.`
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
:root{--ink:#1a1714;--muted:#6b6259;--line:#e6ded1;--line-hi:#d3c8b6;--paper:#faf8f4;--inset:rgba(26,23,20,.05);--copper:#a16b33;--copper-hi:#8a5a29;--fail:#e55934;--ok:#4d7c0f}
*{box-sizing:border-box}body{margin:0;background:var(--paper);color:var(--ink);font:13px/20px -apple-system,BlinkMacSystemFont,"SF Pro Text","PingFang SC","Hiragino Sans GB","Helvetica Neue",sans-serif;-webkit-font-smoothing:antialiased}
.wrap{max-width:560px;margin:0 auto;padding:32px 24px 48px}h1{font-size:18px;line-height:26px;font-weight:600;margin:0 0 4px}.sub{color:var(--muted);font-size:12px;line-height:18px;margin:0 0 16px}
.card{background:#fff;border:1px solid var(--line);border-radius:10px;padding:16px;margin-bottom:12px}
label.f{display:block;font-size:13px;font-weight:500;margin:14px 0 6px}input[type=text]{width:100%;height:32px;padding:0 10px;border:1px solid var(--line-hi);border-radius:6px;background:#fff;color:inherit;font:inherit;transition:border-color .15s,box-shadow .15s}
input[type=text]:focus{outline:none;border-color:var(--copper);box-shadow:0 0 0 3px rgba(161,107,51,.2)}input[type=checkbox],input[type=radio]{accent-color:var(--copper)}
select{height:28px;padding:0 6px;border:1px solid var(--line-hi);border-radius:6px;background:#fff;color:inherit;font:inherit}
.hint{color:var(--muted);font-size:12px;line-height:18px;margin:6px 0 0}.row{display:flex;gap:12px;flex-wrap:wrap;align-items:center}
.btn{display:inline-flex;align-items:center;height:32px;padding:0 14px;border-radius:6px;border:1px solid var(--line-hi);background:#fff;color:inherit;font:inherit;font-weight:500;cursor:pointer;transition:background-color .15s,border-color .15s}
.btn:hover:not(:disabled){border-color:var(--muted)}.btn.primary{background:var(--copper);border-color:var(--copper);color:#fff;font-weight:600}.btn.primary:hover:not(:disabled){background:var(--copper-hi);border-color:var(--copper-hi)}.btn:disabled{opacity:.45;cursor:default}
.btn:focus-visible,select:focus-visible,input[type=checkbox]:focus-visible,input[type=radio]:focus-visible{outline:2px solid var(--copper);outline-offset:2px}
.qr{display:flex;justify-content:center;padding:12px 0}.qr svg{width:min(260px,100%);height:auto;aspect-ratio:1}
.log{font-size:12px;line-height:18px;max-height:280px;overflow:auto;background:var(--inset);border-radius:6px;padding:10px 12px;white-space:pre-wrap;word-break:break-word}
.status{font-size:14px;font-weight:600}.status.failed{color:var(--fail)}.status.done{color:var(--ok)}
.steps{margin:0;padding-left:18px;color:var(--muted);font-size:12px;line-height:20px}.hidden{display:none}
@media(prefers-reduced-motion:reduce){*{transition:none!important}}
</style></head><body><div class="wrap">
<div class="row" style="justify-content:space-between"><h1 data-i18n="title">Connect your project to Feishu</h1><label class="hint">Language <select id="language" aria-label="Language"><option value="en">English</option><option value="zh">简体中文</option></select></label></div><p class="sub">SintBot ${String(version).replace(/[&<>"\']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])} · <span data-i18n="intro">This page is only available on this Mac. After you confirm the scan, setup creates the app, project folder and group, then saves your configuration.</span></p>

<div class="card" id="form">
  <ol class="steps"><li data-i18n="step1">Name a new project, or choose an existing folder</li><li data-i18n="step2">Scan with Feishu on your phone and confirm (a company or team account is required)</li><li data-i18n="step3">Wait for setup to create the app and group, then send your first task in the new group</li></ol>
  <label class="f" for="name" data-i18n="name">Project name</label><input type="text" id="name" value="sintbot" autocomplete="off">
  <div class="hint"><span data-i18n="rootBefore">A new folder with a README will be created under</span> <span id="root"></span><span data-i18n="rootAfter">.</span></div>
  <label class="f" for="workdir" data-i18n="workdir">Or use an existing project (absolute path; leave blank to create one)</label><input type="text" id="workdir" placeholder="/Users/you/Projects/my-app" autocomplete="off">
  <label class="f" data-i18n="executor">Executor</label>
  <div class="row" id="providers"></div>
  <div class="hint"><span data-i18n="executorHint">Choose if both are installed. A single available executor is selected automatically.</span></div>
  <div class="hint" data-i18n="modelHint">Before scanning, SintBot reads the executor’s live recommended model and thinking depth and saves them for the new group. You can change them in the console after setup.</div>
  <label class="f"><input type="checkbox" id="basic"> <span data-i18n="basic">I am not an organization administrator (basic setup)</span></label>
  <div class="hint"><span data-i18n="basicHint">Skip availability changes and publication. Ask an administrator to finish these steps in the Feishu developer console.</span></div>
  <div class="row" style="margin-top:18px"><button class="btn primary" id="start" disabled data-i18n="start">Start scan</button><span class="hint" id="formErr"></span></div>
</div>

<div class="card hidden" id="run">
  <div class="row" style="justify-content:space-between"><span class="status" id="status">Preparing…</span><button class="btn" id="cancel" data-i18n="cancel">Cancel</button></div>
  <div class="hint hidden" id="modelDefaults" style="margin:10px 0;overflow-wrap:anywhere"></div>
  <div class="qr" id="qr"></div>
  <div class="log" id="log"></div>
  <div id="chat" class="hidden">
    <div class="hint" style="margin-top:12px"><span data-i18n="chatHint">The group could not be created automatically. Create a Feishu group, add the bot, then paste its group ID (oc_…) here:</span></div>
    <div class="row" style="margin-top:8px"><input type="text" id="chatId" placeholder="oc_…" style="flex:1;min-width:0;width:100%"><button class="btn primary" id="resume" data-i18n="resume">Continue</button></div>
  </div>
  <div id="retry" class="hidden"><div class="row" style="margin-top:12px"><button class="btn" id="back" data-i18n="back">Edit details</button><button class="btn primary" id="again" data-i18n="again">Retry</button></div></div>
  <div id="chatBack" class="hidden"><div class="row" style="margin-top:8px"><button class="btn" id="back2" data-i18n="back2">Back to project details</button></div></div>
  <div id="doneBox" class="hidden"><div class="hint" style="margin-top:12px"><span data-i18n="doneHint">Your configuration is saved. SintBot is connecting to Feishu and this page will open the console. Try asking the bot in the new group to read the first line of README.</span></div></div>
</div>
</div>
<script>
(function(){
const $=s=>document.querySelector(s);
const translate=${translateSetupNotice.toString()};
const words={en:{modelHint:'Before scanning, SintBot reads the executor’s live recommended model and thinking depth and saves them for the new group. You can change them in the console after setup.',modelDefaults:'New group defaults',thinking:'thinking depth',title:'Connect your project to Feishu',intro:'This page is only available on this Mac. After you confirm the scan, setup creates the app, project folder and group, then saves your configuration.',step1:'Name a new project, or choose an existing folder',step2:'Scan with Feishu on your phone and confirm (a company or team account is required)',step3:'Wait for setup to create the app and group, then send your first task in the new group',name:'Project name',rootBefore:'A new folder with a README will be created under',rootAfter:'.',workdir:'Or use an existing project (absolute path; leave blank to create one)',executor:'Executor',executorHint:'Choose if both are installed. A single available executor is selected automatically.',basic:'I am not an organization administrator (basic setup)',basicHint:'Skip availability changes and publication. Ask an administrator to finish these steps in the Feishu developer console.',start:'Start scan',cancel:'Cancel',chatHint:'The group could not be created automatically. Create a Feishu group, add the bot, then paste its group ID (oc_…) here:',resume:'Continue',back:'Edit details',again:'Retry',back2:'Back to project details',doneHint:'Your configuration is saved. SintBot is connecting to Feishu and this page will open the console. Try asking the bot in the new group to read the first line of README.',noRunner:'No available executor was detected. Install Codex or Claude Code and sign in, then reopen this page.',waiting:'Waiting for scan confirmation…',preparing:'Preparing…',chat:'Create a group to continue',done:'Connected',failed:'Setup did not complete',init:'Retry initialization',launching:'Connected. Starting the console…',switching:'Opening the console…',cannotCancel:'This step cannot be cancelled yet. Please wait.',cancelling:'Cancelling at the next step boundary…',offline:'Cannot reach setup. Check that SintBot is still running, then reload this page.',handoffFailed:'The console did not become ready. Check the terminal for a startup error, then reload this page.',retryConnection:'Reload page',requestFailed:'The request failed. Please retry.'},
zh:{modelHint:'扫码前读取执行器实时推荐的型号和思考深度，并保存为新群的初始设置；接入后可在控制台修改。',modelDefaults:'新群默认',thinking:'思考深度',title:'把项目接进飞书',intro:'这一页只在这台 Mac 上可见。扫码确认后会自动创建机器人应用、项目目录和群，并写好配置。',step1:'填项目名，或选一个已有目录',step2:'用手机飞书扫码并确认（需要企业或团队身份）',step3:'等它自动建应用、建群、写配置，然后在新群里发第一条任务',name:'项目名',rootBefore:'会在',rootAfter:'下新建这个目录并放一份 README。',workdir:'或者接入已有项目（绝对路径，留空则按上面新建）',executor:'执行器',executorHint:'两个都装了才需要选；只装了一个会自动用它。',basic:'我不是组织管理员（精简接入）',basicHint:'跳过放开范围和发布版本，之后请管理员在开放平台补这两步。',start:'开始扫码',cancel:'取消',chatHint:'自动建群没有成功。请在飞书里手动建一个群，把机器人拉进去，复制群 ID（oc_…）粘贴到这里继续：',resume:'继续',back:'返回修改',again:'重试',back2:'返回项目设置',doneHint:'配置已写好，SintBot 正在连接飞书。这一页几秒后会切到控制台；去新群里发「读取 README 第一行」试试。',noRunner:'未检测到可用执行器，请先安装 Codex 或 Claude Code 并登录，再重新打开此页面。',waiting:'等待扫码确认…',preparing:'正在准备…',chat:'需要你手动建群',done:'接入完成',failed:'接入没有完成',init:'重试初始化',launching:'接入完成，正在启动控制台…',switching:'正在切换到控制台…',cannotCancel:'现在这一步不能取消，请稍等。',cancelling:'正在取消，等待当前步骤结束…',offline:'暂时无法连接接入页。请确认 SintBot 仍在运行，然后刷新页面。',handoffFailed:'控制台未能就绪，请查看终端中的启动错误后刷新页面。',retryConnection:'刷新页面',requestFailed:'请求失败，请重试。'}};
let lang='en';try{const saved=localStorage.getItem('sbot-lang');lang=saved==='zh'||saved==='en'?saved:(navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en'}catch(e){lang=(navigator.language||'').toLowerCase().startsWith('zh')?'zh':'en'}
const t=k=>words[lang][k]||k;
const api=async(p,b)=>{const r=await fetch(p,b?{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(b),signal:AbortSignal.timeout(5000)}:{cache:'no-store',signal:AbortSignal.timeout(5000)});const j=await r.json().catch(()=>({}));if(!r.ok)throw new Error(j.error||String(r.status));return j};
let last=null,timer=null,formError='',actionError='',actionKey='',polling=false,handoffStarted=false;
function displayError(error){return translate(error&&error.message||String(error),lang)||t('requestFailed')}
function renderForm(st){$('#root').textContent=st.defaults.projectsRoot;const box=$('#providers');const chosen=document.querySelector('input[name=prov]:checked')?.value;box.replaceChildren();const avail=Object.keys(st.runners||{}).filter(k=>st.runners[k]);$('#start').disabled=!avail.length;
 if(!avail.length){const hint=document.createElement('span');hint.className='hint';hint.style.color='var(--fail)';hint.textContent=t('noRunner');box.appendChild(hint);return}
 if(avail.length===1){box.textContent=avail[0]==='claude'?'Claude Code':'Codex';return}
 for(const r of avail){const l=document.createElement('label'),radio=document.createElement('input');radio.type='radio';radio.name='prov';radio.value=r;radio.checked=r===(chosen||avail[0]);l.append(radio,document.createTextNode(' '+(r==='claude'?'Claude Code':'Codex')));box.appendChild(l)}}
function restore(st){if(!st.input)return;$('#name').value=st.input.name||'sintbot';$('#workdir').value=st.input.workdir||'';$('#basic').checked=!!st.input.basic;if(st.input.provider){const r=document.querySelector('input[name=prov][value="'+st.input.provider+'"]');if(r)r.checked=true}}
function render(st){last=st;if(st.phase!=='running')actionKey='';const running=st.phase!=='form';$('#form').classList.toggle('hidden',running);$('#run').classList.toggle('hidden',!running);$('#formErr').textContent=formError?translate(formError,lang):'';if(!running)return;
 $('#status').textContent=t(st.phase==='running'?(st.qr?'waiting':'preparing'):st.phase==='waitingChat'?'chat':st.phase==='done'?'done':'failed');
 $('#modelDefaults').classList.toggle('hidden',!st.modelDefaults);$('#modelDefaults').textContent=st.modelDefaults?t('modelDefaults')+': '+(st.modelDefaults.name||st.modelDefaults.model)+' · '+t('thinking')+': '+st.modelDefaults.effort:'';
 $('#status').className='status '+st.phase;$('#qr').innerHTML=st.phase==='running'&&st.qr?st.qr:'';$('#log').textContent=st.lines.map(l=>translate(l,lang)).concat(actionKey?[t(actionKey)]:actionError?[translate(actionError,lang)]:[]).join('\n');$('#log').scrollTop=1e9;
 $('#cancel').classList.toggle('hidden',st.phase!=='running');$('#chat').classList.toggle('hidden',st.phase!=='waitingChat');$('#chatBack').classList.toggle('hidden',st.phase!=='waitingChat');$('#retry').classList.toggle('hidden',st.phase!=='failed');$('#doneBox').classList.toggle('hidden',st.phase!=='done');$('#again').textContent=t(st.initOnly?'init':'again')}
function setLanguage(value){lang=value==='zh'?'zh':'en';$('#language').value=lang;document.documentElement.lang=lang==='zh'?'zh-CN':'en';document.title='SintBot · '+(lang==='zh'?'接入飞书':'Connect Feishu');document.querySelectorAll('[data-i18n]').forEach(el=>{el.textContent=t(el.dataset.i18n)});if(last){renderForm(last);render(last)}try{localStorage.setItem('sbot-lang',lang)}catch(e){}}
$('#language').onchange=()=>setLanguage($('#language').value);setLanguage(lang);
// A valid console response must be HTML without the setup marker. A failed
// request can mean normal handoff or a stopped process; the wait is bounded.
async function handoff(){if(handoffStarted)return;handoffStarted=true;clearInterval(timer);$('#status').textContent=t(last?.phase==='done'?'launching':'switching');for(let i=0;i<60;i++){try{const r=await fetch('/',{cache:'no-store',signal:AbortSignal.timeout(3000)});if(r.ok&&/text\/html/.test(r.headers.get('content-type')||'')){const html=await r.text();if(!html.includes('data-sintbot-setup=')&&html.includes('<html')){location.replace('/');return}}}catch(e){}await new Promise(r=>setTimeout(r,2000))}actionError=t('handoffFailed');$('#status').textContent=t('failed');$('#log').textContent+='\n'+actionError;const reload=document.createElement('button');reload.className='btn';reload.textContent=t('retryConnection');reload.onclick=()=>location.reload();$('#run').appendChild(reload)}
let gone=0;async function poll(){if(polling||handoffStarted)return;polling=true;try{const st=await api('/api/setup/state');if(!st.phase){await handoff();return}gone=0;if(!last){renderForm(st);restore(st)}formError='';render(st);if(st.phase==='done')void handoff()}catch(e){if(last&&last.phase!=='form'&&++gone>=2)void handoff();else if(!last||last.phase==='form'){formError=t('offline');$('#formErr').textContent=formError}}finally{polling=false}}
async function start(extra){formError='';actionError='';actionKey='';$('#formErr').textContent='';const prov=document.querySelector('input[name=prov]:checked');const input={name:$('#name').value.trim(),workdir:$('#workdir').value.trim(),provider:prov?prov.value:'',basic:$('#basic').checked,...extra};
 try{const r=await api('/api/setup/start',input);render(r.state)}catch(e){formError=e.message;actionError=e.message;if(last)render(last);else $('#formErr').textContent=displayError(e)}}
$('#start').onclick=()=>start({});$('#again').onclick=()=>start({});$('#resume').onclick=()=>start({chatId:$('#chatId').value.trim()});
$('#cancel').onclick=async()=>{try{const r=await api('/api/setup/cancel',{});actionKey=r.ok?'cancelling':'cannotCancel';render(last)}catch(e){actionError=e.message;render(last)}};
const back=async()=>{try{await api('/api/setup/reset',{});formError='';actionError='';actionKey='';render(await api('/api/setup/state'))}catch(e){actionError=e.message;render(last)}};$('#back').onclick=back;$('#back2').onclick=back;
api('/api/setup/state').then(st=>{renderForm(st);restore(st);render(st)}).catch(e=>{formError=t('offline');$('#formErr').textContent=formError});timer=setInterval(poll,1500);
})();
</script></body></html>`
}

module.exports = { createSetupServer, createSetupSession, probeRunners, setupPage, svgOf, translateSetupNotice }
