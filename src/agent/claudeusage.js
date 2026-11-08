// Claude 订阅额度(v0.11.3)—— 控制台 Claude 卡「订阅额度」行 + 群内 /hud 用。
//
// 通道与 cc-hud(operator 自家 statusline 项目)同源,2026-08-03 拍板采用:
//   端点 = `https://api.anthropic.com/api/oauth/usage`(交互式 /usage 面板同一数据源),
//   `Authorization: Bearer <claudeAiOauth.accessToken>` + `anthropic-beta: oauth-2025-04-20`。
//   `limits[]` 三档(本机 2026-08-03 实测):kind=session(5h 窗口)/ weekly_all / weekly_scoped
//   (带 scope.model.display_name,= 顶级模型周窗口,如 Fable);percent 为**已用**百分比。
//
// ⚠ 三条纪律(照 cc-hud 踩通的路,别走样):
//   1. Cloudflare WAF 对 /api/oauth/* 按 **TLS 指纹** 403 —— Node 的 fetch **恒被拒**、curl 放行
//      (与网络环境无关,换机器换代理都一样)。所以这条路只走 curl,native fetch 不再试
//      (那一发必 403 还白占端点的限流计数);`fetchNative` 保留不删 —— 哪天官方放行,
//      回接只是 fetchRaw 里加一行。curl 的 config 走 **stdin**,token 绝不进 argv(ps 可见)、
//      绝不落日志。
//   2. 凭据**只读不刷新**:accessToken 过期就当拿不到(返回 null 显示「未验证」),token 轮换
//      是 Claude Code 自己的事 —— 代刷会跟它抢 refresh token,两边都掉登录。
//   3. 端点又慢又娇:走本机代理的好路也要 1.1~2.7s,限流阈值低(十几分钟十几次就 429 且持续
//      数分钟)。故超时给足 5s(调用方都是异步回复,多等两秒无感)、失败隔一下重试一次、
//      失败**不长缓存**(见 fetchRaw)。
//
// 全程 best-effort:任何一步失败返回 null,调用方不显示额度行,绝不拖垮健康检查/卡片渲染。
// 但**失败要留一行痕**:此前 curl 带 `--fail` 把状态码连同 body 一起吞掉,超时/429/500 在
// 日志里长得一模一样(什么都没有),排查只能靠猜。

const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { execFile, execFileSync } = require('node:child_process')

const USAGE_URL = 'https://api.anthropic.com/api/oauth/usage'
const TIMEOUT_MS = 5000      // curl 预算(纪律 3);native fetch 已不走这条路
const RETRY_WAIT_MS = 1500   // 失败后隔多久重试(一次为限)
const FAIL_TTL_MS = 10_000   // 失败缓存窗口,见 fetchRaw

// ~/.claude/.credentials.json(Windows / Linux)或 macOS Keychain 的 JSON → accessToken。
// 过期 ⇒ null(纪律 2)。纯函数,单测钉住。
function parseCredentials(raw, now = Date.now()) {
  let j = null
  try { j = JSON.parse(String(raw || '')) } catch { return null }
  const o = j && j.claudeAiOauth
  if (!o || typeof o.accessToken !== 'string' || !o.accessToken) return null
  if (typeof o.expiresAt === 'number' && o.expiresAt <= now) return null
  return o.accessToken
}

function readAccessToken(home = os.homedir()) {
  // 凭据文件优先(win/linux;存在即终局 —— 文件过期意味着同账号同过期,不再翻 Keychain)
  let raw = null
  try { raw = fs.readFileSync(path.join(home, '.claude', '.credentials.json'), 'utf8') } catch { /* 无文件 */ }
  if (raw !== null) return parseCredentials(raw)
  if (process.platform === 'darwin') {
    try {
      const out = execFileSync('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'],
        { encoding: 'utf8', timeout: 1500, stdio: ['ignore', 'pipe', 'ignore'] })
      return parseCredentials(out)
    } catch { /* 无条目 / 拒绝访问 */ }
  }
  return null
}

