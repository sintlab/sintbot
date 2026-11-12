'use strict'

// Per-provider account balance / plan usage — the numbers cc-hud surfaces, for
// the console. Server-side (keys never reach the browser), best-effort, cached
// 5 min. The host only moves bytes: which endpoint, which headers, how to render.
// **Every response body is judged by the binary core** (`usage_parse`, ABI 36):
// HTTP status + body → windows / balance / one of five error kinds. The host never
// re-reads a provider's JSON shape, so one rule set serves the console, /hud and
// the quota alert alike.
//
// Common rules (2026-11-12, cc-switch takeaways B1):
//   · 15 s per request · real HTTP status goes to the core (network error ⇒ null)
//   · `credentials` ⇒ the card shows「凭据失效」instead of going blank
//   · `transient`   ⇒ keep the last good value of that provider for 10 min
//   · `malformed` / `none` ⇒ null (nothing to show)
//   · never log a response body or a key; the last-good cache is keyed by a key hash

const crypto = require('node:crypto')
const { usageParse } = require('./agent/privatecore')

const CACHE = new Map() // provider name -> { val, ts }
const TTL = 5 * 60 * 1000
const REQUEST_TIMEOUT_MS = 15_000
const LAST_GOOD_TTL_MS = 10 * 60 * 1000
const LAST_GOOD = new Map() // kind|baseUrl|sha256(key)[:16] -> { val, ts }

const CREDENTIALS_VALUE = Object.freeze({ label: '额度', value: '凭据失效' })

// One request → { status, body }. Network error / timeout ⇒ status null (the core
// files it under `transient`). Non-JSON bodies travel as text so the core can still
// say `malformed`. The body is handed to the core and dropped — never logged.
async function request(url, headers, { fetchImpl = globalThis.fetch, timeoutMs = REQUEST_TIMEOUT_MS } = {}) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), timeoutMs)
  try {
    const r = await fetchImpl(url, { headers, signal: ac.signal })
    const text = await r.text()
    let body = text
    try { body = JSON.parse(text) } catch { /* 非 JSON:原文交给核心判 malformed */ }
    return { status: r.status, body }
  } catch { return { status: null, body: null } } finally { clearTimeout(timer) }
}

// baseUrl → 哪一家的余额接口(null = 这家根本没有公开余额接口,如火山 coding plan)。
// 抽出来是为了「能不能查」与「怎么查」共用同一份判定 —— 两处各写一份必然漂移,而漂移的
// 后果正是群里那句错话:明明这家没接口,却说成「暂时没查到,稍后再试」让人白等。
const balanceKind = (base = '') =>
  base.includes('deepseek') ? 'deepseek'
    : (base.includes('bigmodel.cn') || base.includes('api.z.ai')) ? 'glm'
      : base.includes('minimax') ? 'minimax'
        : null

// 核心的 windows[] → 与 Claude 订阅额度同一种一行:`5h:42% │ 7d:10% (5d)`。
// 复用 claudeusage.formatClaudeUsage,窗口名映射:session=5h · weekly=7d · weekly_scoped=模型名。
function formatWindows(windows, now = Date.now()) {
  const { formatClaudeUsage } = require('./agent/claudeusage')
  const limits = (Array.isArray(windows) ? windows : []).map((w) => ({
    kind: w.kind === 'weekly' ? 'weekly_all' : w.kind,
    percent: w.percentUsed,
    resetsAt: w.resetsAt,
    scopeName: w.scopeName || '',
  }))
  return formatClaudeUsage(limits, now)
}

const CURRENCY_SIGN = { CNY: '¥', RMB: '¥', USD: '$' }
function formatBalance(balance) {
  if (!balance || typeof balance.amount !== 'number' || !Number.isFinite(balance.amount)) return null
  const sign = CURRENCY_SIGN[String(balance.currency || '').toUpperCase()]
  return sign ? `${sign}${balance.amount.toFixed(2)}` : `${balance.amount.toFixed(2)} ${balance.currency || ''}`.trim()
}

// 核心的成功结果 → 卡片一行;窗口优先(额度),否则余额;两者皆无 ⇒ null。
function render(parsed, now) {
  const windows = formatWindows(parsed.windows, now)
  if (windows) return { label: '额度', value: windows }
  const balance = formatBalance(parsed.balance)
  if (balance) return { label: '余额', value: balance }
  return null
}

