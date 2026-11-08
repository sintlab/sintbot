// Per-provider account balance / plan usage — the numbers cc-hud surfaces, for
// the console. Server-side (keys never reach the browser), best-effort, cached
// 5 min, 2.5s timeout. Endpoints mirror cc-hud (deepseek / glm / minimax); other
// providers (volcano coding-plan, Claude) have no public balance API → skipped.

const CACHE = new Map() // provider name -> { val, ts }
const TTL = 5 * 60 * 1000

async function fetchJson(url, key, ms = 2500) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), ms)
  try {
    const r = await fetch(url, { headers: { Authorization: `Bearer ${key}` }, signal: ac.signal })
    if (!r.ok) return null
    return await r.json()
  } catch { return null } finally { clearTimeout(timer) }
}

// baseUrl → 哪一家的余额接口(null = 这家根本没有公开余额接口,如火山 coding plan)。
// 抽出来是为了「能不能查」与「怎么查」共用同一份判定 —— 两处各写一份必然漂移,而漂移的
// 后果正是群里那句错话:明明这家没接口,却说成「暂时没查到,稍后再试」让人白等。
const balanceKind = (base = '') =>
  base.includes('deepseek') ? 'deepseek'
    : (base.includes('bigmodel.cn') || base.includes('api.z.ai')) ? 'glm'
      : base.includes('minimax') ? 'minimax'
        : null

async function providerUsage(provider) {
  const key = provider.apiKey
  const base = provider.baseUrl || ''
  // Claude 订阅登录形态(无 baseUrl、非 codex):额度走 oauth/usage(cc-hud 同源通道,
  // v0.11.3;凭据取本机 Claude Code 登录态,拿不到/未登录 ⇒ null 不显示)。
  if (!base && provider.runner !== 'codex') {
    const v = await require('./agent/claudeusage').usageLine()
    return v ? { label: '订阅额度', value: v } : null
  }
  if (!key) return null

  const kind = balanceKind(base)
  if (kind === 'deepseek') {
    const d = await fetchJson('https://api.deepseek.com/user/balance', key)
    const t = d && d.balance_infos && d.balance_infos[0] && d.balance_infos[0].total_balance
    return t ? { label: '余额', value: `¥${t}` } : null
  }
  if (kind === 'glm') {
    const host = base.includes('api.z.ai') ? 'https://api.z.ai' : 'https://open.bigmodel.cn'
    const d = await fetchJson(`${host}/api/biz/account/query-customer-account-report`, key)
    if (d && d.code && d.code !== 200) return null
    const inner = (d && d.data) || d || {}
    const v = inner.balance != null ? inner.balance : inner.total_balance != null ? inner.total_balance : inner.amount
    if (v == null) return null
    return { label: '余额', value: typeof v === 'number' ? `¥${v.toFixed(2)}` : `¥${String(v).replace(/^¥/, '')}` }
  }
  if (kind === 'minimax') {
    const host = base.includes('minimaxi.com') ? 'https://api.minimaxi.com' : 'https://api.minimax.io'
    const d = await fetchJson(`${host}/v1/token_plan/remains`, key)
    const m = d && d.model_remains && (d.model_remains.find((x) => x.current_interval_status === 1) || d.model_remains[0])
    if (!m) return null
    return { label: '额度', value: `5h:${Math.min(100, Math.max(0, Math.round(100 - m.current_interval_remaining_percent)))}%` } // 口径统一为「已用」(v0.11.8);接口给的是剩余 ⇒ 换算
  }
  return null // volcano / claude: no public balance API
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
async function getUsage(providers = {}) {
  const out = {}
  await Promise.all(Object.entries(providers).map(async ([name, p]) => {
    if (!queryable(p)) return
    const c = CACHE.get(name)
    if (c && Date.now() - c.ts < TTL) { out[name] = c.val; return }
    const v = await providerUsage(p)
    if (v) { CACHE.set(name, { val: v, ts: Date.now() }); out[name] = v }
    else if (c) out[name] = c.val // stale fallback
  }))
  return out
}

// 单个 provider 强制刷新(控制台额度行的「↻」)。**点按钮 = 要此刻的数**,所以两层缓存都得绕:
// 本模块的 5 分钟 CACHE,以及登录态 claude 那条通道自己的 60s TTL(与 /api/claude/verify 同口径)。
// ⚠ 拉不到时把上一次的值留在缓存里 —— 手点刷新失败不该让卡片上原本显示着的额度行凭空消失
// (旧 ts 保留 ⇒ 它照样算过期,下一次 getUsage 仍会重拉)。probe/now 注入是为了可单测。
async function refreshUsage(name, provider, { probe = providerUsage, now = Date.now } = {}) {
  if (!queryable(provider)) { CACHE.delete(name); return null }
  const prev = CACHE.get(name)
  CACHE.delete(name)
  if (isClaudeLogin(provider)) { try { require('./agent/claudeusage').clearCache() } catch { /* best-effort */ } }
  const v = await probe(provider).catch(() => null)
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
function createUsageProbe({ codexUsage = async () => null, probe = providerUsage, ttl = 60_000, failTtl = 10_000, now = Date.now } = {}) {
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
      else { const u = await probe(provider); v = u ? `${u.label} ${u.value}` : null }
    } catch { v = null }
    cache.set(key, { v: v || null, ts: now() })
    return { supported: true, value: v || null }
  }
}

module.exports = { getUsage, providerUsage, refreshUsage, queryable, hasUsageApi, createUsageProbe }
