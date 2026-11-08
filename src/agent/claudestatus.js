// Claude 订阅登录态探测 —— 控制台 Claude 模型卡 + doctor 用。
//
// `claude auth status --json` 是**官方的非交互子命令**(0.2s、不联网收费、不吃订阅额度),
// 返回 {loggedIn, authMethod, apiProvider, email, orgId, orgName, subscriptionType}。
// 它是 Claude 这侧对应 `codex login status` 的那件东西 —— 在它之前,sbot 只能按
// 「没填 baseUrl 就当成登录态」猜(卡片写「登录态·未验证」、doctor 写「Claude 登录态(未验证)」),
// 真没登录时一样显示正常,要到群里跑一轮才炸。
//
// 一律 best-effort:失败不抛,调用方显示「未验证」而不是把整块健康检查拖垮。

const { spawn } = require('node:child_process')
const { resolveSpawn } = require('./winexec')

// `claude auth status --json` 的 stdout → 归一化结果。纯函数,便于单测钉住字段映射。
// 老版本 CLI 没有这个子命令(stderr 报 unknown command / 非 0 退出)⇒ ok:false,
// 调用方据此显示「未验证」,**不能**当成「未登录」—— 二者要分开,同飞书应用描述那条教训。
function parseAuthStatus(stdout, code) {
  const text = String(stdout || '').trim()
  let j = null
  try { j = JSON.parse(text) } catch { /* 非 JSON:老版本或报错文本 */ }
  if (!j || typeof j !== 'object') {
    return { ok: false, error: text.slice(0, 200) || `exit ${code}`, loggedIn: false }
  }
  return {
    ok: true,
    loggedIn: !!j.loggedIn,
    plan: j.subscriptionType || '',      // max / pro / team …(未订阅时为空)
    email: j.email || '',
    org: j.orgName || '',
    method: j.authMethod || '',          // claude.ai = 订阅登录
    apiProvider: j.apiProvider || '',    // firstParty / bedrock / vertex
  }
}

function loginStatus(bin = 'claude', timeoutMs = 8000) {
  return new Promise((resolve) => {
    const { file, spawnArgs } = resolveSpawn(bin, ['auth', 'status', '--json'])
    let out = '', err = '', settled = false
    const done = (v) => { if (settled) return; settled = true; clearTimeout(timer); resolve(v) }
    let child
    try { child = spawn(file, spawnArgs, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }) }
    catch (e) { return resolve({ ok: false, error: e.message, loggedIn: false }) }
    const timer = setTimeout(() => { try { child.kill() } catch {} done({ ok: false, error: 'timeout', loggedIn: false }) }, timeoutMs)
    child.stdout.on('data', (c) => { out += c.toString('utf8') })
    child.stderr.on('data', (c) => { err += c.toString('utf8') })
    child.on('error', (e) => done({ ok: false, loggedIn: false, error: e.code === 'ENOENT' ? "'claude' 不在 PATH 上" : e.message }))
    child.on('close', (code) => done(parseAuthStatus(out || err, code)))
  })
}

// TTL 缓存:doctor 是一次性的,但控制台 /api/state 每次动作 + 60s 自动刷新都会重建健康行,
// 每次都 spawn 一个进程没必要。登录态分钟级变化足够,取 60s。
const CACHE = new Map() // bin -> { at, val }
const TTL = 60_000
async function cachedLoginStatus(bin = 'claude', ttl = TTL) {
  const c = CACHE.get(bin)
  if (c && Date.now() - c.at < ttl) return c.val
  const val = await loginStatus(bin)
  CACHE.set(bin, { at: Date.now(), val })
  return val
}
function clearCache() { CACHE.clear() } // 「重新检测」按钮:绕过 TTL

// 登录态 → 一行人话(卡片 chip / doctor 详情共用,措辞单一事实源)。
function describeLogin(s) {
  if (!s || !s.ok) return { level: 'warn', text: '未验证' + (s && s.error ? ' — ' + String(s.error).slice(0, 60) : '') }
  if (!s.loggedIn) return { level: 'fail', text: '未登录 — 在这台机器上跑 claude auth login' }
  const bits = ['订阅登录']
  if (s.plan) bits.push(s.plan)          // max / pro
  if (s.email) bits.push(s.email)
  return { level: 'ok', text: bits.join(' · ') }
}

module.exports = { loginStatus, cachedLoginStatus, clearCache, parseAuthStatus, describeLogin }
