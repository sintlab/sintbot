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
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { IS_WIN, resolveSpawn } = require('./winexec')
const { classifyError } = require('./privatecore') // 服务端拒绝原话 → 账号档(与出错轮同一张判据表,判据由内置核心统一提供)

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
  return appServerRaw(bin, method, params, timeoutMs).then((r) => (r && r.result !== undefined ? mapFn(r.result) : null))
}

// 同一条调用的**原始结果**:{ result } | { error:{code,message} } | { timedOut:true } | { spawnError:string }。
// 为什么要分开:服务端拒绝(401 令牌已吊销)和探不到(超时 / 没装)对调用方意义相反 —— 前者是「账号不可用」的铁证,
// 后者什么都不能说明。只有 null 一种失败的话,控制台和 doctor 共用的登录态探针(下面的 authProbe / cachedAuthProbe)
// 就分不出「令牌已被吊销」和「这会儿没探到」。
function appServerRaw(bin, method, params, timeoutMs = 12000) {
  return new Promise((resolve) => {
    let child
    try {
      const { file, spawnArgs } = resolveSpawn(bin, ['app-server'])
      child = spawn(file, spawnArgs, { stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true })
    } catch (e) { return resolve({ spawnError: (e && e.message) || 'spawn failed' }) }

    let settled = false
    const finish = (v) => { if (settled) return; settled = true; clearTimeout(timer); killTree(child); resolve(v) }
    const timer = setTimeout(() => finish({ timedOut: true }), timeoutMs)
    child.on('error', (e) => finish({ spawnError: e && e.code === 'ENOENT' ? `'${bin}' not found on PATH` : (e && e.message) || 'spawn error' }))
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
        else if (msg.id === CALL_ID) return finish(msg.error ? { error: { code: msg.error.code, message: String(msg.error.message || '') } } : { result: msg.result })
      }
    })
  })
}

// Subscription rate limits (5h/weekly windows) — see mapRateLimits.
function rateLimits(bin = 'codex', timeoutMs = 12000) {
  return appServerCall(bin, 'account/rateLimits/read', {}, mapRateLimits, timeoutMs)
}

// ── 登录态真判据 ──────────────────────────────────────────────────────────────────────────
// `codex login status` 只读本地文件:refresh token 被吊销后它照样打印「Logged in」,能静默坏上好几天
// (doctor / 控制台 / 它自己三处全绿,到有人用才 401)。真判据只有一条:**带着令牌去问一次服务端**。
// 额度接口(account/rateLimits/read)正好是这样一次询问 —— 零 token 消耗、2 秒;
// 令牌死了它回 401「token_revoked / invalidated oauth token」,与出错轮的账号判据(核心 classifyError)同一张表。
//
// judgeAuth(raw) 把原始结果归成三态(纯函数,单测钉死):
//   { verified:true,  ok:true,  usage }                          服务端认了这枚令牌(顺手把额度带回来)
//   { verified:true,  ok:false, dead:true, kind:'account', error } 服务端明确拒绝 —— 账号 / 登录态不可用
//   { verified:false, ok:false, error }                           探不到(超时 / 没装 / 别的错)—— **什么都不能说明**,不许当成不可用
function judgeAuth(raw) {
  if (!raw) return { verified: false, ok: false, error: 'no result' }
  if (raw.result !== undefined) return { verified: true, ok: true, usage: mapRateLimits(raw.result) }
  if (raw.error) {
    const msg = raw.error.message || ''
    const q = classifyError(msg)?.quota
    if (q && q.kind === 'account') return { verified: true, ok: false, dead: true, kind: 'account', error: msg.slice(0, 300) }
    return { verified: false, ok: false, error: msg.slice(0, 300) || `app-server error ${raw.error.code || ''}`.trim() }
  }
  if (raw.timedOut) return { verified: false, ok: false, error: 'timeout' }
  return { verified: false, ok: false, error: raw.spawnError || 'unknown' }
}

function authProbe(bin = 'codex', timeoutMs = 12000) {
  return appServerRaw(bin, 'account/rateLimits/read', {}, timeoutMs).then(judgeAuth)
}