// 每家的取数顺序。返回核心的 usage_parse 结果(成功或失败),不在这里解释。
async function probeGlm(base, key, io) {
  const host = base.includes('api.z.ai') ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
  const now = io.now()
  // coding plan 配额(5 小时 / 周窗口)。鉴权头不带 Bearer(智谱监控接口的口径)。
  const quota = await request(`${host}/api/monitor/usage/quota/limit`,
    { Authorization: key, 'Accept-Language': 'en-US,en' }, io)
  const q = usageParse('glm', 'quota', quota.status, quota.body, now)
  if (q.ok || (q.error !== 'noplan' && q.error !== 'credentials' && q.error !== 'transient')) return q
  // 没有 coding plan ⇒ 按量付费账户,退回余额;配额接口拒绝/抖动时也问一次余额 —— 两个接口
  // 鉴权口径未必相同,只有**两边都**说凭据不对才显示「凭据失效」;任一边抖动按瞬时算(保上次好值)。
  const bal = await request(`${host}/api/biz/account/query-customer-account-report`, { Authorization: `Bearer ${key}` }, io)
  const b = usageParse('glm', 'balance', bal.status, bal.body, io.now())
  if (b.ok) return b
  if (q.error === 'credentials' && b.error === 'credentials') return q
  if (q.error === 'transient' || b.error === 'transient') return { ok: false, error: 'transient', detail: 'glm quota/balance transient' }
  return b.error === 'credentials' ? { ok: false, error: 'malformed', detail: 'glm balance credentials without quota agreement' } : b
}

async function probeMinimax(base, key, io) {
  const host = base.includes('minimaxi.com') ? 'https://api.minimaxi.com' : 'https://api.minimax.io'
  const headers = { Authorization: `Bearer ${key}` }
  const plan = await request(`${host}/v1/api/openplatform/coding_plan/remains`, headers, io)
  const p = usageParse('minimax', 'quota', plan.status, plan.body, io.now())
  if (p.ok || (p.error !== 'malformed' && p.error !== 'none')) return p
  // 旧接口(Token Plan):形状相同,只在新接口认不得时退回
  const legacy = await request(`${host}/v1/token_plan/remains`, headers, io)
  return usageParse('minimax', 'quota', legacy.status, legacy.body, io.now())
}

async function probeDeepseek(_base, key, io) {
  const r = await request('https://api.deepseek.com/user/balance', { Authorization: `Bearer ${key}` }, io)
  return usageParse('deepseek', 'balance', r.status, r.body, io.now())
}

const PROBES = { glm: probeGlm, minimax: probeMinimax, deepseek: probeDeepseek }

const keyHash = (key) => crypto.createHash('sha256').update(String(key)).digest('hex').slice(0, 16)

// 单个 provider → { label, value } | null。`io`:bin(cfg.agent.bin,登录态 claude 的兜底要用)
// 与可测注入(fetchImpl / now / timeoutMs)。
async function providerUsage(provider, io = {}) {
  const key = provider.apiKey
  const base = provider.baseUrl || ''
  // Claude 订阅登录形态(无 baseUrl、非 codex):额度走 oauth/usage(cc-hud 同源通道,
  // v0.11.3;凭据取本机 Claude Code 登录态,拿不到/未登录 ⇒ 走 claudeusage 的兜底,仍可能 null)。
  if (!base && provider.runner !== 'codex') {
    const v = await require('./agent/claudeusage').usageLine(io.bin ? { bin: io.bin } : {})
    return v ? { label: '订阅额度', value: v } : null
  }
  if (!key) return null

  const kind = balanceKind(base)
  const probe = PROBES[kind]
  if (!probe) return null // volcano / claude: no public balance API
  const now = typeof io.now === 'function' ? io.now : Date.now
  const ctx = { fetchImpl: io.fetchImpl || globalThis.fetch, timeoutMs: io.timeoutMs || REQUEST_TIMEOUT_MS, now }
  const goodKey = `${kind}|${base}|${keyHash(key)}`

  const parsed = await probe(base, key, ctx)
  if (parsed.ok) {
    const v = render(parsed, now())
    if (v) LAST_GOOD.set(goodKey, { val: v, ts: now() })
    return v
  }
  if (parsed.error === 'credentials') { LAST_GOOD.delete(goodKey); return { ...CREDENTIALS_VALUE } }
  if (parsed.error === 'transient') {
    const last = LAST_GOOD.get(goodKey)
    if (last && now() - last.ts < LAST_GOOD_TTL_MS) return last.val
    LAST_GOOD.delete(goodKey)
  }
  return null // malformed / none / stale transient
}

// 能不能给这个 provider 查额度 —— getUsage 与 refreshUsage 共用的单一判据(两处各写一份
// 必然漂移:手点刷新放行了 hidden,就等于绕开「hidden ⇒ 零探测」)。
//   hidden = operator 主动撤下 ⇒ 不拉(卡片都不显示,拉了白拉;生产机的 claude 标 hidden,
//   不该为它去翻 Keychain)· codex 额度走自家 app-server 通道(codexstatus),不在这 ·
//   第三方缺 key 查不了。剩下 = 第三方有 key / 登录态 claude(无 baseUrl 非 codex),都可查。
const queryable = (p) => !!p && !p.hidden && p.runner !== 'codex' && !(p.baseUrl && !p.apiKey)

// 登录态 claude(无 baseUrl、非 codex)—— 它的额度走 claudeusage 那条通道,自带 60s TTL。
const isClaudeLogin = (p) => !!p && !p.baseUrl && p.runner !== 'codex'