// limits[] → [{kind, percent(已用), resetsAt(ms|null), scopeName}]。防御式:形状不对给 []。
function parseLimits(data) {
  const arr = data && Array.isArray(data.limits) ? data.limits : []
  const out = []
  for (const l of arr) {
    if (!l || typeof l.kind !== 'string' || typeof l.percent !== 'number') continue
    const t = Date.parse(l.resets_at || '')
    out.push({
      kind: l.kind,
      percent: l.percent,
      resetsAt: Number.isFinite(t) ? t : null,
      scopeName: (l.scope && l.scope.model && typeof l.scope.model.display_name === 'string') ? l.scope.model.display_name : '',
    })
  }
  return out
}

// 紧凑一行(v0.11.8 口径改版,operator 拍板):`5h:98% (1.8h) │ 7d:12% (6.1d) │ Fable:12%`
// ⚠ **百分比是「已用」不是「剩余」** —— 与 v0.11.3~0.11.7 的「剩 x%」正好相反,四处落点
// (本函数 / console 的 codex 卡 / usage.js 的 minimax 行 / 群内 /hud)必须同版改齐,
// 否则同屏两种口径,「98%」会被读成还剩很多。窗口名前缀 + 括号内距重置,不留裸百分比。
// 分隔符 │(U+2502),两侧空格。
// 一位小数的紧凑时长(4.0h ⇒ 4h:整数不留尾零;≥10 直接取整,两位数带小数太挤)
const fmtDurDecimal = (ms) => {
  const trim = (v) => (v < 10 ? String(Number(v.toFixed(1))) : String(Math.round(v)))
  const h = ms / 3600e3
  if (h >= 24) return `${trim(h / 24)}d`
  if (h >= 1) return `${trim(h)}h`
  return `${Math.max(1, Math.round(ms / 60e3))}m`
}
const QUOTA_SEP = ' │ '

function formatClaudeUsage(limits, now = Date.now()) {
  if (!Array.isArray(limits) || !limits.length) return null
  const reset = (l) => (l.resetsAt && l.resetsAt > now && l.resetsAt - now < 9 * 864e5) ? ` (${fmtDurDecimal(l.resetsAt - now)})` : ''
  // 窗口名:session=5h(官方就是 5 小时滚动窗)· weekly_all=7d · weekly_scoped=该模型名
  const label = (l) => l.kind === 'session' ? '5h' : l.kind === 'weekly_all' ? '7d' : l.kind === 'weekly_scoped' ? (l.scopeName || '顶级模型') : ''
  const parts = []
  for (const l of limits) {
    const lb = label(l)
    if (!lb) continue // 未知窗口类型不猜(官方加新档时宁缺毋滥)
    parts.push(`${lb}:${Math.min(100, Math.max(0, Math.round(l.percent)))}%${reset(l)}`)
  }
  return parts.join(QUOTA_SEP) || null
}