// TTL 缓存(与 claudestatus.cachedLoginStatus 同款):doctor 一次性,控制台 /api/state 每次动作都会重建健康行。
// 同一个 bin 同时只跑一个探针(PENDING 记在途的那一个):冷缓存时并发进来的调用(概览 / 卡片自动验证 / doctor)
// 共用一个 app-server 进程,而不是各起一个。
const CACHE = new Map() // bin -> { at, val }
const PENDING = new Map() // bin -> Promise<judgeAuth 结果>
const TTL = 60_000
// 写缓存的唯一入口(cachedAuthProbe / peekAuthProbe / 控制台验证接口都经这里,规则一致):
// 服务端拒绝过令牌(dead)之后,「探不到」(未验证)**不许**把它洗掉 —— 那只说明这会儿连不上,不说明令牌好了;
// 只有服务端再给出明确答复(认可 ⇒ 换成已验证;再拒绝 ⇒ 仍是 dead)才换。时间戳照样更新:这次探过了,
// 已知最好的答案仍是 dead,不必每次都重探。认可态被「探不到」覆盖是原语义,不变。
function storeAuthProbe(bin, val) {
  const prev = CACHE.get(bin)
  const keep = prev && prev.val && prev.val.dead && !(val && val.verified)
  const next = keep ? prev.val : val
  CACHE.set(bin, { at: Date.now(), val: next })
  return next
}
function refreshAuthProbe(bin) {
  let p = PENDING.get(bin)
  if (!p) {
    p = authProbe(bin)
      .then((val) => storeAuthProbe(bin, val))
      .finally(() => { if (PENDING.get(bin) === p) PENDING.delete(bin) })
    PENDING.set(bin, p)
  }
  return p
}
async function cachedAuthProbe(bin = 'codex', ttl = TTL) {
  const c = CACHE.get(bin)
  if (c && Date.now() - c.at < ttl) return c.val
  return refreshAuthProbe(bin)
}
// 不等探针的版本(控制台概览用):**立刻**回缓存里的结果;过期了也先给旧值,同时在后台起一次刷新(与上面共用在途表,
// 不会多起进程;出错吞掉)。只有从来没探过时才回 null(= 还不知道,调用方按「未验证」处理)。
// 为什么不等:概览每次重建都要算「可用模型」,冷缓存时等 2s、服务端连不上时等 12s 超时,控制台会像卡死一样;
// 为什么过期也给旧值:否则已知 dead 的 codex 每到过期就会被当成「还不知道」算进能用,概览一闪一闪。
function peekAuthProbe(bin = 'codex', ttl = TTL) {
  const c = CACHE.get(bin)
  if (c && Date.now() - c.at < ttl) return c.val
  refreshAuthProbe(bin).catch(() => {})
  return c ? c.val : null
}
// 让缓存全部过期(控制台额度行 ↻ 的 force 用):下次一定重探,但**不忘掉**已知结果 —— dead 仍受上面「探不到不覆盖」保护,
// peek 在重探完成前也仍给旧值。正在跑的那次探针不受影响(它本来就是「此刻」的数)。
function clearCache() { for (const c of CACHE.values()) c.at = 0 }

// 本地登录文件的离线事实(不联网):登录邮箱 / 套餐 / 上次续期 / access token 到期。
// 只做「补充说明」,不做判据 —— 令牌离到期还有好几天也照样会被服务端吊销;离线只能看出「早过期了还没续上」这一种。
// 路径:$CODEX_HOME/auth.json,否则 ~/.codex/auth.json(与 codex 自己的查找顺序一致)。
function decodeJwt(token) {
  try { return JSON.parse(Buffer.from(String(token).split('.')[1], 'base64url').toString('utf8')) } catch { return null }
}
function decodeAuthJson(obj, now = Date.now()) {
  if (!obj || typeof obj !== 'object') return { exists: false }
  const t = obj.tokens || {}
  const ac = decodeJwt(t.access_token), id = decodeJwt(t.id_token)
  const accessExp = ac && Number.isFinite(ac.exp) ? ac.exp * 1000 : null
  const auth = (id && id['https://api.openai.com/auth']) || {}
  const lastRefresh = obj.last_refresh ? Date.parse(obj.last_refresh) : null
  return {
    exists: true,
    mode: obj.auth_mode || (t.access_token ? 'chatgpt' : (obj.OPENAI_API_KEY ? 'apikey' : '')),
    email: (id && id.email) || '',
    plan: auth.chatgpt_plan_type || '',
    lastRefresh: Number.isFinite(lastRefresh) ? lastRefresh : null,
    accessExp,
    expired: accessExp != null && accessExp <= now,
  }
}
function readAuthFile(home = process.env.CODEX_HOME || path.join(os.homedir(), '.codex')) {
  try { return decodeAuthJson(JSON.parse(fs.readFileSync(path.join(home, 'auth.json'), 'utf8'))) } catch { return { exists: false } }
}