// 这个模型形态**本来**有没有额度可查(与 providerUsage 的分支一一对应)。
// queryable 答的是「该不该去探」(撤下的、缺 key 的、走自家通道的都别探);这里答的是
// 「探了本该有没有数」—— 两者不是一回事:火山这类第三方 key 齐全该探,但它没有公开余额接口,
// 查不到是**结构性**的,不是网络抖动。分不开这两件事,群里就只能把偶发失败也说成「不支持」。
//
// ⚠ **不看 hidden**(2026-08-11 修回归):hidden 只是「控制台的模型页别列它」这一条收纳口径,
// 群照样在用它 —— 生产机的 claude 正是 hidden。把 queryable 的 !hidden 混进来,群里 /hud 就会
// 对着一个天天在跑的模型说「不支持查额度」,而它明明查得到。缺 key 仍算「不支持」(旧行为)。
const hasUsageApi = (p) => !!p && p.runner !== 'codex' && !(p.baseUrl && !p.apiKey)
  && (isClaudeLogin(p) || !!balanceKind(p.baseUrl || ''))

// Fetch balances for all keyed providers (resolved apiKey). Returns { name: {label,value} }.
async function getUsage(providers = {}, { bin } = {}) {
  const out = {}
  await Promise.all(Object.entries(providers).map(async ([name, p]) => {
    if (!queryable(p)) return
    const c = CACHE.get(name)
    if (c && Date.now() - c.ts < TTL) { out[name] = c.val; return }
    const v = await providerUsage(p, bin ? { bin } : {})
    if (v) { CACHE.set(name, { val: v, ts: Date.now() }); out[name] = v }
    else if (c) out[name] = c.val // stale fallback
  }))
  return out
}

// 单个 provider 强制刷新(控制台额度行的「↻」)。**点按钮 = 要此刻的数**,所以两层缓存都得绕:
// 本模块的 5 分钟 CACHE,以及登录态 claude 那条通道自己的 60s TTL(与 /api/claude/verify 同口径)。
// ⚠ 拉不到时把上一次的值留在缓存里 —— 手点刷新失败不该让卡片上原本显示着的额度行凭空消失
// (旧 ts 保留 ⇒ 它照样算过期,下一次 getUsage 仍会重拉)。probe/now 注入是为了可单测。
async function refreshUsage(name, provider, { probe = providerUsage, now = Date.now, bin } = {}) {
  if (!queryable(provider)) { CACHE.delete(name); return null }
  const prev = CACHE.get(name)
  CACHE.delete(name)
  if (isClaudeLogin(provider)) { try { require('./agent/claudeusage').clearCache() } catch { /* best-effort */ } }
  const v = await probe(provider, bin ? { bin } : {}).catch(() => null)
  if (v) CACHE.set(name, { val: v, ts: now() })
  else if (prev) CACHE.set(name, prev)
  return v
}

// /hud 的额度探针(daemon 注入给 engine —— core 不认具体 runner)。放这儿而不是内联在
// 启动流程里,是为了它能被单测钉住:这层的两个判断都出过事。
//
// 返回 **{ supported, value }**,两件事分开答:
//   supported = 这个模型形态本来能不能查(codex 走自家订阅通道 · 登录态 claude 与有余额接口的
//               第三方走 providerUsage);value = 此刻真查到的串,查不到给 null。
//   ⚠ 合成一个 null 就是本案的根因:群里于是把「接口超时/限流」一律说成「模型不支持查额度」,
//     而这两句话给群成员的下一步完全相反(一个别再问,一个过会儿再问)。
// 缓存:**成功压 60s,失败只压 10s**(与 claudeusage 同口径)—— 失败也压一分钟,等于一次
// 偶发超时让整整一分钟查不到;完全不压又让连点 /hud 直捅端点限流。
// `bin` = cfg.agent.bin:登录态 claude 的额度兜底要起它(见 claudeusage),不传就是 PATH 上的 claude。
function createUsageProbe({ codexUsage = async () => null, probe = providerUsage, ttl = 60_000, failTtl = 10_000, now = Date.now, bin } = {}) {
  const cache = new Map() // provider name + '|' + baseUrl -> { v, ts }
  return async (name, provider) => {
    const isCodex = !!provider && provider.runner === 'codex'
    if (!isCodex && !hasUsageApi(provider)) return { supported: false, value: null }
    // 缓存键带上 baseUrl:控制台热改端点(deepseek → minimax)后名字没变,只按名字缓存会让
    // 接下来 60 秒把上一家的余额当成这一家的报出去 —— 换了端点就是换了账,不许串味。
    const key = name + '|' + ((provider && provider.baseUrl) || '')
    const c = cache.get(key)
    if (c && now() - c.ts < (c.v ? ttl : failTtl)) return { supported: true, value: c.v }
    let v = null
    try {
      if (isCodex) v = await codexUsage(provider)
      else { const u = await probe(provider, bin ? { bin } : {}); v = u ? `${u.label} ${u.value}` : null }
    } catch { v = null }
    cache.set(key, { v: v || null, ts: now() })
    return { supported: true, value: v || null }
  }
}

module.exports = { getUsage, providerUsage, refreshUsage, queryable, hasUsageApi, createUsageProbe, REQUEST_TIMEOUT_MS, LAST_GOOD_TTL_MS }