// ⚠ 当前**不走**这条腿(纪律 1:Node 的 TLS 指纹被 Cloudflare 恒 403)。保留函数是为了
// 哪天官方放行时回接成本近似为零 —— 别因为「没人调」把它删掉。
async function fetchNative(token) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS)
  try {
    const r = await fetch(USAGE_URL, { headers: { Authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20' }, signal: ac.signal })
    if (!r.ok) return null
    return await r.json()
  } catch { return null } finally { clearTimeout(timer) }
}

// curl 收尾判读(纯函数,单测钉死):(err, stdout) → { data, note }。
// stdout 的**最后一行**是 `--write-out` 写的 HTTP 状态码 —— 不再用 `--fail`,它把状态码和 body
// 一起吞了,超时/限流/服务端错在日志里长得一模一样。note = 该记的一行人话(成功给 null,
// 成功不打日志);note 里只放状态码与本地错因,绝不带 token 或响应头。
function readCurlResult(err, stdout) {
  if (err) {
    // 退出码 28 = 取数命令自己的 max-time 到点;killed/SIGTERM = 外层兜底超时掐的
    const exit = typeof err.code === 'number' ? err.code : null
    if (err.killed || err.signal === 'SIGTERM' || exit === 28 || String(err.code || '') === 'ETIMEDOUT')
      return { data: null, note: `额度接口超时(${TIMEOUT_MS}ms 未返回)` }
    const why = exit != null ? `退出码 ${exit}` : String((err.message || '').split('\n')[0] || '未知错误').slice(0, 120)
    return { data: null, note: `额度接口调用失败(${why})` }
  }
  const raw = String(stdout == null ? '' : stdout)
  const cut = raw.lastIndexOf('\n')
  const status = Number((cut >= 0 ? raw.slice(cut + 1) : raw).trim())
  const body = cut >= 0 ? raw.slice(0, cut) : ''
  if (!Number.isFinite(status) || !status) return { data: null, note: '额度接口没给出状态码(响应形状不认识)' }
  if (status === 429) return { data: null, note: '额度接口限流(429),等一会儿才会恢复' }
  if (status !== 200) return { data: null, note: `额度接口返回 ${status}` }
  try { return { data: JSON.parse(body), note: null } } catch { return { data: null, note: '额度接口返回的不是 JSON(解析失败)' } }
}

const warn = (m) => { try { process.stderr.write('· ' + m + '\n') } catch { /* stderr 关了也不能崩 */ } }

// 唯一的取数腿:config 经 stdin(token 不进 argv);token 字符集先校验,防 config 注入。
function fetchCurl(token, { log = warn, exec = execFile } = {}) {
  if (!/^[\w.\-~+/=]+$/.test(token)) return Promise.resolve(null)
  return new Promise((resolve) => {
    try {
      const child = exec('curl', ['--config', '-'], { timeout: TIMEOUT_MS + 1000, windowsHide: true }, (err, stdout) => {
        const { data, note } = readCurlResult(err, stdout)
        if (note) log(note)
        resolve(data)
      })
      child.stdin.on('error', () => { /* curl 可能在 stdin 写完前退出 */ })
      child.stdin.end([
        `url = "${USAGE_URL}"`,
        `header = "Authorization: Bearer ${token}"`,
        'header = "anthropic-beta: oauth-2025-04-20"',
        'silent', `max-time = ${Math.ceil(TIMEOUT_MS / 1000)}`,
        'write-out = "\\n%{http_code}"', // 末行状态码:失败要留痕,见 readCurlResult
      ].join('\n'))
    } catch (e) { log('额度接口起不来:' + ((e && e.message) || '未知错误')); resolve(null) }
  })
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms))

// 原始额度 JSON。**缓存与 usageLine 共用同一份** —— 额度告警每轮结算都会问一次,不共用
// 就是每轮多打一次接口(v0.11.8 新增,给 quotaalert 判定用)。
// ⚠ **只有成功才缓存 60s;失败只压 10 秒**:失败也缓存一分钟,等于一次偶发超时就让整整一分钟
// 里所有人都查不到额度(而这接口恰恰偶发超时/限流);完全不压又让连点几下就把限流捅穿。
// 10 秒 = 人再问一次就真的重试,机器连点仍被挡住。
const RAW = { at: 0, data: null }
async function fetchRaw(token, { ttl = 60_000, now = Date.now, log = warn, curl = fetchCurl, sleep = sleepMs } = {}) {
  if (RAW.at && now() - RAW.at < (RAW.data ? ttl : FAIL_TTL_MS)) return RAW.data
  // 只走 curl(纪律 1);失败隔一下再问一次 —— 超时与短限流重试一次往往就通,再不通就认了。
  let data = await curl(token, { log })
  if (!data) { await sleep(RETRY_WAIT_MS); data = await curl(token, { log }) }
  RAW.at = now(); RAW.data = data
  return data
}

// 拉一次 → 一行人话;拿不到 null。走 fetchRaw ⇒ 与告警共享那份缓存。
// 缓存口径与 fetchRaw 一致:成功 60s、失败 10s(两层都压死一分钟就白搭下层的重试了)。
const CACHE = { at: 0, val: null }
const TTL = 60_000
async function usageLine({ ttl = TTL, now = Date.now, readToken = readAccessToken, ...io } = {}) {
  if (CACHE.at && now() - CACHE.at < (CACHE.val ? ttl : FAIL_TTL_MS)) return CACHE.val
  let val = null
  const token = readToken()
  if (token) {
    const data = await fetchRaw(token, { ttl, now, ...io })
    val = formatClaudeUsage(parseLimits(data), now())
  }
  CACHE.at = now(); CACHE.val = val
  return val
}
function clearCache() { CACHE.at = 0; CACHE.val = null; RAW.at = 0; RAW.data = null }

module.exports = { usageLine, fetchRaw, clearCache, parseCredentials, parseLimits, formatClaudeUsage, readAccessToken, fetchCurl, fetchNative, readCurlResult, fmtDurDecimal, QUOTA_SEP, TIMEOUT_MS, FAIL_TTL_MS, RETRY_WAIT_MS }
