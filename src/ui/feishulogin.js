'use strict'
// 控制台「用飞书登录」—— 标准 OAuth 2.0 授权码流程的纯逻辑(可测,不碰 http 服务)。
//
// 流程:登录页按钮 → GET /api/auth/feishu/start(签发一次性 state,302 到飞书授权页)
//       → 飞书回调 GET /api/auth/feishu/callback?code&state(校验 state → 换 access_token
//       → 取 open_id → 对照管理员名单 → 签发控制台会话 → 回一页 HTML 把令牌写进浏览器再跳回首页)。
//
// 只放行配置里管理员名单(feishu.admins[].openId)里的人 —— 名单本来就是「谁能替这台机器说话」,
// 登录复用同一份名单,不另起一套账号。open_id 按应用算,两台机器各自的应用各自的名单,天然分开。
//
// ⚠ 回调地址必须是公网 HTTPS 且在开放平台「安全设置 → 重定向 URL」里预先登记(飞书侧校验),
//    所以入口只在配置了 ui.publicUrl 之后才出现;局域网访问继续用密码登录。
// ⚠ 这里的 HTML 是用户可见文案:零工具名、零机器路径。

const crypto = require('node:crypto')

const AUTHORIZE_URL = 'https://accounts.feishu.cn/open-apis/authen/v1/authorize'
const TOKEN_URL = 'https://accounts.feishu.cn/oauth/v3/token' // v2 已标废弃,文档推荐 v3
const USERINFO_URL = 'https://open.feishu.cn/open-apis/authen/v1/user_info'
const CALLBACK_PATH = '/api/auth/feishu/callback'
const START_PATH = '/api/auth/feishu/start'
const FETCH_TIMEOUT_MS = 10_000

// 公网地址只认 https://host[:port],其余(路径 / 查询 / http / 空)一律不认 —— 回调地址由它拼出来,
// 拼错一段飞书就会报「重定向 URL 不匹配」,与其让人猜不如在存的时候就挡住。
function normalizePublicUrl(s) {
  const t = String(s || '').trim()
  if (!t) return null
  let u
  try { u = new URL(t) } catch { return null }
  if (u.protocol !== 'https:') return null
  if (!u.hostname) return null
  if (u.username || u.password) return null
  return `https://${u.host}` // host 含端口(非默认时)
}

const redirectUri = (publicUrl) => `${publicUrl}${CALLBACK_PATH}`

function buildAuthorizeUrl({ appId, redirectUri: ru, state }) {
  const q = new URLSearchParams({ client_id: appId, redirect_uri: ru, response_type: 'code', state })
  return `${AUTHORIZE_URL}?${q.toString()}`
}

// 一次性 state:防 CSRF(回调必须带我们签发过的 state,且只能用一次)。带 TTL 与上限,
// 免得有人狂刷 /start 把内存撑爆 —— 满了就淘汰最早的。
// ⚠ 上限不能太小:淘汰最早的 = 攻击者在别人「点按钮 → 授权 → 回调」那十几秒里刷满,就把别人的 state
//    挤掉、登录恒失败(对抗审查 🟡)。一条 state 约 60 字节,一万条不到 1MB,门槛抬 50 倍。
function createStateStore({ ttlMs = 10 * 60_000, max = 10_000, now = Date.now, random = () => crypto.randomBytes(16).toString('hex') } = {}) {
  const pending = new Map() // state -> issuedAt
  const prune = () => { const t = now(); for (const [k, at] of pending) if (t - at > ttlMs) pending.delete(k) }
  return {
    issue() {
      prune()
      while (pending.size >= max) pending.delete(pending.keys().next().value)
      const s = random(); pending.set(s, now()); return s
    },
    consume(state) {
      prune()
      if (!state || !pending.has(state)) return false
      pending.delete(state); return true
    },
    get size() { prune(); return pending.size },
  }
}

// 网络层的错都翻成人话:超时 / 连不上 各一句,别把英文 AbortError 直接摆到登录失败页上。
async function fetchJson(fetchImpl, url, init) {
  const ac = new AbortController()
  const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS)
  try {
    let r
    try { r = await fetchImpl(url, { ...init, signal: ac.signal }) } catch (e) {
      throw new Error(e && e.name === 'AbortError' ? `连接飞书超时(${FETCH_TIMEOUT_MS / 1000} 秒)` : `连不上飞书:${(e && e.message) || e}`)
    }
    let j = null
    try { j = await r.json() } catch { j = null }
    return { status: r.status, json: j }
  } finally { clearTimeout(timer) }
}

