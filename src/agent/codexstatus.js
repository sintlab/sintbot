// Codex subscription introspection — login status + rate-limit (quota) usage, for the
// console's codex model card. Two headless probes, neither needs an API key:
//   loginStatus() → `codex login status` (exit 0 = logged in; prints the auth mode)
//   rateLimits()  → short-lived `codex app-server` JSON-RPC (newline-framed over stdio):
//                   initialize → initialized → account/rateLimits/read → quit.
// The exec event stream can't carry rate limits (exec responses lack the x-codex-*
// headers, openai/codex#14728), so app-server is the only headless source. Protocol
// shape confirmed against a working driver; exact behaviour is verified on the target
// machine. Both return best-effort and never throw.

const { spawn } = require('node:child_process')
const { IS_WIN, resolveSpawn } = require('./winexec')

// `codex login status` output → { loggedIn, mode }. The line typically reads
// "Logged in using ChatGPT" (subscription) or mentions an API key.
function parseLoginStatus(stdout, code) {
  const text = (stdout || '').trim()
  let mode = ''
  if (/chatgpt/i.test(text)) mode = 'chatgpt'
  else if (/api[\s-]?key/i.test(text)) mode = 'apikey'
  return { loggedIn: code === 0, mode, text: text.slice(0, 200) }
}

function loginStatus(bin = 'codex', timeoutMs = 8000) {
  return new Promise((resolve) => {
    const { file, spawnArgs } = resolveSpawn(bin, ['login', 'status'])
    let out = '', err = '', settled = false
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    const child = spawn(file, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true })
    const timer = setTimeout(() => { try { child.kill() } catch {} done({ ok: false, error: 'timeout' }) }, timeoutMs)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => done({ ok: false, error: e.code === 'ENOENT' ? "'codex' not found on PATH" : e.message }))
    child.on('close', (code) => done({ ok: true, ...parseLoginStatus(out || err, code) }))
  })
}

// TTL 缓存(与 claudestatus 同款):doctor 是一次性的,但控制台 /api/state 每次动作 + 60s 自动刷新
// 都会重建健康行,每次都 spawn 一个进程没必要。
const LOGIN_CACHE = new Map() // bin -> { at, val }
async function cachedLoginStatus(bin = 'codex', ttl = 60_000) {
  const c = LOGIN_CACHE.get(bin)
  if (c && Date.now() - c.at < ttl) return c.val
  const val = await loginStatus(bin)
  LOGIN_CACHE.set(bin, { at: Date.now(), val })
  return val
}
function clearLoginCache() { LOGIN_CACHE.clear() }

// account/rateLimits/read response → compact usage. Windows: primary = 5h rolling
// window, secondary = weekly (see docs/CODEX-RUNNER.md). resetsAt is an epoch (secs).
function mapRateLimits(result) {
  const rl = result && result.rateLimits
  if (!rl) return null
  const w = (x) => (x && typeof x.usedPercent === 'number')
    ? { usedPercent: x.usedPercent, windowMins: x.windowDurationMins, resetsAt: x.resetsAt } : null
  const out = { primary: w(rl.primary), secondary: w(rl.secondary), planType: rl.planType || '' }
  if (rl.credits) out.credits = { balance: rl.credits.balance, hasCredits: !!rl.credits.hasCredits, unlimited: !!rl.credits.unlimited }
  return (out.primary || out.secondary || out.credits) ? out : null
}

function killTree(child) {
  if (!child || !child.pid) return
  if (IS_WIN) { try { spawn('taskkill', ['/pid', String(child.pid), '/t', '/f'], { stdio: 'ignore', windowsHide: true }) } catch {} }
  else { try { child.kill('SIGKILL') } catch {} }
}

// Generic short-lived `codex app-server` JSON-RPC call: initialize → initialized →
// <method> → map → quit. One JSON object per line. Returns mapped value or null
// (never throws). Cache results upstream — each call spawns a process and may hit
// the ChatGPT backend.
function appServerCall(bin, method, params, mapFn, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let child
    try {
      const { file, spawnArgs } = resolveSpawn(bin, ['app-server'])
      child = spawn(file, spawnArgs, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch { return resolve(null) }

    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); killTree(child); resolve(v) }
    const timer = setTimeout(() => finish(null), timeoutMs)
    child.on('error', () => finish(null))
    child.stdin.on('error', () => {})

    const send = (obj) => { try { child.stdin.write(JSON.stringify(obj) + '\n') } catch {} }
    const INIT_ID = 1, CALL_ID = 2
    send({ jsonrpc: '2.0', id: INIT_ID, method: 'initialize', params: { clientInfo: { name: 'sbot', title: 'sbot', version: '0.1.0' }, capabilities: { experimentalApi: true } } })

    let buf = ''
    child.stdout.on('data', (chunk) => {
      buf += chunk.toString('utf8')
      let nl
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim(); buf = buf.slice(nl + 1)
        if (!line) continue
        let msg; try { msg = JSON.parse(line) } catch { continue }
        // Responses carry id + result/error and NO method; ignore notifications /
        // server→client requests (none expected without a running turn).
        if (msg.method) continue
        if (msg.id === INIT_ID) { send({ jsonrpc: '2.0', method: 'initialized' }); send({ jsonrpc: '2.0', id: CALL_ID, method, params: params || {} }) }
        else if (msg.id === CALL_ID) return finish(msg.error ? null : mapFn(msg.result))
      }
    })
  })
}