// 三态 → 一行人话(doctor 行 / 控制台卡片共用,措辞单一事实源)。file 可选(readAuthFile 的结果),只用来补细节。
function describeLogin(s, file = null) {
  const who = file && file.exists ? [file.plan, file.email].filter(Boolean).join(' · ') : ''
  if (s && s.verified && s.ok) return { level: 'ok', text: '订阅登录已验证' + (who ? ' · ' + who : '') }
  if (s && s.dead) return { level: 'fail', text: '登录态已失效(服务端拒绝了这台机器的令牌)— 在这台机器上重新跑 codex login' + (who ? ' · ' + who : '') }
  // 原因尾巴:服务端原话里的接口地址去掉再截 60 字 —— 这行会上控制台,用户可见文案不带服务商域名
  const why = s && s.error ? ' — ' + String(s.error).replace(/https?:\/\/\S+/g, '…').slice(0, 60) : ''
  // 文件不在 ≠ 未登录:codex 可配成走系统钥匙串(cli_auth_credentials_store),没探到时只能说「可能」
  if (file && file.exists === false) return { level: 'warn', text: '未验证 — 本机没有登录文件(可能未登录)' + why }
  if (file && file.expired) return { level: 'warn', text: `未验证且令牌已过期(${new Date(file.accessExp).toISOString().slice(0, 10)}),很可能要重新登录${why}` }
  return { level: 'warn', text: '未验证' + why }
}

// model/list 响应 → 精简模型清单(过滤 hidden;efforts 兼容字符串/对象两形)。
// 空/坏返回 → null(上游回退内置预设)。协议 v2,codex 0.144.3 真机验证(2026-07)。
// Fast tier for one model: model/list reports serviceTiers with id 'priority'
// (display name "Fast"; both `/model fast` and config service_tier="fast" are
// normalised to it by the CLI, verified on 0.162 / 0.166) ⇒ [{ id:'fast', desc }],
// desc being the official text ("2x speed, increased usage"). Older servers only
// give the deprecated additionalSpeedTiers ⇒ accepted without a description.
// Other tiers (flex / ultrafast) are not collected: the account cannot use them
// and the CLI silently drops them.
function mapSpeeds(x) {
  const tiers = Array.isArray(x && x.serviceTiers) ? x.serviceTiers : []
  const fast = tiers.find((t) => t && (t.id === 'priority' || t.id === 'fast'))
  if (fast) return [{ id: 'fast', ...(fast.description ? { desc: String(fast.description) } : {}) }]
  if (!tiers.length && Array.isArray(x && x.additionalSpeedTiers) && x.additionalSpeedTiers.includes('fast')) return [{ id: 'fast' }]
  return []
}

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
      ...(mapSpeeds(x).length ? { speeds: mapSpeeds(x) } : {}), // no Fast tier ⇒ no key (list shape unchanged)
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

module.exports = { loginStatus, cachedLoginStatus, clearLoginCache, rateLimits, listModels, parseLoginStatus, mapRateLimits, mapModels, formatUsage, windowLabel, PRESET_MODELS, judgeAuth, authProbe, cachedAuthProbe, peekAuthProbe, clearCache, decodeAuthJson, readAuthFile, describeLogin }