// 授权码 → user_access_token。成功形状 {code:0, access_token, ...};失败 {code:2xxxx, error, error_description}。
async function exchangeCode({ fetchImpl = globalThis.fetch, appId, appSecret, code, redirectUri: ru }) {
  const { status, json } = await fetchJson(fetchImpl, TOKEN_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ grant_type: 'authorization_code', client_id: appId, client_secret: appSecret, code, redirect_uri: ru }),
  })
  if (!json || typeof json !== 'object') throw new Error(`飞书没有返回有效响应(HTTP ${status})`)
  if (json.code !== 0 || !json.access_token) {
    const why = json.error_description || json.error || json.msg || `code ${json.code}`
    throw new Error(`飞书拒绝了这次授权:${why}`)
  }
  return { accessToken: String(json.access_token) }
}

// user_access_token → 这个人在本应用下的 open_id 与姓名(不需要额外 scope)。
async function fetchUserInfo({ fetchImpl = globalThis.fetch, accessToken }) {
  const { status, json } = await fetchJson(fetchImpl, USERINFO_URL, { method: 'GET', headers: { Authorization: `Bearer ${accessToken}` } })
  const d = json && json.data
  if (!json || json.code !== 0 || !d || !d.open_id) throw new Error(`取不到飞书身份(HTTP ${status}${json && json.msg ? ' · ' + json.msg : ''})`)
  return { openId: String(d.open_id), name: String(d.name || d.en_name || ''), unionId: d.union_id ? String(d.union_id) : '' }
}

// 名单匹配:精确、区分大小写(open_id 是不透明标识符,不做任何「宽容」)。
function adminMatch(admins, openId) {
  if (!openId || !Array.isArray(admins)) return null
  return admins.find((a) => a && a.openId === openId) || null
}

const escHtml = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]))

// 回调落地页:成功 → 把令牌写进浏览器存储再回首页;失败 → 说人话并给回登录页的链接。
// 令牌只经这页的脚本落地,不进 URL、不进日志。样式跟随系统深浅色,不依赖控制台的 CSS。
function loginResultHtml({ ok, token = '', name = '', message = '' }) {
  const tok = /^[0-9a-f]{16,128}$/.test(String(token)) ? String(token) : ''
  const body = ok && tok
    ? `<p class="t">登录成功${name ? ',' + escHtml(name) : ''}</p><p class="s">正在进入控制台…</p>
<script>try{localStorage.setItem('sbot-token','${tok}');sessionStorage.setItem('sbot-token','${tok}')}catch(e){}location.replace('/')</script>`
    : `<p class="t">没能登录</p><p class="s">${escHtml(message || '未知原因')}</p><p class="s"><a href="/">回到登录页</a></p>`
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>SintBot 控制台</title>
<style>:root{color-scheme:light dark}body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;font:14px/1.6 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;background:#f6f6f7;color:#1c1c1e}@media(prefers-color-scheme:dark){body{background:#1e1e2e;color:#cdd6f4}}main{padding:28px 32px;border-radius:14px;background:rgba(127,127,127,.08);text-align:center}.t{font-size:16px;font-weight:600;margin:0 0 6px}.s{margin:0;opacity:.75}a{color:inherit}</style></head><body><main>${body}</main></body></html>`
}

// 入口能不能亮:三样都齐才亮(缺一样就在设置页说清缺哪样,登录页不出按钮)。
function feishuLoginReadiness({ publicUrl, appId, appSecret, admins }) {
  if (!normalizePublicUrl(publicUrl)) return { ready: false, why: '未填公网地址' }
  if (!appId || !appSecret) return { ready: false, why: '未配置飞书应用凭证' }
  if (!Array.isArray(admins) || !admins.some((a) => a && a.openId)) return { ready: false, why: '管理员名单为空(只有名单里的人能登录)' }
  return { ready: true, why: '' }
}

module.exports = {
  AUTHORIZE_URL, TOKEN_URL, USERINFO_URL, CALLBACK_PATH, START_PATH,
  normalizePublicUrl, redirectUri, buildAuthorizeUrl, createStateStore,
  exchangeCode, fetchUserInfo, adminMatch, loginResultHtml, feishuLoginReadiness, escHtml,
}