// Subscription rate limits (5h/weekly windows) — see mapRateLimits.
function rateLimits(bin = 'codex', timeoutMs = 12000) {
  return appServerCall(bin, 'account/rateLimits/read', {}, mapRateLimits, timeoutMs)
}

// model/list 响应 → 精简模型清单(过滤 hidden;efforts 兼容字符串/对象两形)。
// 空/坏返回 → null(上游回退内置预设)。协议 v2,codex 0.144.3 真机验证(2026-07)。
function mapModels(result) {
  const data = (result && result.data) || []
  const out = []
  for (const x of data) {
    if (!x || x.hidden || !(x.model || x.id)) continue
    out.push({
      model: x.model || x.id,
      name: x.displayName || x.model || x.id,
      desc: x.description || '',
      isDefault: !!x.isDefault,
      efforts: Array.isArray(x.supportedReasoningEfforts)
        ? x.supportedReasoningEfforts.map((e) => (e && e.reasoningEffort) || e).filter((e) => typeof e === 'string')
        : [],
      defEffort: x.defaultReasoningEffort || '',
    })
  }
  return out.length ? out : null
}

// 当前账号可用的 codex 模型(控制台 codex 面板下拉的数据源)。
function listModels(bin = 'codex', timeoutMs = 12000) {
  return appServerCall(bin, 'model/list', {}, mapModels, timeoutMs)
}

// 探测不到(未登录/老版本/超时)时的内置预设 —— 2026-07 实测自 codex 0.144.3 的
// model/list 真实返回;随 sbot 版本按需更新。UI 恒留「自定义」逃生口。
// ⚠ efforts 已剔除 'ultra':model/list 把它列进 sol/terra,但服务端不认 —— 2026-07-20
// 真机用非法值触发参数校验拿到权威合法集:'none','minimal','low','medium','high','xhigh','max'。
// 前端另有 RE_LEGAL 兜底过滤(live 探测结果同样会带 ultra,源头改不了)。
const PRESET_MODELS = [
  { model: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', desc: 'Latest frontier agentic coding model.', isDefault: true, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defEffort: 'low' },
  { model: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', desc: 'Balanced agentic coding model for everyday work.', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defEffort: 'medium' },
  { model: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', desc: 'Fast and affordable agentic coding model.', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh', 'max'], defEffort: 'medium' },
  { model: 'gpt-5.5', name: 'GPT-5.5', desc: 'Frontier model for complex coding and research.', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defEffort: 'medium' },
  { model: 'gpt-5.4', name: 'GPT-5.4', desc: 'Strong model for everyday coding.', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defEffort: 'medium' },
  { model: 'gpt-5.4-mini', name: 'GPT-5.4-Mini', desc: 'Small, fast, and cost-efficient.', isDefault: false, efforts: ['low', 'medium', 'high', 'xhigh'], defEffort: 'medium' },
]

// A window's label DERIVED from its duration, not its position. Codex changed the shape:
// a window that used to sit in `primary` as 5h (≈300min) now arrives as the weekly window
// (10080min) with `secondary: null`, so the old positional `primary='5h'` mislabeled a
// weekly window as "5h". Read windowMins instead: ~300 ⇒ "5h", 10080 ⇒ "周".
// 窗口名(v0.11.8 起用于紧凑格式 `7d:12%`,故周窗口标 7d 而非「周」,与 Claude 卡一致)
function windowLabel(mins) {
  if (!mins) return '窗口'
  if (mins >= 1440) return `${Math.round(mins / 1440)}d`
  return `${Math.round(mins / 60)}h`
}

// Mapped rate-limits → a compact one-line string for the group's /hud reply.
// Mirrors the console's fmtUsage (client-side) but runs in the daemon.
// Date.now() is real here (Node), so the reset countdown is live.
// 紧凑一行(v0.11.8 与 Claude 卡同口径):`5h:98% (1.8h) │ 7d:12% (6.1d)`。
// ⚠ **百分比是「已用」不是「剩余」** —— 这里是群内 /hud 对 codex 群的实际渲染,与
// claudeusage.formatClaudeUsage / console 的 fmtUsage / usage.js 的 minimax 行必须同口径,
// 漏改任何一处就会出现同一个数字两种含义(98% 既可能是快满也可能是还剩很多)。
function formatUsage(u) {
  if (!u) return null
  const dur = (ms) => { const trim = (v) => (v < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v))); const h = ms / 3600e3; if (h >= 24) return `${trim(h / 24)}d`; if (h >= 1) return `${trim(h)}h`; return `${Math.max(1, Math.round(ms / 60e3))}m` }
  const reset = (w) => { if (!w || w.resetsAt == null) return ''; const ms = w.resetsAt > 1e9 ? w.resetsAt * 1000 - Date.now() : w.resetsAt * 1000; return (ms > 0 && ms < 9 * 864e5) ? ` (${dur(ms)})` : '' }
  const win = (w) => w ? `${windowLabel(w.windowMins)}:${Math.min(100, Math.max(0, Math.round(w.usedPercent || 0)))}%${reset(w)}` : ''
  const parts = [win(u.primary), win(u.secondary)].filter(Boolean)
  if (u.credits && u.credits.hasCredits && u.credits.balance != null) parts.push(`credits ${u.credits.balance}`)
  return parts.join(' │ ') || null
}

module.exports = { loginStatus, cachedLoginStatus, clearLoginCache, rateLimits, listModels, parseLoginStatus, mapRateLimits, mapModels, formatUsage, windowLabel, PRESET_MODELS }
